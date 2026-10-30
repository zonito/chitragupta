import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ingestAll } from "@/lib/ingest/ingest";
import { openStore } from "@/lib/ingest/store";

const DATA_DIR = process.env["CHITRAGUPTA_DATA_DIR"]?.trim() || null;
const describeAcceptance = DATA_DIR ? describe : describe.skip;

const EXPECTED_ROWS: Record<string, number> = {
  Main: 2770,
  Pro: 4262,
  "USD-Invest": 482,
  Joint: 173,
  "Savings-9000000002": 567,
  "Savings-9000000001": 355,
};

describeAcceptance("acceptance numbers from the real Originals", () => {
  it("ingests 8,609 transactions with per-account counts (REVERTED excluded)", () => {
    const db = openStore(mkdtempSync(join(tmpdir(), "chitra-")));
    const results = ingestAll(db, DATA_DIR!, "zonito");
    const total = results.reduce((n, r) => n + r.rowsSeen, 0);
    expect(total).toBe(8609);
    for (const r of results) {
      expect(r.rowsSeen).toBe(EXPECTED_ROWS[r.account]);
    }
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM transactions").get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(8609);
    db.close();
  }, 120_000);

  it("excludes the 14 REVERTED rows from spend", () => {
    const db = openStore(mkdtempSync(join(tmpdir(), "chitra-")));
    ingestAll(db, DATA_DIR!, "zonito");
    // The 3 genuinely re-attempted charges survive as COMPLETED spend; the
    // 14 REVERTED holds must not. Distinguish by the empty REVERTED balance.
    const holds = db
      .prepare(
        `SELECT COUNT(*) AS n FROM transactions WHERE balance_minor = 0
         AND description IN ('Frn* Hold.free-Now.com', 'Fbpay Meta Store')
         AND amount_minor IN (-1650, -3000, -42499, -45898)
         AND year_month IN ('2022-09', '2023-11')`,
      )
      .get() as { n: number };
    void holds;
    const phantom = db
      .prepare(
        `SELECT COALESCE(SUM(-amount_minor), 0) AS s FROM transactions
         WHERE movement = 'spend' AND balance_minor = 0
         AND ((description = 'Frn* Hold.free-Now.com' AND amount_minor = -1650)
           OR (description = 'Housekeep' AND amount_minor = -3000)
           OR (description = 'Fbpay Meta Store' AND amount_minor IN (-42499, -45898)))`,
      )
      .get() as { s: number };
    expect(phantom.s).toBe(0);
    const total = db
      .prepare("SELECT COUNT(*) AS n FROM transactions")
      .get() as {
      n: number;
    };
    expect(total.n).toBe(8609);
    db.close();
  }, 120_000);

  it("stores savings rows with ISO dates and real year_month buckets", () => {
    const db = openStore(mkdtempSync(join(tmpdir(), "chitra-")));
    ingestAll(db, DATA_DIR!, "zonito");
    const jan = db
      .prepare(
        `SELECT effective_date, year_month FROM transactions
         WHERE account = 'Savings-9000000001' AND description = 'Deposit'
         ORDER BY effective_date LIMIT 1`,
      )
      .get() as { effective_date: string; year_month: string };
    expect(jan.effective_date).toBe("2026-01-25");
    expect(jan.year_month).toBe("2026-01");
    const odd = db
      .prepare(
        `SELECT COUNT(*) AS n FROM transactions WHERE account LIKE 'Savings-%'
         AND year_month NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'`,
      )
      .get() as { n: number };
    expect(odd.n).toBe(0);
    db.close();
  }, 120_000);

  it("reproduces the final balances", () => {
    const db = openStore(mkdtempSync(join(tmpdir(), "chitra-")));
    const results = ingestAll(db, DATA_DIR!, "zonito");
    const byAccount = Object.fromEntries(results.map((r) => [r.account, r]));
    expect(byAccount["Main"]!.balanceMinor).toBe(14274);
    expect(byAccount["Pro"]!.balanceMinor).toBe(19568);
    expect(byAccount["Joint"]!.balanceMinor).toBe(0);
    expect(byAccount["Savings-9000000002"]!.balanceMinor).toBe(80563);
    expect(byAccount["Savings-9000000001"]!.balanceMinor).toBe(27164);
    const usd = db
      .prepare(
        "SELECT DISTINCT currency AS c FROM transactions WHERE account = 'USD-Invest'",
      )
      .all() as { c: string }[];
    expect(usd.map((r) => r.c).sort()).toEqual(["EUR", "INR", "USD"]);
    db.close();
  }, 120_000);

  it("is idempotent: a second ingest adds nothing", () => {
    const db = openStore(mkdtempSync(join(tmpdir(), "chitra-")));
    ingestAll(db, DATA_DIR!, "zonito");
    const second = ingestAll(db, DATA_DIR!, "zonito");
    expect(second.reduce((n, r) => n + r.rowsAdded, 0)).toBe(0);
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM transactions").get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(8609);
    db.close();
  }, 180_000);

  it("lands the Gepp & Sons payments as capital, never February/March spend", () => {
    const db = openStore(mkdtempSync(join(tmpdir(), "chitra-")));
    ingestAll(db, DATA_DIR!, "zonito");
    const gepp = db
      .prepare(
        "SELECT description, movement, year_month FROM transactions WHERE description LIKE '%Gepp & Sons Solicitors%'",
      )
      .all() as { description: string; movement: string; year_month: string }[];
    expect(gepp).toHaveLength(2);
    for (const g of gepp) expect(g.movement).toBe("aside");
    const febSpend = db
      .prepare(
        "SELECT COALESCE(SUM(-amount_minor), 0) AS s FROM transactions WHERE account = 'Main' AND year_month = '2026-02' AND movement = 'spend'",
      )
      .get() as { s: number };
    const marSpend = db
      .prepare(
        "SELECT COALESCE(SUM(-amount_minor), 0) AS s FROM transactions WHERE account = 'Main' AND year_month = '2026-03' AND movement = 'spend'",
      )
      .get() as { s: number };
    expect(febSpend.s).toBeLessThan(4710000);
    expect(marSpend.s).toBeLessThan(13438223);
    const febAside = db
      .prepare(
        "SELECT COALESCE(SUM(-amount_minor), 0) AS s FROM transactions WHERE account = 'Main' AND year_month = '2026-02' AND movement = 'aside'",
      )
      .get() as { s: number };
    const marAside = db
      .prepare(
        "SELECT COALESCE(SUM(-amount_minor), 0) AS s FROM transactions WHERE account = 'Main' AND year_month = '2026-03' AND movement = 'aside'",
      )
      .get() as { s: number };
    expect(febAside.s).toBeGreaterThanOrEqual(4710000);
    expect(marAside.s).toBeGreaterThanOrEqual(13438223);
    db.close();
  }, 120_000);
});
