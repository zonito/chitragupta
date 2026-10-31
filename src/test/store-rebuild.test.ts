import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ingestAll, type IngestResult } from "@/lib/ingest/ingest";
import { setMerchant } from "@/lib/ingest/merchants";
import { openStore, RULES_VERSION } from "@/lib/ingest/store";

const ACCOUNT_HEADER =
  "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n";

/** A complete tiny PersonalFinance dir: all six accounts, a few rows each. */
function fixtureDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chitra-data-"));
  const originals = join(dir, "Originals");
  mkdirSync(originals, { recursive: true });
  writeFileSync(
    join(originals, "account-statement_2022_f5660e.csv"),
    ACCOUNT_HEADER +
      "Card Payment,Current,2026-10-03 10:00:00,2026-10-03 10:00:01,Ocado,-10.00,0.00,GBP,COMPLETED,990.00\n" +
      "Card Payment,Current,2026-10-04 10:00:00,2026-10-04 10:00:01,Frn* Hold.free-Now.com,-16.50,0.00,GBP,REVERTED,\n",
  );
  writeFileSync(
    join(originals, "account-statement_2022_01cac2.csv"),
    ACCOUNT_HEADER +
      "Card Payment,Pro,2026-10-02 10:00:00,2026-10-02 10:00:01,Tesco,-5.00,0.00,GBP,COMPLETED,100.00\n",
  );
  writeFileSync(
    join(originals, "account-statement_2022_2151f7.csv"),
    ACCOUNT_HEADER +
      "Card Payment,Invest,2026-10-02 10:00:00,2026-10-02 10:00:01,Netflix,-15.00,0.00,USD,COMPLETED,85.00\n",
  );
  writeFileSync(
    join(originals, "account-statement_2022_bd9d00.csv"),
    ACCOUNT_HEADER +
      "Card Payment,Joint,2026-10-02 10:00:00,2026-10-02 10:00:01,Waitrose,-7.50,0.00,GBP,COMPLETED,50.00\n",
  );
  writeFileSync(
    join(originals, "savings-9000000002.csv"),
    'Date,Description,Money Out,Money In,Balance\n"Oct 5, 2026",Deposit,,100.00,100.00\n',
  );
  writeFileSync(
    join(originals, "savings-9000000001.csv"),
    'Date,Description,Money Out,Money In,Balance\n"Oct 6, 2026",Deposit,,50.00,50.00\n',
  );
  return dir;
}

/** The good fixture, except the Pro "file" is a directory: reading it fails reliably for any user. */
function brokenDataDir(): string {
  const src = fixtureDataDir();
  const dir = mkdtempSync(join(tmpdir(), "chitra-data-broken-"));
  cpSync(src, dir, { recursive: true });
  const pro = join(dir, "Originals", "account-statement_2022_01cac2.csv");
  rmSync(pro, { force: true });
  mkdirSync(pro, { recursive: true });
  return dir;
}

function txnDump(db: ReturnType<typeof openStore>): string {
  const rows = db
    .prepare("SELECT * FROM transactions ORDER BY fingerprint")
    .all();
  return JSON.stringify(rows);
}

function stamp(db: ReturnType<typeof openStore>): string | null {
  const row = db
    .prepare("SELECT value FROM meta WHERE key = 'rules_version'")
    .get() as { value: string } | undefined;
  return row?.value ?? null;
}

function rebuildMarkers(db: ReturnType<typeof openStore>): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM ingest_runs WHERE account = '__rebuild__'")
    .get() as { n: number };
  return row.n;
}

function byAccount(results: IngestResult[]): Map<string, IngestResult> {
  return new Map(results.map((r) => [r.account, r]));
}

