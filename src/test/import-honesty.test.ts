import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAccountCsv } from "@/lib/ingest/parse";
import { ingestAll, type IngestResult } from "@/lib/ingest/ingest";
import { openStore, RULES_VERSION } from "@/lib/ingest/store";
import { buildSnapshot } from "@/lib/snapshot.server";

/**
 * Phase B / B7 — import honesty:
 * (i) a corrupt statement fails by name instead of passing silently,
 * (ii) the savings 0-row guard,
 * (v) snapshot accounts describe the last content-bearing run.
 */

const ACCOUNT_HEADER =
  "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n";
const SAVINGS_HEADER = "Date,Description,Money out,Money in,Balance\n";

const FILES = {
  Main: "account-statement_2022_f5660e.csv",
  Pro: "account-statement_2022_01cac2.csv",
  "USD-Invest": "account-statement_2022_2151f7.csv",
  Joint: "account-statement_2022_bd9d00.csv",
  "Savings-9000000002": "savings-9000000002.csv",
  "Savings-9000000001": "savings-9000000001.csv",
} as const;

function fixtureDataDir(
  overrides: Partial<Record<keyof typeof FILES, string>> = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "chitra-b7-data-"));
  const originals = join(dir, "Originals");
  mkdirSync(originals, { recursive: true });
  const contents: Record<keyof typeof FILES, string> = {
    Main:
      ACCOUNT_HEADER +
      "Card Payment,Current,2026-10-03 10:00:00,2026-10-03 10:00:01,Ocado,-10.00,0.00,GBP,COMPLETED,990.00\n",
    Pro:
      ACCOUNT_HEADER +
      "Card Payment,Pro,2026-10-02 10:00:00,2026-10-02 10:00:01,Tesco,-5.00,0.00,GBP,COMPLETED,100.00\n",
    "USD-Invest":
      ACCOUNT_HEADER +
      "Card Payment,Invest,2026-10-02 10:00:00,2026-10-02 10:00:01,Netflix,-15.00,0.00,USD,COMPLETED,85.00\n",
    Joint:
      ACCOUNT_HEADER +
      "Card Payment,Joint,2026-10-02 10:00:00,2026-10-02 10:00:01,Waitrose,-7.50,0.00,GBP,COMPLETED,50.00\n",
    "Savings-9000000002":
      SAVINGS_HEADER + '"Oct 5, 2026",Deposit,,100.00,100.00\n',
    "Savings-9000000001":
      SAVINGS_HEADER + '"Oct 6, 2026",Deposit,,50.00,50.00\n',
    ...overrides,
  };
  for (const [account, file] of Object.entries(FILES)) {
    writeFileSync(
      join(originals, file),
      contents[account as keyof typeof FILES],
    );
  }
  return dir;
}

function currentStore() {
  const db = openStore(mkdtempSync(join(tmpdir(), "chitra-b7-store-")));
  db.prepare("INSERT INTO meta (key, value) VALUES ('rules_version', ?)").run(
    String(RULES_VERSION),
  );
  return db;
}

function byAccount(results: IngestResult[]): Map<string, IngestResult> {
  return new Map(results.map((r) => [r.account, r]));
}

describe("parseAccountCsv header validation (B7)", () => {
  it("throws on a garbage, headerless statement file", () => {
    expect(() =>
      parseAccountCsv("garbage,not a statement\nmore,garbage,here\n"),
    ).toThrow(/invalid statement header/);
    expect(() => parseAccountCsv("garbage\nmore garbage\n")).toThrow(
      /invalid statement header/,
    );
  });

  it("throws when the first row is data with no header at all", () => {
    expect(() =>
      parseAccountCsv(
        "Card Payment,Current,2026-10-03 10:00:00,2026-10-03 10:00:01,Ocado,-10.00,0.00,GBP,COMPLETED,990.00\n",
      ),
    ).toThrow(/invalid statement header/);
  });

  it("still parses a real export", () => {
    const rows = parseAccountCsv(
      ACCOUNT_HEADER +
        "Card Payment,Current,2026-10-03 10:00:00,2026-10-03 10:00:01,Ocado,-10.00,0.00,GBP,COMPLETED,990.00\n",
    );
    expect(rows).toHaveLength(1);
  });
});

