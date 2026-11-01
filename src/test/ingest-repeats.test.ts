import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ingestAccounts,
  type IngestResult,
} from "@/lib/ingest/ingest";
import {
  parseAccountCsv,
  statementFingerprint,
  statementRepeatFingerprint,
} from "@/lib/ingest/parse";
import { openStore } from "@/lib/ingest/store";

/**
 * Genuine within-file repeats (live bug, 1 Nov 2026): a Barclays
 * statement row carries a midnight timestamp and no balance, so
 * separate events can be byte-identical — the live file holds groups
 * of 8 and 9 identical £250 cash withdrawals in a day, and statement
 * balances reconcile only with every repeat counted. The ingest
 * fingerprint used to collapse each group to one row (32 real rows,
 * £7,850, missing from the live store). These tests pin the fix:
 * occurrence N ≥ 2 of an identical row in one file stores as its own
 * transaction with its own stable id, the first occurrence keeps the
 * fingerprint it has always had, and re-ingests change nothing.
 * Every name and amount here is synthetic.
 */

const HEADER =
  "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance";

const row = (
  type: string,
  product: string,
  date: string,
  description: string,
  amount: string,
  balance = "",
): string =>
  `${type},${product},${date} 00:00:00,${date} 00:00:00,${description},${amount},0.00,GBP,COMPLETED,${balance}`;

/** A minimal Revolut Main export (Zonito's, by the f5660e hint).
 * August dates, so September aggregates below are Barclays-only. */
const REVOLUT_MAIN = [
  HEADER,
  row("Deposit", "Main", "2026-08-10", "Bank transfer deposit", "500.00", "500.00"),
  row("Card Payment", "Main", "2026-08-06", "EXAMPLE COFFEE", "-4.50", "495.50"),
].join("\n");

const ATM_LINE = row(
  "Cash Withdrawal",
  "Current",
  "2026-09-14",
  "EXAMPLE ATM WITHDRAWAL 14SEP",
  "-250.00",
);

const barclaysFile = (atmCopies: number): string =>
  [
    HEADER,
    row("Transfer", "Current", "2026-09-28", "EXAMPLE EMPLOYER LTD BGC", "4500.00"),
    ...Array.from({ length: atmCopies }, () => ATM_LINE),
    row("Direct Debit", "Current", "2026-09-15", "EXAMPLE UTILITIES LTD DDR", "-100.00"),
  ].join("\n");

const BARCLAYS_PATH = "Zonito/Barclay/Barclaycard/barclaycard-full-history.csv";

function makeDataDir(atmCopies: number): string {
  const dir = mkdtempSync(join(tmpdir(), "chitra-repeats-data-"));
  mkdirSync(join(dir, "Originals"), { recursive: true });
  mkdirSync(join(dir, "Zonito", "Barclay", "Barclaycard"), {
    recursive: true,
  });
  writeFileSync(
    join(dir, "Originals", "account-statement_f5660e.csv"),
    REVOLUT_MAIN,
  );
  writeFileSync(join(dir, BARCLAYS_PATH), barclaysFile(atmCopies));
  return dir;
}

function makeStore() {
  return openStore(mkdtempSync(join(tmpdir(), "chitra-repeats-store-")));
}

const byAccount = (results: IngestResult[], account: string) =>
  results.find((r) => r.account === account);

const atmIds = (db: ReturnType<typeof makeStore>): string[] =>
  (
    db
      .prepare(
        `SELECT fingerprint FROM transactions
         WHERE account = 'Barclays Current' AND description = 'EXAMPLE ATM WITHDRAWAL 14SEP'
         ORDER BY rowid`,
      )
      .all() as { fingerprint: string }[]
  ).map((r) => r.fingerprint);

const atmBaseFingerprint = (): string => {
  const parsed = parseAccountCsv(barclaysFile(1)).find(
    (r) => r.description === "EXAMPLE ATM WITHDRAWAL 14SEP",
  )!;
  return statementFingerprint("Barclays Current", parsed);
};

describe("ingest of genuine within-file repeats", () => {
  it("stores every copy: 4 identical rows become 4 transactions with distinct, stable ids", () => {
    const db = makeStore();
    const dir = makeDataDir(4);
    const first = ingestAccounts(db, dir);
    const current = byAccount(first, "Barclays Current")!;
    expect(current.ok).toBe(true);
    expect(current.rowsSeen).toBe(6);
    expect(current.rowsAdded).toBe(6);

    const count = db
      .prepare(
        "SELECT COUNT(*) AS n FROM transactions WHERE account = 'Barclays Current'",
      )
      .get() as { n: number };
    expect(count.n).toBe(6);

    // The first occurrence keeps the exact pre-fix fingerprint; the
    // repeats derive from it in file order.
    const base = atmBaseFingerprint();
    expect(atmIds(db)).toEqual([
      base,
      statementRepeatFingerprint(base, 2),
      statementRepeatFingerprint(base, 3),
      statementRepeatFingerprint(base, 4),
    ]);

    // Aggregates count all four withdrawals: September GBP spend is
    // 4 × £250 ATM + £100 direct debit, over 6 stored transactions
    // (the Revolut fixture rows are August, so September is purely
    // this account's).
    const agg = db
      .prepare(
        `SELECT COALESCE(SUM(spend_minor), 0) AS spend,
                COALESCE(SUM(txn_count), 0) AS n
         FROM month_aggregates
         WHERE person = 'zonito' AND year_month = '2026-09' AND currency = 'GBP'`,
      )
      .get() as { spend: number; n: number };
    expect(agg.spend).toBe(110000);
    expect(agg.n).toBe(6);

    // A second ingest of the same file is a no-op: same ids, no adds.
    const idsBefore = atmIds(db);
    const second = ingestAccounts(db, dir);
    expect(byAccount(second, "Barclays Current")!.rowsAdded).toBe(0);
    expect(atmIds(db)).toEqual(idsBefore);
    const countAfter = db
      .prepare(
        "SELECT COUNT(*) AS n FROM transactions WHERE account = 'Barclays Current'",
      )
      .get() as { n: number };
    expect(countAfter.n).toBe(6);
    db.close();
  });

  it("an appended fifth copy adds exactly one transaction and leaves the first four ids untouched", () => {
    const db = makeStore();
    const dir = makeDataDir(4);
    ingestAccounts(db, dir);
    const before = atmIds(db);

    writeFileSync(join(dir, BARCLAYS_PATH), barclaysFile(5));
    const again = ingestAccounts(db, dir);
    expect(byAccount(again, "Barclays Current")!.rowsAdded).toBe(1);

    const after = atmIds(db);
    expect(after).toHaveLength(5);
    expect(after.slice(0, 4)).toEqual(before);
    expect(after[4]).toBe(statementRepeatFingerprint(atmBaseFingerprint(), 5));
    db.close();
  });

  it("leaves balance-carrying Revolut rows on their plain fingerprints", () => {
    const db = makeStore();
    ingestAccounts(db, makeDataDir(1));
    const mainRows = db
      .prepare(
        "SELECT fingerprint, description FROM transactions WHERE account = 'Main' ORDER BY rowid",
      )
      .all() as { fingerprint: string; description: string }[];
    const parsed = parseAccountCsv(REVOLUT_MAIN);
    expect(mainRows).toHaveLength(2);
    for (const stored of mainRows) {
      const source = parsed.find((r) => r.description === stored.description)!;
      expect(stored.fingerprint).toBe(statementFingerprint("Main", source));
    }
    db.close();
  });
});
