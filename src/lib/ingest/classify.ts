import type Database from "better-sqlite3";
import { recomputeAggregates } from "./ingest";
import { reviewQueue, reviewQueueCount, setMerchant } from "./merchants";
import {
  gatewayCallCount,
  gatewayConfig,
  lastGatewayStatus,
  museComplete,
  type GatewayConfig,
  type GatewayStatus,
} from "../muse.server";

/**
 * Muse classification for merchants the deterministic rules cannot place.
 *
 * Privacy contract: the only data that leaves the machine is the merchant
 * name, its dominant movement type, and a transaction count. No amounts
 * (beyond that count), no balances, no account identifiers, no dates.
 *
 * Calls go through the shared gateway client (src/lib/muse.server.ts):
 * OpenCode Go when OPENCODE_API_KEY is set, else the Meta Model API
 * when MUSE_API_KEY is set. With no key configured this module is a
 * strict no-op: the review queue simply accumulates until a key exists.
 * Classification runs after ingest or via POST /api/classify/run; it
 * never blocks page loads, and a failed call leaves the merchant queued
 * for the next run.
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

export type ClaudeConfig = GatewayConfig;

/** Gateway configuration for classification (kept name for existing callers). */
export function claudeConfig(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeConfig | null {
  return gatewayConfig(env);
}

export type ClassifySummary = {
  ran: boolean;
  reason?: string;
  classified: number;
  failed: number;
  remaining: number;
  /**
   * Diagnostics for the gateway calls this run made: the first failure's
   * status/error when any call failed, else the last call's outcome.
   * attempted:false when no call was made (no key configured).
   */
  gateway: GatewayStatus;
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
  merchant: string,
  movement: string,
  count: number,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<Classification | null> {
  const prompt = [
    `Classify this UK household merchant for an expense tracker.`,
    `Merchant: ${merchant}`,
    `Transaction type: ${movement}`,
    `Seen ${count} time(s).`,
    `Reply with ONLY a JSON object: {"category": one of ${JSON.stringify(CLASSIFIABLE_CATEGORIES)}, "icon": a short lowercase icon name (e.g. "shopping-bag", "coffee", "train"), "colour": a hex colour like "#3b82f6"}.`,
  ].join("\n");
  let text = await museComplete({
    prompt,
    maxTokens: 200,
    env,
    fetchImpl,
  });
  if (!text) {
    // The hardest merchants burn even the gateway's token floor on
    // reasoning and return no content at all (Go: "gateway returned
    // no content (finish_reason: length)"; Meta: "gateway returned
    // no text"). That one failure mode earns exactly one retry at a
    // larger budget; every other failure (HTTP 401/402/5xx, network)
    // stays a single attempt.
    const error = (lastGatewayStatus().error ?? "").toLowerCase();
    if (error.includes("no content") || error.includes("no text")) {
      text = await museComplete({
        prompt,
        maxTokens: 8000,
        env,
        fetchImpl,
      });
    }
  }
  return text ? parseClassification(text) : null;
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
  const env = opts.env ?? process.env;
  const config = claudeConfig(env);
  if (!config) {
    return {
      ran: false,
      reason: "No gateway API key is set (OPENCODE_API_KEY or MUSE_API_KEY); staying rules-only",
      classified: 0,
      failed: 0,
      remaining: reviewQueueCount(db),
      gateway: { attempted: false, ok: false, provider: null },
    };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  let classified = 0;
  let failed = 0;
  // Gateway diagnostics for this run: poll the shared client's call
  // counter after each merchant so the summary can surface the FIRST
  // failure's status/error instead of a bare failed count. A merchant
  // whose first call returns no content is retried inside classifyOne,
  // so the counter can jump by two for one merchant; polling still
  // reports that merchant sensibly — the final call's outcome (success
  // after a retry, or the retry's own no-content failure) is what the
  // shared client last recorded, and a merchant whose retry succeeds
  // counts below as classified, never failed.
  let gatewaySeen = gatewayCallCount();
  let gatewayLast: GatewayStatus | undefined;
  let gatewayFailure: GatewayStatus | undefined;
  const pollGateway = () => {
    const count = gatewayCallCount();
    if (count > gatewaySeen) {
      gatewaySeen = count;
      const status = lastGatewayStatus();
      gatewayLast = status;
      if (!status.ok && !gatewayFailure) gatewayFailure = status;
    }
  };
  for (const item of queue.slice(0, opts.limit ?? 50)) {
    try {
      const result = await classifyOne(
        item.merchant,
        dominantMovement(db, item.merchant),
        item.count,
        env,
        fetchImpl,
      );
      pollGateway();
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
    remaining: reviewQueueCount(db),
    gateway: gatewayFailure ?? gatewayLast ?? { attempted: false, ok: false, provider: null },
  };
}
