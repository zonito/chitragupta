import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recomputeAggregates } from "@/lib/ingest/ingest";
import { reviewQueue, reviewQueueCount } from "@/lib/ingest/merchants";
import { openStore } from "@/lib/ingest/store";

/**
 * Phase B / B4: Settings merchant review can actually classify.
 *
 * (a) POST /api/review-queue/dismiss persists: the merchant leaves
 *     reviewQueue/reviewQueueCount, merchant_memory is untouched and
 *     the aggregates (and transactions) are byte-identical.
 * (b) GET /api/review-queue items carry detail + suggestion, with
 *     suggestion null for a merchant that resolves only to the
 *     movement fallback and the resolved category for one whose rows
 *     carry an explicit category.
 */

const STORE_DIR = mkdtempSync(join(tmpdir(), "chitra-dismiss-"));
const prevStoreEnv = process.env["CHITRAGUPTA_STORE_DIR"];
process.env["CHITRAGUPTA_STORE_DIR"] = STORE_DIR;

type Api = typeof import("@/lib/api");
let api: Api;

function seed(
  db: ReturnType<typeof openStore>,
  fp: string,
  merchant: string,
  date: string,
  amountMinor: number,
  category: string | null = null,
) {
  db.prepare(
    `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
      description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
     VALUES (?, 'zonito', 'Main', ?, '2026-10', ?, ?, ?, 0, 'GBP', 0, 'spend', ?)`,
  ).run(fp, date, merchant, merchant, amountMinor, category);
}

function dump(db: ReturnType<typeof openStore>, table: string): string {
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2, 3`).all();
  return JSON.stringify(rows);
}

beforeAll(async () => {
  const db = openStore(STORE_DIR);
  seed(db, "d-1", "Dismiss Me", "2026-10-03", -1000);
  seed(db, "d-2", "Dismiss Me", "2026-10-05", -2000);
  seed(db, "k-1", "Keep Me", "2026-10-04", -1500);
  // Explicit category on the transactions, nothing in merchant memory:
  // the app resolves this merchant to Groceries today.
  seed(db, "t-1", "Tagged Shop", "2026-10-05", -4200, "Groceries");
  // No category anywhere: spend resolves only to the 'One-off'
  // movement fallback.
  seed(db, "f-1", "Fallback Shop", "2026-10-05", -1234);
  recomputeAggregates(db, "zonito");
  db.close();
  api = await import("@/lib/api");
});

afterAll(() => {
  if (prevStoreEnv === undefined) delete process.env["CHITRAGUPTA_STORE_DIR"];
  else process.env["CHITRAGUPTA_STORE_DIR"] = prevStoreEnv;
  rmSync(STORE_DIR, { recursive: true, force: true });
});

async function getQueue() {
  const res = await api.handleChitraguptaApi(
    new Request("http://local/api/review-queue"),
  );
  expect(res?.status).toBe(200);
  return (await res!.json()) as {
    ok: boolean;
    queue: {
      merchant: string;
      detail: string;
      suggestion: string | null;
    }[];
    total: number;
  };
}

describe("GET /api/review-queue enrichment (B4)", () => {
  it("(b) items carry detail and suggestion; fallback-only merchants get suggestion null", async () => {
    const body = await getQueue();
    expect(body.total).toBe(4);
    const byMerchant = new Map(body.queue.map((q) => [q.merchant, q]));

    const fallback = byMerchant.get("Fallback Shop")!;
    expect(fallback.detail).toBe("£12.34 · 1 charge · last 5 Oct");
    expect(fallback.suggestion).toBeNull();

    const tagged = byMerchant.get("Tagged Shop")!;
    expect(tagged.detail).toBe("£42.00 · 1 charge · last 5 Oct");
    expect(tagged.suggestion).toBe("Groceries");

    const dismissMe = byMerchant.get("Dismiss Me")!;
    expect(dismissMe.detail).toBe("£30.00 · 2 charges · last 5 Oct");
    expect(dismissMe.suggestion).toBeNull();
  });
});

describe("POST /api/review-queue/dismiss (B4)", () => {
  it("(a) persists, excludes the merchant, and changes nothing else", async () => {
    const before = openStore(STORE_DIR);
    const memoryBefore = dump(before, "merchant_memory");
    const aggregatesBefore = dump(before, "month_aggregates");
    const transactionsBefore = dump(before, "transactions");
    expect(reviewQueue(before).map((q) => q.merchant)).toContain("Dismiss Me");
    const countBefore = reviewQueueCount(before);
    before.close();

    const res = await api.handleChitraguptaApi(
      new Request("http://local/api/review-queue/dismiss", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ merchant: "Dismiss Me" }),
      }),
    );
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true });

    const after = openStore(STORE_DIR);
    expect(reviewQueue(after).map((q) => q.merchant)).not.toContain("Dismiss Me");
    expect(reviewQueue(after).map((q) => q.merchant)).toContain("Keep Me");
    expect(reviewQueueCount(after)).toBe(countBefore - 1);
    // The dismissal is recorded in its own table only.
    const dismissed = after
      .prepare("SELECT merchant FROM dismissed_merchants")
      .all() as { merchant: string }[];
    expect(dismissed).toEqual([{ merchant: "Dismiss Me" }]);
    expect(dump(after, "merchant_memory")).toBe(memoryBefore);
    expect(dump(after, "month_aggregates")).toBe(aggregatesBefore);
    expect(dump(after, "transactions")).toBe(transactionsBefore);
    after.close();

    // And the API agrees: the merchant stays gone after a "reload".
    const body = await getQueue();
    expect(body.queue.map((q) => q.merchant)).not.toContain("Dismiss Me");
    expect(body.total).toBe(countBefore - 1);
  });

  it("rejects a dismissal with no merchant", async () => {
    const res = await api.handleChitraguptaApi(
      new Request("http://local/api/review-queue/dismiss", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res?.status).toBe(400);
  });
});
