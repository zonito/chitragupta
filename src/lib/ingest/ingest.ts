import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  INGEST_ACCOUNTS,
  classifyMovement,
  gbpPence,
  isSavingsAccount,
  parseAccountCsv,
  parseSavingsCsv,
  savingsFingerprint,
  statementFingerprint,
  type IngestAccount,
  type SavingsRow,
  type StatementRow,
} from "./parse";

export type IngestResult = {
  account: IngestAccount;
  rowsSeen: number;
  rowsAdded: number;
  balanceMinor: number | null;
  currency: string | null;
  discrepancy: string | null;
};

function readOriginals(
  dataDir: string,
  account: IngestAccount,
): { rows: StatementRow[] | SavingsRow[]; file: string } {
  const dir = join(dataDir, "Originals");
  const files = readdirSync(dir).filter((f) => f.endsWith(".csv"));
  if (isSavingsAccount(account)) {
    const tag = account.split("-")[1]!;
    const match = files.find((f) => f.includes("savings") && f.includes(tag));
    if (!match) throw new Error(`no Originals savings file for ${account}`);
    return {
      rows: parseSavingsCsv(readFileSync(join(dir, match), "utf8")),
      file: match,
    };
  }
  const productHint: Record<string, string[]> = {
    Main: ["f5660e"],
    Pro: ["01cac2"],
    "USD-Invest": ["2151f7"],
    Joint: ["bd9d00"],
  };
  const hints = productHint[account] ?? [];
  const match = files.find(
    (f) => f.includes("account-statement") && hints.some((h) => f.includes(h)),
  );
  if (!match) throw new Error(`no Originals account file for ${account}`);
  return {
    rows: parseAccountCsv(readFileSync(join(dir, match), "utf8")),
    file: match,
  };
}

function effectiveDateOf(r: StatementRow): string {
  return r.completedDate || r.startedDate;
}

function monthOf(dateStr: string): string {
  return dateStr.slice(0, 7);
}

function uniqueSavingsCount(
  rows: SavingsRow[],
  account: IngestAccount,
): number {
  const seen = new Set<string>();
  for (const r of rows) seen.add(savingsFingerprint(account, r));
  return seen.size;
}

