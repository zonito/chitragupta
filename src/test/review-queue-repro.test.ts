import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ingestAll } from "@/lib/ingest/ingest";
import {
  reviewQueue,
  reviewQueueCount,
  seedMerchantMemory,
} from "@/lib/ingest/merchants";
import { openStore } from "@/lib/ingest/store";

const DATA_DIR = process.env["CHITRAGUPTA_DATA_DIR"]?.trim() || null;
const describeRepro = DATA_DIR ? describe : describe.skip;

// The test's own copy of the G12 exclusion rules, applied to a raw
// fixture query, so the expected drop is derived from the data rather
// than from the code under test.
const TEST_NEVER_PATTERNS: RegExp[] = [
  /^investing money$/i,
  /^closing investment$/i,
  /cashback/i,
  /^fidelity investments$/i,
];

describeRepro("review queue composition on the repro fixture (B2/G12)", () => {
  it("drops the true total from 617 by exactly the excluded set derived from the fixture", () => {
    const db = openStore(mkdtempSync(join(tmpdir(), "chitra-rq-repro-")));
    ingestAll(db, DATA_DIR!, "zonito");
    seedMerchantMemory(db);

    // Baseline: every distinct unknown merchant (pre-G12 definition),
    // straight from the fixture store.
    const baseline = db
      .prepare(
        `SELECT merchant, COUNT(*) AS n,
                SUM(CASE WHEN movement = 'spend' THEN 1 ELSE 0 END) AS spend_n
         FROM transactions
         WHERE movement IN ('spend','income')
           AND merchant NOT IN (SELECT merchant FROM merchant_memory)
         GROUP BY merchant`,
      )
      .all() as { merchant: string; n: number; spend_n: number }[];
    expect(baseline.length).toBe(617);

    const excluded = baseline.filter(
      (r) =>
        r.spend_n <= 0 || TEST_NEVER_PATTERNS.some((p) => p.test(r.merchant)),
    );
    const excludedNames = new Set(excluded.map((r) => r.merchant));
    // The evidenced labels from the task are all in the excluded set.
    for (const name of [
      "SHARMA L",
      "LOVE KUMAR SHARMA",
      "Deposit",
      "Pro Cashback",
      "Closing investment",
      "FIDELITY FASL PYMT",
      "Investing money",
      "Fidelity Investments",
      "Pro Cashback Reversal",
    ]) {
      expect(excludedNames.has(name)).toBe(true);
    }
    expect(excludedNames.has("Please Connect Me")).toBe(false);

    // The true total drops by exactly the excluded set.
    expect(reviewQueueCount(db)).toBe(baseline.length - excluded.length);
    expect(reviewQueueCount(db)).toBe(617 - excluded.length);

    // The capped list shows none of the excluded labels, every item
    // it does show has spend rows, and the genuine unknown stays.
    const queue = reviewQueue(db);
    for (const item of queue) {
      expect(excludedNames.has(item.merchant)).toBe(false);
      const spend = db
        .prepare(
          `SELECT COUNT(*) AS n FROM transactions
           WHERE merchant = ? AND movement = 'spend'`,
        )
        .get(item.merchant) as { n: number };
      expect(spend.n).toBeGreaterThan(0);
    }
    expect(queue.map((q) => q.merchant)).toContain("Please Connect Me");
    db.close();
  }, 120_000);
});
