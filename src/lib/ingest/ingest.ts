import { readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
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
  type MoneyMovement,
  type SavingsRow,
  type StatementRow,
} from "./parse";
import { openStoreFile, RULES_VERSION, STORE_FILENAME } from "./store";

export type IngestResult = {
  account: IngestAccount;
  rowsSeen: number;
  rowsAdded: number;
  balanceMinor: number | null;
  currency: string | null;
  discrepancy: string | null;
  /** False when this account's source file could not be read or parsed. */
  ok: boolean;
  /** The Originals file this account reads (null when none could be named). */
  file: string | null;
  /** Failure detail when ok is false. */
  error?: string;
};

/**
 * The Originals file an account reads, by name only. Throws when the
 * Originals folder cannot be listed or holds no matching file.
 */
export function findOriginalFile(
  dataDir: string,
  account: IngestAccount,
): string {
  const dir = join(dataDir, "Originals");
  const files = readdirSync(dir).filter((f) => f.endsWith(".csv"));
  if (isSavingsAccount(account)) {
    const tag = account.split("-")[1]!;
    const match = files.find((f) => f.includes("savings") && f.includes(tag));
    if (!match) throw new Error(`no Originals savings file for ${account}`);
    return match;
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
  return match;
}

function readOriginals(
  dataDir: string,
  account: IngestAccount,
): { rows: StatementRow[] | SavingsRow[]; file: string } {
  const file = findOriginalFile(dataDir, account);
  const text = readFileSync(join(dataDir, "Originals", file), "utf8");
  return {
    rows: isSavingsAccount(account) ? parseSavingsCsv(text) : parseAccountCsv(text),
    file,
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
  const { rows, file } = readOriginals(dataDir, account);
  // A found file that parses to nothing is not an empty statement, it is
  // a corrupt or wrong-format export (a real export always has ≥1 row):
  // fail this account by name instead of silently recording a no-op run
  // with rowsSeen 0. ingestAccountSafe turns this throw into the named
  // per-account failure.
  if (rows.length === 0) {
    throw new Error(
      `${file}: no transactions parsed — the file does not look like a ${isSavingsAccount(account) ? "savings" : "statement"} export`,
    );
  }
  // Merchants the user has personally corrected: an outgoing transfer to
  // one of them is real spending, not money moved aside, so it ingests as
  // spend from the start. Read once per account ingest; a store rebuild
  // carries merchant memory into its temp store before ingesting, so the
  // rule applies there too with no extra plumbing.
  const userCorrected = new Set(
    (
      db
        .prepare("SELECT merchant FROM merchant_memory WHERE source = 'user'")
        .all() as { merchant: string }[]
    ).map((r) => r.merchant),
  );
  const learnedMovement = (
    movement: MoneyMovement,
    amountMinor: number,
    merchant: string,
  ): MoneyMovement =>
    movement === "aside" && amountMinor < 0 && userCorrected.has(merchant)
      ? "spend"
      : movement;
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
      const merchant = merchantOf(r.description);
      const movement = learnedMovement(
        classifyMovement(
          r.description.toLowerCase().includes("interest")
            ? "interest"
            : "deposit",
          r.description,
          amountMinor,
          "GBP",
        ),
        amountMinor,
        merchant,
      );
      items.push([
        savingsFingerprint(account, r),
        person,
        account,
        savingsIsoDate(r.date),
        monthOf(savingsIsoDate(r.date)),
        r.description,
        merchant,
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
      const merchant = merchantOf(r.description);
      const movement = learnedMovement(
        classifyMovement(
          r.type,
          r.description,
          amountMinor,
          r.currency,
          r.state,
        ),
        amountMinor,
        merchant,
      );
      items.push([
        statementFingerprint(account, r),
        person,
        account,
        effective,
        monthOf(effective),
        r.description,
        merchant,
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
  return {
    account,
    rowsSeen,
    rowsAdded,
    balanceMinor,
    currency,
    discrepancy,
    ok: true,
    file,
  };
}

/**
 * ingestAccount with per-file fault tolerance: a source file that cannot
 * be read or parsed (a Google Drive placeholder that has not materialised
 * is the classic case) fails THIS account only, named in the result, and
 * never aborts the other accounts. The failed attempt is recorded in
 * ingest_runs so the ingest status shows it.
 */
export function ingestAccountSafe(
  db: import("better-sqlite3").Database,
  person: string,
  account: IngestAccount,
  dataDir: string,
): IngestResult {
  let file: string | null = null;
  try {
    file = findOriginalFile(dataDir, account);
  } catch {
    // No name could be determined; the read below fails with the detail.
  }
  try {
    return ingestAccount(db, person, account, dataDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      db.prepare(
        `INSERT INTO ingest_runs (account, started_at, rows_seen, rows_added, balance_minor, currency, discrepancy)
         VALUES (?, ?, 0, 0, NULL, NULL, ?)`,
      ).run(
        account,
        new Date().toISOString(),
        `ingest failed${file ? ` for ${file}` : ""}: ${message}`,
      );
    } catch {
      // Recording the failure must never mask the failure itself.
    }
    return {
      account,
      rowsSeen: 0,
      rowsAdded: 0,
      balanceMinor: null,
      currency: null,
      discrepancy: null,
      ok: false,
      file,
      error: message,
    };
  }
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

/** Ingest every account, each fault-tolerant (see ingestAccountSafe). */
export function ingestAccounts(
  db: import("better-sqlite3").Database,
  dataDir: string,
  person = "zonito",
): IngestResult[] {
  return INGEST_ACCOUNTS.map((account) =>
    ingestAccountSafe(db, person, account, dataDir),
  );
}

function storedRulesVersion(
  db: import("better-sqlite3").Database,
): string | null {
  const row = db
    .prepare("SELECT value FROM meta WHERE key = 'rules_version'")
    .get() as { value: string } | undefined;
  return row?.value ?? null;
}

const TXN_COLUMNS =
  "fingerprint, person, account, effective_date, year_month, description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category, source, created_at";
const AGG_COLUMNS =
  "person, year_month, category, currency, spend_minor, income_minor, aside_minor, txn_count";
const RUN_COLUMNS =
  "account, started_at, rows_seen, rows_added, balance_minor, currency, discrepancy, finished_at";
const MEMORY_COLUMNS = "merchant, category, colour, icon, source, updated_at";

/**
 * Merchant memory is NOT derived from the CSVs (rules, claude-api, molang
 * and user corrections), so a rebuild must not lose it. The rebuild's temp
 * store gets a copy up front so its ingest computes aggregates against the
 * same categories the live store would.
 */
function carryMerchantMemory(
  from: import("better-sqlite3").Database,
  to: import("better-sqlite3").Database,
): void {
  const rows = from
    .prepare(`SELECT ${MEMORY_COLUMNS} FROM merchant_memory`)
    .all() as Record<string, unknown>[];
  if (rows.length === 0) return;
  const insert = to.prepare(
    `INSERT OR REPLACE INTO merchant_memory (${MEMORY_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const copy = to.transaction((items: Record<string, unknown>[]) => {
    for (const r of items) {
      insert.run(
        r["merchant"],
        r["category"],
        r["colour"],
        r["icon"],
        r["source"],
        r["updated_at"],
      );
    }
  });
  copy(rows);
}

function removeStoreFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(path + suffix, { force: true });
    } catch {
      // best effort: a leftover temp file is inert
    }
  }
}

/**
 * Self-heal across classification-rule changes, atomically. The
 * transactions and month_aggregates tables are a cache of the source
 * CSVs; when the stored rules version differs from RULES_VERSION they are
 * rebuilt under the current rules — but never by purging in place (the
 * 30 Oct 2026 incident: a purge committed, then the rebuild died on an
 * unreadable Google Drive file and left the live store near-empty).
 *
 * Instead the whole ingest runs into a TEMPORARY store file beside the
 * live one, with the live store's merchant memory carried into it first.
 * Only when every account ingested cleanly are the rebuilt tables copied
 * into the live store, inside a single transaction; the live file itself
 * is never replaced, so the long-lived handle every caller holds (the API
 * layer caches one connection) stays valid and the live store's own meta
 * and ingest_runs history survive, with the rebuild's runs appended and a
 * "__rebuild__" marker row recorded, as before. On any account failure
 * the temp file is deleted, the live store is left exactly as it was
 * (still stamped with the old rules version, so the next ingest retries
 * the rebuild), and the results name the failed account's file.
 */
function rebuildStore(
  db: import("better-sqlite3").Database,
  dataDir: string,
  person: string,
): IngestResult[] {
  const livePath = db.name;
  if (!livePath || livePath === ":memory:") {
    // No file to protect: an in-memory store is rebuilt by the ingest
    // itself (INSERT OR IGNORE cannot resurrect purged rows, so purge
    // first, as the pre-atomic code did).
    db.exec("DELETE FROM transactions; DELETE FROM month_aggregates;");
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('rules_version', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ).run(String(RULES_VERSION));
    return ingestAccounts(db, dataDir, person);
  }
  const stored = storedRulesVersion(db);
  const tmpPath = join(dirname(livePath), `${STORE_FILENAME}.rebuild`);
  removeStoreFiles(tmpPath);
  const tmp = openStoreFile(tmpPath);
  let results: IngestResult[];
  try {
    carryMerchantMemory(db, tmp);
    results = ingestAccounts(tmp, dataDir, person);
    tmp.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    tmp.close();
  }
  if (results.some((r) => !r.ok)) {
    removeStoreFiles(tmpPath);
    return results;
  }
  const swap = db.transaction(() => {
    db.exec("DELETE FROM transactions; DELETE FROM month_aggregates;");
    db.exec(
      `INSERT INTO transactions (${TXN_COLUMNS})
       SELECT ${TXN_COLUMNS} FROM rebuild_src.transactions`,
    );
    db.exec(
      `INSERT INTO month_aggregates (${AGG_COLUMNS})
       SELECT ${AGG_COLUMNS} FROM rebuild_src.month_aggregates`,
    );
    db.exec(
      `INSERT INTO ingest_runs (${RUN_COLUMNS})
       SELECT ${RUN_COLUMNS} FROM rebuild_src.ingest_runs`,
    );
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('rules_version', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ).run(String(RULES_VERSION));
    db.prepare(
      `INSERT INTO ingest_runs (account, started_at, rows_seen, rows_added, balance_minor, currency, discrepancy)
       VALUES ('__rebuild__', ?, 0, 0, NULL, NULL, ?)`,
    ).run(
      new Date().toISOString(),
      `store rebuilt: rules version ${stored ?? "none"} -> ${RULES_VERSION}; rebuilt in a temp store and swapped in atomically`,
    );
  });
  db.exec(`ATTACH '${tmpPath.replace(/'/g, "''")}' AS rebuild_src`);
  try {
    swap();
  } finally {
    db.exec("DETACH rebuild_src");
    removeStoreFiles(tmpPath);
  }
  return results;
}

export function ingestAll(
  db: import("better-sqlite3").Database,
  dataDir: string,
  person = "zonito",
): IngestResult[] {
  if (storedRulesVersion(db) === String(RULES_VERSION)) {
    return ingestAccounts(db, dataDir, person);
  }
  return rebuildStore(db, dataDir, person);
}
