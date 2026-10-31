import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { ingestAll } from "@/lib/ingest/ingest";
import { openStore } from "@/lib/ingest/store";
import { answerAsk } from "@/lib/ask.server";

const DATA_DIR = process.env["CHITRAGUPTA_DATA_DIR"]?.trim() || null;
const describeRepro = DATA_DIR ? describe : describe.skip;

/**
 * B10: an Ask question that states a year must not return £0. Before
 * the fix, the year token survived the deterministic parser as a
 * content term, so "September 2026" searched transaction text for
 * "2026" and matched nothing. The stated-year answers must equal the
 * no-year answers, each derived from the store here so neither can
 * silently drift, and a standalone year ("in 2025") totals that year.
 */
describeRepro("Ask stated years on the repro fixture (B10)", () => {
  let dir: string | null = null;
  let db: Database.Database;
  // On the two-person fixture (repro2) the household figures grow by
  // Nikhila's rows; the literal pins below are Zonito-fixture truths and
  // are asserted only when the store holds his rows alone. The
  // stated-year behaviour itself is asserted against store-derived
  // household figures on either fixture.
  let zonitoOnly = true;

  const TODAY = "2026-10-31";

  /** GBP spend in one calendar month, straight from the store. */
  function monthSpend(month: string) {
    return db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(-amount_minor), 0) AS total
         FROM transactions
         WHERE movement = 'spend' AND currency = 'GBP' AND year_month = ?`,
      )
      .get(month) as { n: number; total: number };
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "chitra-ask-year-"));
    db = openStore(dir);
    ingestAll(db, DATA_DIR!);
    const nikhila = db
      .prepare(
        "SELECT COUNT(*) AS n FROM transactions WHERE person = 'nikhila'",
      )
      .get() as { n: number };
    zonitoOnly = nikhila.n === 0;
  }, 180_000);

  afterAll(() => {
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("answers September 2026 exactly like September, £3,241.78 across 84", async () => {
    const sep = monthSpend("2026-09");
    if (zonitoOnly) {
      expect(sep.n).toBe(84);
      expect(sep.total).toBe(324178);
    }

    const stated = await answerAsk(db, {
      question: "How much did we spend in September 2026?",
      env: {},
      today: TODAY,
    });
    expect(stated.ai).toBe(false);
    expect(stated.figures).toMatchObject({
      total: sep.total / 100,
      count: sep.n,
      month: "2026-09",
      truncated: false,
    });

    const bare = await answerAsk(db, {
      question: "How much did we spend in September?",
      env: {},
      today: TODAY,
    });
    expect(bare.figures).toMatchObject({
      total: sep.total / 100,
      count: sep.n,
      month: "2026-09",
      truncated: false,
    });
  }, 60_000);

  it("answers October 2026 with the month's true total, £1,952.38", async () => {
    const oct = monthSpend("2026-10");
    if (zonitoOnly) expect(oct.total).toBe(195238);

    const stated = await answerAsk(db, {
      question: "How much did we spend in October 2026?",
      env: {},
      today: TODAY,
    });
    expect(stated.ai).toBe(false);
    expect(stated.figures).toMatchObject({
      total: oct.total / 100,
      count: oct.n,
      month: "2026-10",
      truncated: false,
    });
  }, 60_000);

  it("totals a standalone stated year over that year's range", async () => {
    const year = db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(-amount_minor), 0) AS total
         FROM transactions
         WHERE movement = 'spend' AND currency = 'GBP'
           AND date(effective_date) BETWEEN date('2025-01-01') AND date('2025-12-31')`,
      )
      .get() as { n: number; total: number };
    expect(year.n).toBeGreaterThan(0);

    const result = await answerAsk(db, {
      question: "What did we spend in 2025?",
      env: {},
      today: TODAY,
    });
    expect(result.ai).toBe(false);
    expect(result.figures).toMatchObject({
      total: year.total / 100,
      count: year.n,
      month: null,
      truncated: false,
    });
  }, 60_000);
});
