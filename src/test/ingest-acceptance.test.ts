import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ingestAll } from "@/lib/ingest/ingest";
import { openStore } from "@/lib/ingest/store";

const DATA_DIR =
  "/Users/zonito/Library/CloudStorage/GoogleDrive-love.sharma.87@gmail.com/My Drive/PersonalFinance";

const EXPECTED_ROWS: Record<string, number> = {
  Main: 2780,
  Pro: 4262,
  "USD-Invest": 486,
  Joint: 173,
  "Savings-9000000002": 567,
  "Savings-9000000001": 355,
};

describe("acceptance numbers from the real Originals", () => {
  it("ingests 8,623 transactions with per-account counts", () => {
    const db = openStore(mkdtempSync(join(tmpdir(), "chitra-")));
    const results = ingestAll(db, DATA_DIR, "zonito");
    const total = results.reduce((n, r) => n + r.rowsSeen, 0);
    expect(total).toBe(8623);
    for (const r of results) {
      expect(r.rowsSeen).toBe(EXPECTED_ROWS[r.account]);
    }
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM transactions").get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(8623);
    db.close();
  }, 120_000);

  it("reproduces the final balances", () => {
    const db = openStore(mkdtempSync(join(tmpdir(), "chitra-")));
    const results = ingestAll(db, DATA_DIR, "zonito");
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
    ingestAll(db, DATA_DIR, "zonito");
    const second = ingestAll(db, DATA_DIR, "zonito");
    expect(second.reduce((n, r) => n + r.rowsAdded, 0)).toBe(0);
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM transactions").get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(8623);
    db.close();
  }, 180_000);

  it("lands the Gepp & Sons payments as capital, never February/March spend", () => {
    const db = openStore(mkdtempSync(join(tmpdir(), "chitra-")));
    ingestAll(db, DATA_DIR, "zonito");
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
