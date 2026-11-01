import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverFiles,
  ingestAccounts,
  type IngestResult,
} from "@/lib/ingest/ingest";
import { openStore } from "@/lib/ingest/store";
import { detectIncomeRegulars, forecastEvents } from "@/lib/forecast";

/**
 * The Barclays integration over a fully synthetic data dir: an
 * invented employer paying a varying monthly salary into a Barclays
 * current account, transfers to an invented Revolut Main, a card
 * purchase and its settlement, and direct debits. Every name and
 * amount here is made up for this test.
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

/** A minimal Revolut Main export (Zonito's, by the f5660e hint). */
const REVOLUT_MAIN = [
  HEADER,
  row(
    "Deposit",
    "Main",
    "2026-09-10",
    "Bank transfer deposit",
    "500.00",
    "500.00",
  ),
  row(
    "Deposit",
    "Main",
    "2026-09-21",
    "Bank transfer deposit",
    "3000.00",
    "3500.00",
  ),
  row(
    "Card Payment",
    "Main",
    "2026-09-06",
    "EXAMPLE COFFEE",
    "-4.50",
    "3495.50",
  ),
].join("\n");

/** The prepared Barclays file: two products in one export. */
const BARCLAYS_FILE = [
  HEADER,
  // Current account: salary (varying ±25% around £4,500), a transfer
  // to his own Revolut, two direct debits (one is the card
  // settlement), a card payment. No Balance column values at all.
  row(
    "Transfer",
    "Current",
    "2026-08-28",
    "EXAMPLE EMPLOYER LTD BGC",
    "4000.00",
  ),
  row(
    "Transfer",
    "Current",
    "2026-09-20",
    "EXAMPLE NAME TO REVOLUT -ABCD- FT",
    "-3000.00",
  ),
  row(
    "Transfer",
    "Current",
    "2026-09-28",
    "EXAMPLE EMPLOYER LTD BGC",
    "5000.00",
  ),
  row(
    "Direct Debit",
    "Current",
    "2026-09-15",
    "EXAMPLE UTILITIES LTD DDR",
    "-100.00",
  ),
  row(
    "Direct Debit",
    "Current",
    "2026-09-16",
    "B/CARD PLAT VISA 0000000000000000 DDR",
    "-59.00",
  ),
  row(
    "Card Payment",
    "Current",
    "2026-09-05",
    "EXAMPLE SHOP ON 05 SEP BCC",
    "-25.00",
  ),
  row(
    "Transfer",
    "Current",
    "2026-10-28",
    "EXAMPLE EMPLOYER LTD BGC",
    "4500.00",
  ),
  // The card: one purchase, settled in full by direct debit. The
  // Balance column is −(owed), so the settlement returns it to 0.00.
  row(
    "Card Payment",
    "Barclaycard",
    "2026-09-03",
    "EXAMPLE STORE",
    "-59.00",
    "-59.00",
  ),
  row(
    "Transfer",
    "Barclaycard",
    "2026-09-16",
    "Payment By Direct Debit",
    "59.00",
    "0.00",
  ),
].join("\n");

function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chitra-barclays-data-"));
  mkdirSync(join(dir, "Originals"), { recursive: true });
  mkdirSync(join(dir, "Zonito", "Barclay", "Barclaycard"), {
    recursive: true,
  });
  writeFileSync(
    join(dir, "Originals", "account-statement_f5660e.csv"),
    REVOLUT_MAIN,
  );
  writeFileSync(
    join(
      dir,
      "Zonito",
      "Barclay",
      "Barclaycard",
      "barclaycard-full-history.csv",
    ),
    BARCLAYS_FILE,
  );
  return dir;
}

function makeStore() {
  return openStore(mkdtempSync(join(tmpdir(), "chitra-barclays-store-")));
}

const byAccount = (results: IngestResult[], account: string) =>
  results.find((r) => r.account === account);

