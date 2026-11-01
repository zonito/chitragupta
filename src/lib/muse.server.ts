/**
 * Shared gateway client — the one module every AI call in Chitragupta
 * goes through (merchant classification and Ask answers). Server-only:
 * it reads API keys from the environment and must never be imported
 * into browser code.
 *
 * Two providers, selected per call from the environment:
 *
 * 1. OpenCode Go (preferred when configured): POST
 *    https://opencode.ai/zen/go/v1/chat/completions (OpenAI-shaped)
 *    with `Authorization: Bearer <OPENCODE_API_KEY>` and the required
 *    `x-opencode-session: chitragupta` header. Zonito's Go subscription
 *    serves the same model (muse-spark-1.3-contributor by default;
 *    OPENCODE_MODEL overrides it), billed to the subscription instead
 *    of pay-as-you-go. The model reasons heavily and reasoning tokens
 *    count against max_tokens — at 200 it spent the whole budget
 *    thinking and returned no content, and ambiguous classification
 *    prompts measured ~1,850 reasoning tokens, right at the edge of a
 *    2000 floor — so this route enforces a floor of 4000 on max_tokens.
 * 2. Meta Model API: POST {base}/v1/messages (Anthropic-Messages
 *    shaped) with `Authorization: Bearer <MUSE_API_KEY>` (there is no
 *    x-api-key header; keys start with "LLM_"). The base defaults to
 *    https://api.meta.ai and the model to muse-spark-1.3-contributor
 *    (Zonito's choice for everything, 30 Oct 2026); MUSE_API_BASE_URL
 *    and MUSE_MODEL override them.
 *
 * OPENCODE_API_KEY takes precedence when both keys are set. With no key
 * configured this module is a strict no-op: museComplete returns null
 * without any network call, and callers fall back to their
 * deterministic behaviour — exactly the pre-gateway no-key path. No key
 * is ever logged, returned or embedded in an error.
 *
 * Diagnostics: every attempted call updates a module-level record of
 * the most recent outcome (which provider served it, HTTP status and a
 * short error excerpt on failure), exposed via lastGatewayStatus() so
 * API responses can say WHY a call failed instead of callers swallowing
 * it. The record never contains a key or any header; failures are also
 * console.error'd server-side.
 */

export interface MuseConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export const DEFAULT_MUSE_BASE_URL = "https://api.meta.ai";
export const DEFAULT_MUSE_MODEL = "muse-spark-1.3-contributor";

/** Meta Model API configuration (MUSE_API_KEY), or null without a key. */
export function museConfig(
  env: NodeJS.ProcessEnv = process.env,
): MuseConfig | null {
  const apiKey = env["MUSE_API_KEY"]?.trim();
  if (!apiKey) return null;
  const baseUrl = (
    env["MUSE_API_BASE_URL"]?.trim() || DEFAULT_MUSE_BASE_URL
  ).replace(/\/+$/, "");
  const model = env["MUSE_MODEL"]?.trim() || DEFAULT_MUSE_MODEL;
  return { apiKey, baseUrl, model };
}

export type GatewayProvider = "opencode-go" | "meta";

export interface GatewayConfig {
  provider: GatewayProvider;
  apiKey: string;
  /** Meta: the API origin (calls go to {baseUrl}/v1/messages).
   *  OpenCode Go: the versioned base (calls go to {baseUrl}/chat/completions). */
  baseUrl: string;
  model: string;
}

export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
export const DEFAULT_OPENCODE_MODEL = "muse-spark-1.3-contributor";
/** Go rejects calls without a session header; one stable id for the app. */
export const OPENCODE_SESSION_ID = "chitragupta";
/**
 * Floor for max_tokens on the Go route: the model spends part of the
 * budget on reasoning tokens before any visible content, so a small
 * budget (classification asks for ~200) returns no content at all.
 */
export const OPENCODE_MIN_MAX_TOKENS = 4000;

/**
 * The active gateway configuration: OpenCode Go when OPENCODE_API_KEY
 * is set (it takes precedence), else the Meta Model API when
 * MUSE_API_KEY is set, else null (rules-only behaviour).
 */
export function gatewayConfig(
  env: NodeJS.ProcessEnv = process.env,
): GatewayConfig | null {
  const openCodeKey = env["OPENCODE_API_KEY"]?.trim();
  if (openCodeKey) {
    return {
      provider: "opencode-go",
      apiKey: openCodeKey,
      baseUrl: OPENCODE_GO_BASE_URL,
      model: env["OPENCODE_MODEL"]?.trim() || DEFAULT_OPENCODE_MODEL,
    };
  }
  const meta = museConfig(env);
  if (meta) return { provider: "meta", ...meta };
  return null;
}

/**
 * The most recent gateway call's outcome, for API diagnostics.
 * `provider` says which gateway served (or refused) the call, and is
 * null in the never-attempted record. `error` is a short excerpt of
 * the gateway's error body (or the thrown error's message) with every
 * configured API key redacted out — it exists so a failing call is
 * visible in /api/ask and /api/classify/run responses instead of being
 * swallowed.
 */
