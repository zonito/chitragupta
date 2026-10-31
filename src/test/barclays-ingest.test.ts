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
  row("Deposit", "Main", "2026-09-10", "Bank transfer deposit", "500.00", "500.00"),
  row("Deposit", "Main", "2026-09-21", "Bank transfer deposit", "3000.00", "3500.00"),
  row("Card Payment", "Main", "2026-09-06", "EXAMPLE COFFEE", "-4.50", "3495.50"),
].join("\n");

/** The prepared Barclays file: two products in one export. */
const BARCLAYS_FILE = [
  HEADER,
  // Current account: salary (varying ±25% around £4,500), a transfer
  // to his own Revolut, two direct debits (one is the card
  // settlement), a card payment. No Balance column values at all.
  row("Transfer", "Current", "2026-08-28", "EXAMPLE EMPLOYER LTD BGC", "4000.00"),
  row("Transfer", "Current", "2026-09-20", "EXAMPLE NAME TO REVOLUT -ABCD- FT", "-3000.00"),
  row("Transfer", "Current", "2026-09-28", "EXAMPLE EMPLOYER LTD BGC", "5000.00"),
  row("Direct Debit", "Current", "2026-09-15", "EXAMPLE UTILITIES LTD DDR", "-100.00"),
  row("Direct Debit", "Current", "2026-09-16", "B/CARD PLAT VISA 0000000000000000 DDR", "-59.00"),
  row("Card Payment", "Current", "2026-09-05", "EXAMPLE SHOP ON 05 SEP BCC", "-25.00"),
  row("Transfer", "Current", "2026-10-28", "EXAMPLE EMPLOYER LTD BGC", "4500.00"),
  // The card: one purchase, settled in full by direct debit. The
  // Balance column is −(owed), so the settlement returns it to 0.00.
  row("Card Payment", "Barclaycard", "2026-09-03", "EXAMPLE STORE", "-59.00", "-59.00"),
  row("Transfer", "Barclaycard", "2026-09-16", "Payment By Direct Debit", "59.00", "0.00"),
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
    join(dir, "Zonito", "Barclay", "Barclaycard", "barclaycard-full-history.csv"),
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
    expect(barclays.find((a) => a.account === "Barclays Current")!.product).toBe(
      "Current",
    );
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