describe("Barclays discovery and account mapping", () => {
  it("discovers the one file as two Zonito accounts, split by Product", () => {
    const db = makeStore();
    const { assignments } = discoverFiles(db, makeDataDir());
    const barclays = assignments.filter((a) => a.relPath);
    expect(barclays).toHaveLength(2);
    expect(barclays.map((a) => a.account).sort()).toEqual([
      "Barclaycard",
      "Barclays Current",
    ]);
    for (const a of barclays) {
      expect(a.person).toBe("zonito");
      expect(a.file).toBe("barclaycard-full-history.csv");
      expect(a.relPath).toBe(
        "Zonito/Barclay/Barclaycard/barclaycard-full-history.csv",
      );
    }
    expect(
      barclays.find((a) => a.account === "Barclays Current")!.product,
    ).toBe("Current");
    expect(barclays.find((a) => a.account === "Barclaycard")!.product).toBe(
      "Barclaycard",
    );
    db.close();
  });

  it("ingests each product as its own account with its own row count", () => {
    const db = makeStore();
    const results = ingestAccounts(db, makeDataDir());
    const current = byAccount(results, "Barclays Current")!;
    const card = byAccount(results, "Barclaycard")!;
    expect(current.ok).toBe(true);
    expect(card.ok).toBe(true);
    expect(current.rowsSeen).toBe(7);
    expect(card.rowsSeen).toBe(2);
    const counts = db
      .prepare(
        "SELECT account, COUNT(*) AS n FROM transactions GROUP BY account",
      )
      .all() as { account: string; n: number }[];
    expect(counts.find((c) => c.account === "Barclays Current")!.n).toBe(7);
    expect(counts.find((c) => c.account === "Barclaycard")!.n).toBe(2);
    db.close();
  });

  it("records the card's balance from its Balance column and leaves the current account's unknown", () => {
    const db = makeStore();
    const results = ingestAccounts(db, makeDataDir());
    // The card's latest row closes at 0.00 owed: a real recorded
    // balance of zero, not an unknown.
    expect(byAccount(results, "Barclaycard")!.balanceMinor).toBe(0);
    expect(byAccount(results, "Barclaycard")!.currency).toBe("GBP");
    // The current account export has no Balance values at all: the
    // balance stays NULL (not recorded), never a fabricated £0.00.
    expect(byAccount(results, "Barclays Current")!.balanceMinor).toBeNull();
    const run = db
      .prepare(
        "SELECT balance_minor FROM ingest_runs WHERE account = 'Barclays Current'",
      )
      .get() as { balance_minor: number | null };
    expect(run.balance_minor).toBeNull();
    db.close();
  });
});

