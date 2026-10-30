import type Database from "better-sqlite3";
import { recomputeAggregates } from "./ingest";
import { reviewQueue, setMerchant } from "./merchants";

/**
 * Muse classification for merchants the deterministic rules cannot place.
 *
 * Privacy contract: the only data that leaves the machine is the merchant
 * name, its dominant movement type, and a transaction count. No amounts
 * (beyond that count), no balances, no account identifiers, no dates.
 *
 * The key is read from MUSE_API_KEY (Zonito's .env names it that, not
 * ANTHROPIC_API_KEY). MUSE_API_BASE_URL optionally points at a gateway
 * instead of api.anthropic.com; MUSE_API_MODEL overrides the model.
 * With no key configured this module is a strict no-op: the review queue
 * simply accumulates until a key exists. Classification runs after ingest
 * or via POST /api/classify/run; it never blocks page loads, and a failed
 * call leaves the merchant queued for the next run.
 */

export const CLASSIFIABLE_CATEGORIES = [
  "Groceries",
  "Eating out",
  "Transport",
  "School",
  "Home",
  "Subscriptions",
  "Holidays",
  "Shopping",
  "One-off",
] as const;

export type ClaudeConfig = { apiKey: string; baseUrl: string; model: string };

export function claudeConfig(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeConfig | null {
  const apiKey = env["MUSE_API_KEY"]?.trim();
  if (!apiKey) return null;
  const baseUrl = (
    env["MUSE_API_BASE_URL"]?.trim() || "https://api.anthropic.com"
  ).replace(/\/+$/, "");
  const model = env["MUSE_API_MODEL"]?.trim() || "claude-haiku-4-5";
  return { apiKey, baseUrl, model };
}

export type ClassifySummary = {
  ran: boolean;
  reason?: string;
  classified: number;
  failed: number;
  remaining: number;
};

type Classification = { category: string; icon: string | null; colour: string | null };

function dominantMovement(
  db: Database.Database,
  merchant: string,
): string {
  const row = db
    .prepare(
      `SELECT movement, COUNT(*) AS n FROM transactions WHERE merchant = ?
       GROUP BY movement ORDER BY n DESC LIMIT 1`,
    )
    .get(merchant) as { movement: string } | undefined;
  return row?.movement ?? "spend";
}

function parseClassification(text: string): Classification | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { category, icon, colour } = parsed as Record<string, unknown>;
  if (typeof category !== "string") return null;
  const match = CLASSIFIABLE_CATEGORIES.find(
    (c) => c.toLowerCase() === category.trim().toLowerCase(),
  );
  if (!match) return null;
  const clean = (v: unknown): string | null =>
    typeof v === "string" && v.trim().length > 0 && v.trim().length <= 60
      ? v.trim()
      : null;
  return { category: match, icon: clean(icon), colour: clean(colour) };
}

async function classifyOne(
  config: ClaudeConfig,
  merchant: string,
  movement: string,
  count: number,
  fetchImpl: typeof fetch,
): Promise<Classification | null> {
  const prompt = [
    `Classify this UK household merchant for an expense tracker.`,
    `Merchant: ${merchant}`,
    `Transaction type: ${movement}`,
    `Seen ${count} time(s).`,
    `Reply with ONLY a JSON object: {"category": one of ${JSON.stringify(CLASSIFIABLE_CATEGORIES)}, "icon": a short lowercase icon name (e.g. "shopping-bag", "coffee", "train"), "colour": a hex colour like "#3b82f6"}.`,
  ].join("\n");
  const res = await fetchImpl(`${config.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    content?: { type?: string; text?: string }[];
  };
  const text = (body.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text!)
    .join("");
  return parseClassification(text);
}

export async function classifyUnknownMerchants(
  db: Database.Database,
  opts: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    limit?: number;
  } = {},
): Promise<ClassifySummary> {
  const queue = reviewQueue(db);
  const config = claudeConfig(opts.env ?? process.env);
  if (!config) {
    return {
      ran: false,
      reason: "MUSE_API_KEY is not set; staying rules-only",
      classified: 0,
      failed: 0,
      remaining: queue.length,
    };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  let classified = 0;
  let failed = 0;
  for (const item of queue.slice(0, opts.limit ?? 50)) {
    try {
      const result = await classifyOne(
        config,
        item.merchant,
        dominantMovement(db, item.merchant),
        item.count,
        fetchImpl,
      );
      if (!result) {
        failed++;
        continue;
      }
      setMerchant(db, item.merchant, result.category, {
        colour: result.colour,
        icon: result.icon,
        source: "claude-api",
      });
      classified++;
    } catch {
      failed++;
    }
  }
  if (classified > 0) {
    const persons = db
      .prepare("SELECT DISTINCT person FROM transactions")
      .all() as { person: string }[];
    for (const { person } of persons) recomputeAggregates(db, person);
  }
  return {
    ran: true,
    classified,
    failed,
    remaining: reviewQueue(db).length,
  };
}
