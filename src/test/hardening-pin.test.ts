import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyMovement,
  gbpPence,
  parseAccountCsv,
} from "@/lib/ingest/parse";
import { savingsIsoDate } from "@/lib/ingest/ingest";
import { openStore } from "@/lib/ingest/store";
import { recomputeAggregates } from "@/lib/ingest/ingest";

/**
 * Pinning tests for AH-085 hardening: current money-path behaviour,
 * hand-recomputed, so the dedup/logging fixes that follow cannot drift it.
 * All fixtures are synthetic.
 */
describe("hardening pins: money path (hand-recomputed)", () => {
  it("per-currency monthly in/out from a synthetic statement", () => {
    const csv = [
      "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance",
      "Card Payment,Current,2026-10-02,2026-10-02,Ocado,-112.40,0.00,GBP,COMPLETED,900.00",
      "Card Payment,Current,2026-10-03,2026-10-03,TfL,-28.40,0.00,GBP,COMPLETED,871.60",
      "Deposit,Current,2026-10-28,2026-10-28,Salary,3000.00,0.00,GBP,COMPLETED,3871.60",
      "Card Payment,Current,2026-10-04,2026-10-04,US Store,-50.00,0.00,USD,COMPLETED,100.00",
    ].join("\n");
    const rows = parseAccountCsv(csv);
    // Hand computation: GBP spend 11240+2840=14080p out; GBP income 300000p in;
    // USD spend 5000 cents out, kept in its own currency bucket.
    const totals = new Map<string, { in: number; out: number }>();
    for (const r of rows) {
      const minor = gbpPence(r.amount);
      const movement = classifyMovement(r.type, r.description, minor, r.currency, r.state);
      const bucket = totals.get(r.currency) ?? { in: 0, out: 0 };
      if (movement === "spend") bucket.out += -minor;
      if (movement === "income") bucket.in += minor;
      totals.set(r.currency, bucket);
    }
    expect(totals.get("GBP")).toEqual({ in: 300000, out: 14080 });
    expect(totals.get("USD")).toEqual({ in: 0, out: 5000 });
  });

  it("savings dates: Sept spellings normalise as today", () => {
    expect(savingsIsoDate("1 Sept 2026")).toBe("2026-09-01");
    expect(savingsIsoDate("1 Sep 2026")).toBe("2026-09-01");
    expect(savingsIsoDate("Sep 5, 2026")).toBe("2026-09-05");
  });

  it("aggregates stay per-currency and never sum across currencies", () => {
    const dir = mkdtempSync(join(tmpdir(), "chitragupta-pin-"));
    try {
      const db = openStore(dir);
      const insert = db.prepare(
        `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
           description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
         VALUES (?, 'zonito', 'Main', ?, '2026-10', ?, ?, ?, 0, ?, 0, 'spend', NULL)`,
      );
      insert.run("a", "2026-10-02", "Ocado", "Ocado", -10000, "GBP");
      insert.run("b", "2026-10-03", "US Store", "US Store", -5000, "USD");
      recomputeAggregates(db, "zonito");
      const rows = db
        .prepare(
          "SELECT currency, spend_minor FROM month_aggregates WHERE person='zonito' ORDER BY currency",
        )
        .all() as { currency: string; spend_minor: number }[];
      expect(rows).toEqual([
        { currency: "GBP", spend_minor: 10000 },
        { currency: "USD", spend_minor: 5000 },
      ]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