describe("atomic store rebuild (rules-version change)", () => {
  it("rebuilds under current rules, keeps merchant memory, drops stale rows", () => {
    const db = openStore(mkdtempSync(join(tmpdir(), "chitra-store-")));
    // A store built by older rules: a phantom row no current rule produces,
    // stamped with an old rules version.
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

    const results = ingestAll(db, fixtureDataDir());
    expect(results.every((r) => r.ok)).toBe(true);
    expect(byAccount(results).get("Main")).toMatchObject({
      rowsSeen: 1, // the REVERTED row never lands
      rowsAdded: 1,
      file: "account-statement_2022_f5660e.csv",
    });

    const merchants = db
      .prepare("SELECT DISTINCT merchant FROM transactions ORDER BY merchant")
      .all() as { merchant: string }[];
    expect(merchants.map((m) => m.merchant)).not.toContain(
      "Frn* Hold.free-Now.com",
    );
    expect(merchants.map((m) => m.merchant)).toContain("Ocado");

    const memory = db
      .prepare(
        "SELECT category, source FROM merchant_memory WHERE merchant = 'Ocado'",
      )
      .get() as { category: string; source: string };
    expect(memory).toEqual({ category: "Groceries", source: "user" });
    expect(stamp(db)).toBe(String(RULES_VERSION));
    expect(rebuildMarkers(db)).toBe(1);

    // Second ingest is a plain incremental one: no second rebuild.
    const again = ingestAll(db, fixtureDataDir());
    expect(again.every((r) => r.ok)).toBe(true);
    expect(rebuildMarkers(db)).toBe(1);
    db.close();
  });

  it("leaves the store byte-for-byte intact when a rebuild file is unreadable", () => {
    const storeDir = mkdtempSync(join(tmpdir(), "chitra-store-"));
    const db = openStore(storeDir);
    const first = ingestAll(db, fixtureDataDir());
    expect(first.every((r) => r.ok)).toBe(true);
    const before = txnDump(db);
    expect(before).not.toBe("[]");
    expect(rebuildMarkers(db)).toBe(1);

    // Force a rebuild (rules version regresses) against a data dir whose
    // Pro file cannot be read.
    db.prepare("UPDATE meta SET value = '0' WHERE key = 'rules_version'").run();
    const results = ingestAll(db, brokenDataDir());

    const pro = byAccount(results).get("Pro")!;
    expect(pro.ok).toBe(false);
    expect(pro.file).toBe("account-statement_2022_01cac2.csv");
    expect(pro.error).toBeTruthy();
    // Every other account was still attempted (into the temp store).
    expect(
      results.filter((r) => r.account !== "Pro").every((r) => r.ok),
    ).toBe(true);

    // The live store is exactly as it was: same rows, still stamped with
    // the old version so the next ingest retries the rebuild, and no new
    // rebuild marker was recorded.
    expect(txnDump(db)).toBe(before);
    expect(stamp(db)).toBe("0");
    expect(rebuildMarkers(db)).toBe(1);
    db.close();
  });
});

describe("per-file fault tolerance (normal ingest)", () => {
  it("ingests the good accounts and names the bad account's file", () => {
    const db = openStore(mkdtempSync(join(tmpdir(), "chitra-store-")));
    // A current-version store: this ingest takes the normal path.
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('rules_version', ?)",
    ).run(String(RULES_VERSION));

    const results = ingestAll(db, brokenDataDir());
    const map = byAccount(results);

    const main = map.get("Main")!;
    expect(main.ok).toBe(true);
    expect(main.rowsAdded).toBe(1);
    expect(main.file).toBe("account-statement_2022_f5660e.csv");

    const pro = map.get("Pro")!;
    expect(pro.ok).toBe(false);
    expect(pro.file).toBe("account-statement_2022_01cac2.csv");
    expect(pro.error).toBeTruthy();

    // The good accounts' rows really landed.
    const merchants = db
      .prepare("SELECT DISTINCT merchant FROM transactions")
      .all() as { merchant: string }[];
    expect(merchants.map((m) => m.merchant)).toContain("Ocado");
    expect(merchants.map((m) => m.merchant)).not.toContain("Tesco");
    db.close();
  });
});
