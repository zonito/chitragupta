import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ingestAll } from "@/lib/ingest/ingest";
import { openStore } from "@/lib/ingest/store";
import { answerAsk } from "@/lib/ask.server";

const DATA_DIR = process.env["CHITRAGUPTA_DATA_DIR"]?.trim() || null;
const describeRepro = DATA_DIR ? describe : describe.skip;

/**
 * G20d: the Ask example chip "What did we spend with Air India?" must be
 * a question the household's data actually answers, through the
 * deterministic path (no gateway key). The September 2026 slice is the
 * 6 rows totalling £1,332.84; the full-history answer also includes
 * one earlier Air India row (April 2025, £3,713.92), so the chip's
 * total is £5,046.76 across 7 — both figures are asserted here, each
 * derived from the store, so neither can silently drift.
 */
describeRepro("Ask Air India example on the repro fixture (G20d)", () => {
  let dir: string | null = null;

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("returns the Air India total, with the September 2026 slice at £1,332.84 across 6 rows", async () => {
    dir = mkdtempSync(join(tmpdir(), "chitra-ask-air-india-"));
    const db = openStore(dir);
    ingestAll(db, DATA_DIR!);

    // The September 2026 slice, straight from the store.
    const sep = db
      .prepare(
        `SELECT COUNT(*) AS n, SUM(-amount_minor) AS total FROM transactions
         WHERE merchant = 'Air India' AND movement = 'spend' AND year_month = '2026-09'`,
      )
      .get() as { n: number; total: number };
    expect(sep.n).toBe(6);
    expect(sep.total).toBe(133284);

    const result = await answerAsk(db, {
      question: "What did we spend with Air India?",
      env: {},
      today: "2026-10-31",
    });
    expect(result.ai).toBe(false);
    expect(result.figures).toMatchObject({
      total: 5046.76,
      count: 7,
      month: null,
    });
    expect(result.figures.perMonth).toEqual([
      { month: "2025-04", total: 3713.92, count: 1 },
      { month: "2026-09", total: 1332.84, count: 6 },
    ]);
    expect(result.answer).toContain(
      "Total across 7 matching transactions: £5,046.76.",
    );
    db.close();
  }, 120_000);
});