export interface GatewayStatus {
  attempted: boolean;
  ok: boolean;
  provider: GatewayProvider | null;
  status?: number;
  error?: string;
}

let lastStatus: GatewayStatus = { attempted: false, ok: false, provider: null };
let callCount = 0;

/** A snapshot of the most recent gateway call's outcome. */
export function lastGatewayStatus(): GatewayStatus {
  return { ...lastStatus };
}

/** How many gateway calls have been attempted (with a key configured). */
export function gatewayCallCount(): number {
  return callCount;
}

export interface MuseCompleteOptions {
  /** System prompt (Messages surface: top-level field; Go: a system message). */
  system?: string;
  /** The single user message. */
  prompt: string;
  maxTokens?: number;
  /** Abort the call after this many milliseconds; unset means no timeout. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

/** A short excerpt of an error response body, for diagnostics. */
async function readErrorExcerpt(res: Response): Promise<string> {
  let excerpt = "";
  try {
    if (typeof res.text === "function") excerpt = await res.text();
  } catch {
    // body unreadable — the status alone still gets recorded
  }
  if (!excerpt) {
    try {
      excerpt = JSON.stringify(await res.json());
    } catch {
      // no readable body at all
    }
  }
  return excerpt;
}

/**
 * One completion call through the active gateway. Returns the reply
 * text, or null on ANY failure — no key, HTTP error, network error,
 * timeout, or a reply with no text/content — so callers can fall back
 * without exception handling.
 */
export async function museComplete(
  opts: MuseCompleteOptions,
): Promise<string | null> {
  const env = opts.env ?? process.env;
  const config = gatewayConfig(env);
  if (!config) return null;
  callCount++;
  // Redact EVERY configured key, not just the active provider's: an
  // error body must never leak either one into diagnostics or logs.
  const secrets = [
    ...new Set(
      [
        config.apiKey,
        env["OPENCODE_API_KEY"]?.trim(),
        env["MUSE_API_KEY"]?.trim(),
      ].filter((k): k is string => !!k),
    ),
  ];
  const redact = (text: string) => {
    let out = text;
    for (const secret of secrets) out = out.split(secret).join("[redacted]");
    return out.slice(0, 200);
  };
  const fail = (status: number | undefined, error: string): null => {
    const clean = redact(error) || "gateway call failed";
    lastStatus = {
      attempted: true,
      ok: false,
      provider: config.provider,
      ...(status !== undefined ? { status } : {}),
      error: clean,
    };
    console.error(
      `chitragupta: muse gateway call failed${status !== undefined ? ` (HTTP ${status})` : ""}: ${clean}`,
    );
    return null;
  };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller =
    opts.timeoutMs && opts.timeoutMs > 0 ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), opts.timeoutMs)
    : null;
  try {
    const isGo = config.provider === "opencode-go";
    const res = await fetchImpl(
      isGo
        ? `${config.baseUrl}/chat/completions`
        : `${config.baseUrl}/v1/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
          ...(isGo ? { "x-opencode-session": OPENCODE_SESSION_ID } : {}),
        },
        body: JSON.stringify(
          isGo
            ? {
                model: config.model,
                max_tokens: Math.max(
                  opts.maxTokens ?? 1024,
                  OPENCODE_MIN_MAX_TOKENS,
                ),
                messages: [
                  ...(opts.system
                    ? [{ role: "system", content: opts.system }]
                    : []),
                  { role: "user", content: opts.prompt },
                ],
              }
            : {
                model: config.model,
                max_tokens: opts.maxTokens ?? 1024,
                ...(opts.system ? { system: opts.system } : {}),
                messages: [{ role: "user", content: opts.prompt }],
              },
        ),
        ...(controller ? { signal: controller.signal } : {}),
      },
    );
    if (!res.ok) {
      // Read a short error excerpt so the failure is diagnosable; the
      // body of a gateway error never contains our key, and redact()
      // strips it if it somehow did.
      const excerpt = await readErrorExcerpt(res);
      return fail(res.status, excerpt || `HTTP ${res.status}`);
    }
    if (isGo) {
      const body = (await res.json()) as {
        choices?: {
          message?: { content?: string | null };
          finish_reason?: string;
        }[];
      };
      const choice = body.choices?.[0];
      const text = (choice?.message?.content ?? "").trim();
      if (text.length === 0) {
        // The observed cause is finish_reason "length": the reasoning
        // model spent the whole token budget before writing content.
        return fail(
          res.status,
          `gateway returned no content (finish_reason: ${choice?.finish_reason ?? "unknown"})`,
        );
      }
      lastStatus = {
        attempted: true,
        ok: true,
        provider: config.provider,
        status: res.status,
      };
      return text;
    }
    const body = (await res.json()) as {
      content?: { type?: string; text?: string }[];
    };
    const text = (body.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("")
      .trim();
    if (text.length === 0) return fail(res.status, "gateway returned no text");
    lastStatus = {
      attempted: true,
      ok: true,
      provider: config.provider,
      status: res.status,
    };
    return text;
  } catch (error) {
    return fail(
      undefined,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}
