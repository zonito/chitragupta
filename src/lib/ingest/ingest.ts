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
import { RULES_VERSION } from "./store";

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

const SAVINGS_MONTHS: Record<string, string> = {
  Jan: "01",
  Feb: "02",
  Mar: "03",
  Apr: "04",
  May: "05",
  Jun: "06",
  Jul: "07",
  Aug: "08",
  Sep: "09",
  Oct: "10",
  Nov: "11",
  Dec: "12",
};

export function savingsIsoDate(dateStr: string): string {
  // Savings CSVs use "Jul 14, 2023" (quoted in the file, quotes stripped at
  // parse). Returns ISO YYYY-MM-DD; unparseable input passes through so the
  // row stays visible instead of silently vanishing.
  const m = dateStr.trim().match(/^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m) return dateStr.trim();
  const num = SAVINGS_MONTHS[m[1]!];
  if (!num) return dateStr.trim();
  return `${m[3]}-${num}-${String(Number(m[2])).padStart(2, "0")}`;
}

function monthOf(dateStr: string): string {
  const trimmed = dateStr.trim();
  const iso = trimmed.match(/^(\d{4})-(\d{2})-\d{2}/);
  if (iso) return `${iso[1]}-${iso[2]}`;
  const written = trimmed.match(/^([A-Za-z]{3})\s+\d{1,2},\s*(\d{4})$/);
  if (written) {
    const months: Record<string, string> = {
      Jan: "01",
      Feb: "02",
      Mar: "03",
      Apr: "04",
      May: "05",
      Jun: "06",
      Jul: "07",
      Aug: "08",
      Sep: "09",
      Oct: "10",
      Nov: "11",
      Dec: "12",
    };
    const num = months[written[1]!];
    if (num) return `${written[2]}-${num}`;
  }
  return trimmed.slice(0, 7);
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
        savingsIsoDate(r.date),
        monthOf(savingsIsoDate(r.date)),
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
    const arows = (rows as StatementRow[]).filter(
      (r) => r.state !== "REVERTED",
    );
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
        r.state,
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
    // rows_seen counts source rows that survive the REVERTED exclusion and
    // savings exact-dupe removal — i.e. rows the importer actually stores.
    isSavingsAccount(account)
      ? uniqueSavingsCount(rows as SavingsRow[], account)
      : (rows as StatementRow[]).filter((r) => r.state !== "REVERTED").length,
    rowsAdded,
    balanceMinor,
    currency,
    discrepancy,
  );

  recomputeAggregates(db, person);
  const rowsSeen = isSavingsAccount(account)
    ? uniqueSavingsCount(rows as SavingsRow[], account)
    : (rows as StatementRow[]).filter((r) => r.state !== "REVERTED").length;
  return { account, rowsSeen, rowsAdded, balanceMinor, currency, discrepancy };
}

export function recomputeAggregates(
  db: import("better-sqlite3").Database,
  person: string,
): void {
  // Category resolution order: explicit transaction category (user/molang
  // override or Muse classification) → merchant memory → movement fallback.
  db.prepare(`DELETE FROM month_aggregates WHERE person = ?`).run(person);
  db.prepare(
    `INSERT INTO month_aggregates (person, year_month, category, currency, spend_minor, income_minor, aside_minor, txn_count)
     SELECT t.person, t.year_month,
       COALESCE(t.category, m.category,
         CASE t.movement
           WHEN 'spend' THEN 'One-off' WHEN 'income' THEN 'One-off'
           WHEN 'aside' THEN 'Moved aside' WHEN 'fee' THEN 'Fees'
           WHEN 'interest' THEN 'Interest' ELSE 'Transfer' END),
       t.currency,
       SUM(CASE WHEN t.amount_minor < 0 AND t.movement = 'spend' THEN -t.amount_minor ELSE 0 END),
       SUM(CASE WHEN t.amount_minor > 0 AND t.movement = 'income' THEN t.amount_minor ELSE 0 END),
       SUM(CASE WHEN t.movement = 'aside' AND t.amount_minor < 0 THEN -t.amount_minor ELSE 0 END),
       COUNT(*)
     FROM transactions t LEFT JOIN merchant_memory m ON m.merchant = t.merchant
     WHERE t.person = ?
     GROUP BY t.person, t.year_month, t.currency,
       COALESCE(t.category, m.category,
         CASE t.movement
           WHEN 'spend' THEN 'One-off' WHEN 'income' THEN 'One-off'
           WHEN 'aside' THEN 'Moved aside' WHEN 'fee' THEN 'Fees'
           WHEN 'interest' THEN 'Interest' ELSE 'Transfer' END)`,
  ).run(person);
}

export function ingestAll(
  db: import("better-sqlite3").Database,
  dataDir: string,
  person = "zonito",
): IngestResult[] {
  void readdirSync;
  void statSync;
  ensureFreshStore(db);
  return INGEST_ACCOUNTS.map((account) =>
    ingestAccount(db, person, account, dataDir),
  );
}

/**
 * Self-heal across classification-rule changes. The transactions and
 * month_aggregates tables are a cache of the source CSVs; when the stored
 * rules version differs from RULES_VERSION, purge both and let the ingest
 * that follows rebuild them under the current rules. Merchant memory (rules,
 * claude-api, molang and user corrections) is NOT derived from the CSVs and
 * survives the purge untouched. The rebuild is recorded as an ingest_runs
 * row under the reserved account name "__rebuild__". Returns true when a
 * rebuild was triggered.
 */
export function ensureFreshStore(
  db: import("better-sqlite3").Database,
): boolean {
  const row = db
    .prepare("SELECT value FROM meta WHERE key = 'rules_version'")
    .get() as { value: string } | undefined;
  const stored = row?.value ?? null;
  if (stored === String(RULES_VERSION)) return false;
  const rebuild = db.transaction(() => {
    db.exec("DELETE FROM transactions; DELETE FROM month_aggregates;");
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('rules_version', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ).run(String(RULES_VERSION));
    db.prepare(
      `INSERT INTO ingest_runs (account, started_at, rows_seen, rows_added, balance_minor, currency, discrepancy)
       VALUES ('__rebuild__', ?, 0, 0, NULL, NULL, ?)`,
    ).run(
      new Date().toISOString(),
      `store rebuilt: rules version ${stored ?? "none"} -> ${RULES_VERSION}; transactions purged, re-ingested from source CSVs`,
    );
  });
  rebuild();
  return true;
}
