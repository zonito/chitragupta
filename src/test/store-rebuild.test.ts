import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureFreshStore, ingestAccount } from "@/lib/ingest/ingest";
import { setMerchant } from "@/lib/ingest/merchants";
import { openStore, RULES_VERSION } from "@/lib/ingest/store";

function fixtureDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chitra-data-"));
  mkdirSync(join(dir, "Originals"), { recursive: true });
  writeFileSync(
    join(dir, "Originals", "account-statement_2026_f5660e.csv"),
    "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n" +
      "Card Payment,Current,2026-10-03 10:00:00,2026-10-03 10:00:01,Ocado,-10.00,0.00,GBP,COMPLETED,990.00\n" +
      "Card Payment,Current,2026-10-04 10:00:00,2026-10-04 10:00:01,Frn* Hold.free-Now.com,-16.50,0.00,GBP,REVERTED,\n",
  );
  return dir;
}

describe("stale-store self-heal (Fix 7)", () => {
  it("purges wrongly classified rows on a rules-version change, keeps merchant memory", () => {
    const db = openStore(mkdtempSync(join(tmpdir(), "chitra-store-")));
    // Simulate a store built by older rules: a phantom REVERTED row stored
    // as spend, stamped with an old rules version.
    db.prepare(
      `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
        description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
       VALUES ('phantom', 'zonito', 'Main', '2022-09-10', '2022-09', 'Frn* Hold.free-Now.com',
        'Frn* Hold.free-Now.com', -1650, 0, 'GBP', 0, 'spend', NULL)`,
    ).run();
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('rules_version', '0')",
    ).run();
    // A user correction lives in merchant memory and must survive.
    setMerchant(db, "Ocado", "Groceries", { source: "user" });

    expect(ensureFreshStore(db)).toBe(true);
    const remaining = db
      .prepare("SELECT COUNT(*) AS n FROM transactions")
      .get() as { n: number };
    expect(remaining.n).toBe(0);
    const memory = db
      .prepare("SELECT category, source FROM merchant_memory WHERE merchant = 'Ocado'")
      .get() as { category: string; source: string };
    expect(memory).toEqual({ category: "Groceries", source: "user" });
    const stamp = db
      .prepare("SELECT value FROM meta WHERE key = 'rules_version'")
      .get() as { value: string };
    expect(stamp.value).toBe(String(RULES_VERSION));
    const rebuilds = db
      .prepare("SELECT COUNT(*) AS n FROM ingest_runs WHERE account = '__rebuild__'")
      .get() as { n: number };
    expect(rebuilds.n).toBe(1);
    // Second run is a no-op.
    expect(ensureFreshStore(db)).toBe(false);
    db.close();
  });

  it("re-ingest after a purge holds only rows the current rules produce", () => {
    const db = openStore(mkdtempSync(join(tmpdir(), "chitra-store-")));
    db.prepare(
      `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
        description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
       VALUES ('phantom', 'zonito', 'Main', '2022-09-10', '2022-09', 'Frn* Hold.free-Now.com',
        'Frn* Hold.free-Now.com', -1650, 0, 'GBP', 0, 'spend', NULL)`,
    ).run();
    expect(ensureFreshStore(db)).toBe(true);
    const result = ingestAccount(db, "zonito", "Main", fixtureDataDir());
    expect(result.rowsSeen).toBe(1); // the REVERTED row never lands
    const rows = db
      .prepare("SELECT merchant, movement FROM transactions")
      .all() as { merchant: string; movement: string }[];
    expect(rows).toEqual([{ merchant: "Ocado", movement: "spend" }]);
    db.close();
  });
});