describe("ingest guards (B7)", () => {
  it("a garbage account file is a named failure while other accounts succeed", () => {
    const db = currentStore();
    const results = ingestAll(
      db,
      fixtureDataDir({ Main: "garbage\nmore garbage\n" }),
    );
    const map = byAccount(results);

    const main = map.get("Main")!;
    expect(main.ok).toBe(false);
    expect(main.file).toBe(FILES.Main);
    expect(main.error).toBeTruthy();

    for (const account of [
      "Pro",
      "USD-Invest",
      "Joint",
      "Savings-9000000002",
      "Savings-9000000001",
    ]) {
      expect(map.get(account)!.ok, account).toBe(true);
    }
    const merchants = db
      .prepare("SELECT DISTINCT merchant FROM transactions")
      .all() as { merchant: string }[];
    expect(merchants.map((m) => m.merchant)).toContain("Tesco");
    db.close();
  });

  it("a header-valid statement with no rows fails naming the file (0-row guard)", () => {
    const db = currentStore();
    const results = ingestAll(
      db,
      fixtureDataDir({ Pro: ACCOUNT_HEADER }),
    );
    const pro = byAccount(results).get("Pro")!;
    expect(pro.ok).toBe(false);
    expect(pro.file).toBe(FILES.Pro);
    expect(pro.error).toContain(FILES.Pro);
    expect(pro.error).toContain("no transactions parsed");
    expect(pro.error).toContain("statement");
    db.close();
  });

  it("savings path: a garbage savings file hits the 0-row guard and fails by name", () => {
    const db = currentStore();
    const results = ingestAll(
      db,
      fixtureDataDir({ "Savings-9000000002": "garbage\nmore garbage\n" }),
    );
    const map = byAccount(results);
    const savings = map.get("Savings-9000000002")!;
    expect(savings.ok).toBe(false);
    expect(savings.file).toBe(FILES["Savings-9000000002"]);
    expect(savings.error).toContain(FILES["Savings-9000000002"]);
    expect(savings.error).toContain("no transactions parsed");
    expect(savings.error).toContain("savings");
    expect(map.get("Main")!.ok).toBe(true);
    db.close();
  });
});

describe("snapshot accounts semantics (B7)", () => {
  let dir: string | null = null;
  const prevEnv = process.env["CHITRAGUPTA_STORE_DIR"];

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
    if (prevEnv === undefined) delete process.env["CHITRAGUPTA_STORE_DIR"];
    else process.env["CHITRAGUPTA_STORE_DIR"] = prevEnv;
  });

  function seedStore() {
    dir = mkdtempSync(join(tmpdir(), "chitragupta-b7-snap-"));
    const db = openStore(dir);
    db.prepare(
      `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
         description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
       VALUES ('s1', 'zonito', 'Main', '2026-10-05', '2026-10', 'Ocado', 'Ocado', -1000, 0, 'GBP', 0, 'spend', NULL)`,
    ).run();
    const run = db.prepare(
      `INSERT INTO ingest_runs (account, started_at, rows_seen, rows_added, discrepancy)
       VALUES (?, ?, ?, ?, ?)`,
    );
    // Main: a real statement last week, then a no-op re-import today.
    run.run("Main", "2026-10-22T09:00:00.000Z", 5, 3, null);
    run.run("Main", "2026-10-30T09:00:00.000Z", 0, 0, null);
    // Pro: a real statement, then a failed run (rows_seen = 0).
    run.run("Pro", "2026-10-28T09:00:00.000Z", 4, 2, null);
    run.run(
      "Pro",
      "2026-10-30T09:00:00.000Z",
      0,
      0,
      "ingest failed for account-statement_2022_01cac2.csv: invalid statement header",
    );
    // The rebuild marker must never pose as an account.
    run.run("__rebuild__", "2026-10-30T10:00:00.000Z", 0, 0, "store rebuilt");
    db.close();
    process.env["CHITRAGUPTA_STORE_DIR"] = dir;
  }

  it("last/added come from the content-bearing run, not a later no-op, and stale is true", () => {
    seedStore();
    const snap = buildSnapshot();
    const main = snap.accounts.find((a) => a.name === "Revolut Main")!;
    expect(main).toBeTruthy();
    expect(main.last).toBe("22 Oct");
    expect(main.added).toBe(3);
    expect(main.stale).toBe(true);
  });

  it("a failed run does not become the account's last upload, and __rebuild__ is not an account", () => {
    seedStore();
    const snap = buildSnapshot();
    const pro = snap.accounts.find((a) => a.name === "Revolut Pro")!;
    expect(pro).toBeTruthy();
    expect(pro.last).toBe("28 Oct");
    expect(pro.added).toBe(2);
    expect(snap.accounts.map((a) => a.name)).not.toContain("__rebuild__");
  });
});