export function merchantOf(description: string): string {
  return description
    .replace(/^(To|From|Transfer to|Transfer from|Payment from)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export function ingestAccount(
  db: import("better-sqlite3").Database,
  person: string,
  account: IngestAccount,
  dataDir: string,
): IngestResult {
  const { rows } = readOriginals(dataDir, account);
  const startedAt = new Date().toISOString();
  let rowsAdded = 0;
  let balanceMinor: number | null = null;
  let currency: string | null = null;
  let discrepancy: string | null = null;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO transactions
     (fingerprint, person, account, effective_date, year_month, description, merchant,
      amount_minor, fee_minor, currency, balance_minor, movement, category, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'ingest')`,
  );
  const runInsert = db.transaction(
    (items: Parameters<typeof insert.run>[0][]) => {
      let added = 0;
      for (const item of items) {
        const info = insert.run(...(item as unknown as []));
        added += Number(info.changes);
      }
      return added;
    },
  );

  if (isSavingsAccount(account)) {
    const srows = rows as SavingsRow[];
    const seen = new Set<string>();
    const unique: SavingsRow[] = [];
    for (const r of srows) {
      const fp = savingsFingerprint(account, r);
      if (seen.has(fp)) continue;
      seen.add(fp);
      unique.push(r);
    }
    const items: unknown[][] = [];
    let running: number | null = null;
    let mismatch = 0;
    for (const r of unique) {
      const inMinor = gbpPence(r.moneyIn);
      const outMinor = gbpPence(r.moneyOut);
      const balMinor = gbpPence(r.balance);
      if (running !== null && running + inMinor - outMinor !== balMinor)
        mismatch++;
      running = balMinor;
      const amountMinor = inMinor - outMinor;
      const movement = classifyMovement(
        r.description.toLowerCase().includes("interest")
          ? "interest"
          : "deposit",
        r.description,
        amountMinor,
        "GBP",
      );
      items.push([
        savingsFingerprint(account, r),
        person,
        account,
        r.date,
        monthOf(r.date),
        r.description,
        merchantOf(r.description),
        amountMinor,
        0,
        "GBP",
        balMinor,
        movement,
      ]);
    }
    if (mismatch > 0) {
      discrepancy = `balance chain breaks on ${mismatch} row(s); last balance kept`;
    }
    rowsAdded = runInsert(items as never);
    const last = unique[unique.length - 1];
    if (last) {
      balanceMinor = gbpPence(last.balance);
      currency = "GBP";
    }
  } else {
    const arows = rows as StatementRow[];
    const items: unknown[][] = [];
    const lastByCurrency = new Map<string, { date: string; bal: number }>();
    for (const r of arows) {
      const effective = effectiveDateOf(r);
      const amountMinor = gbpPence(r.amount);
      const feeMinor = gbpPence(r.fee);
      const balMinor = gbpPence(r.balance);
      const movement = classifyMovement(
        r.type,
        r.description,
        amountMinor,
        r.currency,
      );
      items.push([
        statementFingerprint(account, r),
        person,
        account,
        effective,
        monthOf(effective),
        r.description,
        merchantOf(r.description),
        amountMinor,
        feeMinor,
        r.currency,
        balMinor,
        movement,
      ]);
      const prev = lastByCurrency.get(r.currency);
      if (!prev || effective >= prev.date)
        lastByCurrency.set(r.currency, { date: effective, bal: balMinor });
    }
    rowsAdded = runInsert(items as never);
    const gbp = lastByCurrency.get("GBP");
    if (gbp) {
      balanceMinor = gbp.bal;
      currency = "GBP";
    } else {
      const first = [...lastByCurrency.entries()].sort((a, b) =>
        b[1].date.localeCompare(a[1].date),
      )[0];
      if (first) {
        balanceMinor = first[1].bal;
        currency = first[0];
      }
    }
  }

  db.prepare(
    `INSERT INTO ingest_runs (account, started_at, rows_seen, rows_added, balance_minor, currency, discrepancy)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    account,
    startedAt,
    isSavingsAccount(account)
      ? uniqueSavingsCount(rows as SavingsRow[], account)
      : rows.length,
    rowsAdded,
    balanceMinor,
    currency,
    discrepancy,
  );

  recomputeAggregates(db, person);
  const rowsSeen = isSavingsAccount(account)
    ? uniqueSavingsCount(rows as SavingsRow[], account)
    : rows.length;
  return { account, rowsSeen, rowsAdded, balanceMinor, currency, discrepancy };
}

export function recomputeAggregates(
  db: import("better-sqlite3").Database,
  person: string,
): void {
  db.prepare(`DELETE FROM month_aggregates WHERE person = ?`).run(person);
  db.prepare(
    `INSERT INTO month_aggregates (person, year_month, category, spend_minor, income_minor, aside_minor, txn_count)
     SELECT person, year_month,
       COALESCE(category, CASE movement WHEN 'spend' THEN 'One-off' WHEN 'income' THEN 'One-off' WHEN 'aside' THEN 'Moved aside' WHEN 'fee' THEN 'Fees' WHEN 'interest' THEN 'Interest' ELSE 'Transfer' END),
       SUM(CASE WHEN amount_minor < 0 AND movement IN ('spend') THEN -amount_minor ELSE 0 END),
       SUM(CASE WHEN amount_minor > 0 AND movement IN ('income') THEN amount_minor ELSE 0 END),
       SUM(CASE WHEN movement = 'aside' AND amount_minor < 0 THEN -amount_minor ELSE 0 END),
       COUNT(*)
     FROM transactions WHERE person = ?
     GROUP BY person, year_month, COALESCE(category, CASE movement WHEN 'spend' THEN 'One-off' WHEN 'income' THEN 'One-off' WHEN 'aside' THEN 'Moved aside' WHEN 'fee' THEN 'Fees' WHEN 'interest' THEN 'Interest' ELSE 'Transfer' END)`,
  ).run(person);
}

export function ingestAll(
  db: import("better-sqlite3").Database,
  dataDir: string,
  person = "zonito",
): IngestResult[] {
  void readdirSync;
  void statSync;
  return INGEST_ACCOUNTS.map((account) =>
    ingestAccount(db, person, account, dataDir),
  );
}