describe("Barclays movement mapping and transfer matching", () => {
  const movementOf = (
    db: ReturnType<typeof makeStore>,
    description: string,
    account?: string,
  ): string =>
    (
      db
        .prepare(
          `SELECT movement FROM transactions WHERE description = ?${
            account ? " AND account = ?" : ""
          }`,
        )
        .get(...(account ? [description, account] : [description])) as {
        movement: string;
      }
    ).movement;

  it("maps current-account rows: salary income, debits spend, own-account moves aside", () => {
    const db = makeStore();
    ingestAccounts(db, makeDataDir());
    // Employer credits are income.
    const salary = db
      .prepare(
        "SELECT COUNT(*) AS n FROM transactions WHERE account = 'Barclays Current' AND description = 'EXAMPLE EMPLOYER LTD BGC' AND movement = 'income'",
      )
      .get() as { n: number };
    expect(salary.n).toBe(3);
    // Direct debits and card payments are spend under their merchants.
    expect(movementOf(db, "EXAMPLE UTILITIES LTD DDR")).toBe("spend");
    expect(movementOf(db, "EXAMPLE SHOP ON 05 SEP BCC")).toBe("spend");
    // The transfer to his own Revolut is Moved aside, never income/spend.
    expect(movementOf(db, "EXAMPLE NAME TO REVOLUT -ABCD- FT")).toBe("aside");
    db.close();
  });

  it("treats the card settlement as Moved aside on BOTH sides; the purchase is the spend", () => {
    const db = makeStore();
    ingestAccounts(db, makeDataDir());
    expect(
      movementOf(
        db,
        "B/CARD PLAT VISA 0000000000000000 DDR",
        "Barclays Current",
      ),
    ).toBe("aside");
    expect(movementOf(db, "Payment By Direct Debit", "Barclaycard")).toBe(
      "aside",
    );
    expect(movementOf(db, "EXAMPLE STORE", "Barclaycard")).toBe("spend");
    db.close();
  });

  it("matches the Revolut Deposit against the Barclays outflow so the money nets to zero", () => {
    const db = makeStore();
    ingestAccounts(db, makeDataDir());
    // The £3,000 Deposit of 21 Sep (Barclays sent £3,000 on 20 Sep)
    // is now Moved aside; the unmatched £500 Deposit stays income.
    const deposits = db
      .prepare(
        "SELECT effective_date, movement FROM transactions WHERE account = 'Main' AND description = 'Bank transfer deposit' ORDER BY effective_date",
      )
      .all() as { effective_date: string; movement: string }[];
    expect(deposits.map((d) => d.movement)).toEqual(["income", "aside"]);
    // Household September: income is the £5,000 salary + the £500
    // unmatched deposit only — the matched £3,000 contributes £0.
    // Spend is utilities £100 + shop £25 + card purchase £59 +
    // coffee £4.50; the settlement pair contributes £0.
    const agg = db
      .prepare(
        "SELECT COALESCE(SUM(income_minor), 0) AS income, COALESCE(SUM(spend_minor), 0) AS spend FROM month_aggregates WHERE person = 'household' AND year_month = '2026-09' AND currency = 'GBP'",
      )
      .get() as { income: number; spend: number };
    expect(agg.income).toBe(550000);
    expect(agg.spend).toBe(18850);
    db.close();
  });

  it("the varying salary is an income regular for the forecast, so the no-income label is gone", () => {
    const db = makeStore();
    ingestAccounts(db, makeDataDir());
    // Exactly the rows the snapshot feeds the detector: GBP income.
    const incomeRows = db
      .prepare(
        "SELECT person, account, effective_date, merchant, amount_minor FROM transactions WHERE currency = 'GBP' AND movement = 'income' AND amount_minor > 0 ORDER BY effective_date",
      )
      .all() as {
      person: string;
      account: string;
      effective_date: string;
      merchant: string;
      amount_minor: number;
    }[];
    const regulars = detectIncomeRegulars(
      incomeRows.map((r) => ({
        merchant: r.merchant,
        date: r.effective_date,
        amountMinor: r.amount_minor,
        account: r.account,
        person: r.person,
      })),
      "2026-10-28",
    );
    const salary = regulars.find((r) => r.name === "EXAMPLE EMPLOYER LTD BGC");
    expect(salary).toBeDefined();
    // £4,000 / £5,000 / £4,500: no 7% cluster, so the median band
    // carries it, projected at the £4,500 median.
    expect(salary!.amount).toBe(4500);
    // forecastEvents is what decides the card's "No regular income
    // detected" label: with the salary detected, hasIncome is true.
    const { hasIncome } = forecastEvents(
      "household",
      [],
      regulars,
      "2026-10-28",
      "2026-10-31",
    );
    expect(hasIncome).toBe(true);
    db.close();
  });

  it("matching is idempotent: a second ingest flips nothing further", () => {
    const db = makeStore();
    const dataDir = makeDataDir();
    ingestAccounts(db, dataDir);
    ingestAccounts(db, dataDir);
    const agg = db
      .prepare(
        "SELECT COALESCE(SUM(income_minor), 0) AS income FROM month_aggregates WHERE person = 'household' AND year_month = '2026-09' AND currency = 'GBP'",
      )
      .get() as { income: number };
    expect(agg.income).toBe(550000);
    db.close();
  });
});

describe("Barclays discovery and account mapping", () => {
  it("is stable across re-ingests: same assignments, no duplicate rows", () => {
    const db = makeStore();
    const dataDir = makeDataDir();
    ingestAccounts(db, dataDir);
    const again = ingestAccounts(db, dataDir);
    expect(byAccount(again, "Barclays Current")!.rowsAdded).toBe(0);
    expect(byAccount(again, "Barclaycard")!.rowsAdded).toBe(0);
    const { assignments } = discoverFiles(db, dataDir);
    expect(assignments.filter((a) => a.relPath)).toHaveLength(2);
    const total = (
      db.prepare("SELECT COUNT(*) AS n FROM transactions").get() as {
        n: number;
      }
    ).n;
    expect(total).toBe(12);
    db.close();
  });
});
