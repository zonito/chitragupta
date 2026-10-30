/**
 * Shared client for the Meta Model API — the one gateway every AI call in
 * Chitragupta goes through (merchant classification and Ask answers).
 * Server-only: it reads the API key from the environment and must never be
 * imported into browser code.
 *
 * The gateway is Anthropic-Messages-shaped: POST {base}/v1/messages with
 * `Authorization: Bearer <key>` (there is no x-api-key header). Keys start
 * with "LLM_". The base defaults to https://api.meta.ai and the model to
 * muse-spark-1.3-contributor (Zonito's choice for everything, 30 Oct
 * 2026); MUSE_API_BASE_URL and MUSE_MODEL override them.
 *
 * With no key configured this module is a strict no-op: museComplete
 * returns null without any network call, and callers fall back to their
 * deterministic behaviour — exactly the pre-gateway no-key path. The key
 * is never logged, returned or embedded in an error.
 */

export interface MuseConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export const DEFAULT_MUSE_BASE_URL = "https://api.meta.ai";
export const DEFAULT_MUSE_MODEL = "muse-spark-1.3-contributor";

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

export interface MuseCompleteOptions {
  /** System prompt (the Messages surface takes it as a top-level field). */
  system?: string;
  /** The single user message. */
  prompt: string;
  maxTokens?: number;
  /** Abort the call after this many milliseconds; unset means no timeout. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

/**
 * One completion call. Returns the concatenated text of the reply, or null
 * on ANY failure — no key, HTTP error, network error, timeout, or a reply
 * with no text — so callers can fall back without exception handling.
 */
export async function museComplete(
  opts: MuseCompleteOptions,
): Promise<string | null> {
  const config = museConfig(opts.env ?? process.env);
  if (!config) return null;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller =
    opts.timeoutMs && opts.timeoutMs > 0 ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), opts.timeoutMs)
    : null;
  try {
    const res = await fetchImpl(`${config.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: opts.maxTokens ?? 1024,
        ...(opts.system ? { system: opts.system } : {}),
        messages: [{ role: "user", content: opts.prompt }],
      }),
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      content?: { type?: string; text?: string }[];
    };
    const text = (body.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("")
      .trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
