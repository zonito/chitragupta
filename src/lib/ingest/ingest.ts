import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
  statementRepeatFingerprint,
  type IngestAccount,
  type MoneyMovement,
  type SavingsRow,
  type StatementRow,
} from "./parse";
import { openStoreFile, RULES_VERSION, STORE_FILENAME } from "./store";

export type IngestResult = {
  /** Whose account this is — two people can both hold a "Pro". */
  person: string;
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

/** Where an assignment's rows come from, beyond the Originals default. */
export type IngestOptions = {
  /** File path relative to the data dir (the Barclays tree); absent
   * means the file sits in Originals under its bare name. */
  relPath?: string;
  /** Ingest only the rows whose Product column equals this value —
   * one prepared file can hold several accounts (the Barclays file
   * holds the current account and the credit card side by side). */
  product?: string;
};

function readOriginals(
  dataDir: string,
  account: IngestAccount,
  file?: string,
  opts?: IngestOptions,
): { rows: StatementRow[] | SavingsRow[]; file: string } {
  const name = file ?? findOriginalFile(dataDir, account);
  const path = opts?.relPath
    ? join(dataDir, opts.relPath)
    : join(dataDir, "Originals", name);
  const text = readFileSync(path, "utf8");
  return {
    rows: isSavingsAccount(account) ? parseSavingsCsv(text) : parseAccountCsv(text),
    file: name,
  };
}

function effectiveDateOf(r: StatementRow): string {
  return r.completedDate || r.startedDate;
}

/**
 * Movement adjustments for the two Barclays accounts, layered over
 * the shared classifier (which was written for Revolut's shapes).
 * A current account's life differs from a Revolut pocket's:
 *
 * - Barclays Current: any row naming Revolut is a move between his
 *   own accounts (transfers out, "Sent from Revolut" credits in,
 *   debit-card top-ups) — Moved aside, never income or spend. The
 *   direct debits that settle the Barclaycard ("B/CARD PLAT VISA …")
 *   are likewise aside: settling a card is not spending, the card's
 *   purchases are. Remaining positive Transfer rows are genuine
 *   credits (salary and other bank credits) and count as income;
 *   direct debits and card payments keep the classifier's spend.
 * - Barclaycard: its Transfer rows are the settlement credits
 *   ("Payment, Thank You", "Payment By Direct Debit") — Moved aside.
 *   Its Card Payment rows are purchases and stay spend.
 */
export function barclaysMovement(
  account: IngestAccount,
  type: string,
  description: string,
  amountMinor: number,
  base: MoneyMovement,
): MoneyMovement {
  const t = type.toLowerCase();
  const d = description.toLowerCase();
  if (account === "Barclaycard") {
    if (t === "transfer") return "aside";
    return base;
  }
  if (account === "Barclays Current") {
    if (/revolut/.test(d)) return "aside";
    if (/^b\/card/.test(d.trim())) return "aside";
    if (t === "transfer" && amountMinor > 0) return "income";
    return base;
  }
  return base;
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
  Sept: "09",
  Oct: "10",
  Nov: "11",
  Dec: "12",
};

export function savingsIsoDate(dateStr: string): string {
  // Savings CSVs use "Jul 14, 2023" (en-us exports, quoted in the file,
  // quotes stripped at parse) or "1 Feb 2026" / "1 Sept 2026" (en-sg
  // exports, day first). Returns ISO YYYY-MM-DD; unparseable input
  // passes through so the row stays visible instead of silently
  // vanishing.
  const trimmed = dateStr.trim();
  const us = trimmed.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})$/);
  if (us) {
    const num = SAVINGS_MONTHS[us[1]!];
    if (num) return `${us[3]}-${num}-${String(Number(us[2])).padStart(2, "0")}`;
    return trimmed;
  }
  const sg = trimmed.match(/^(\d{1,2})\s+([A-Za-z]{3,4})\s+(\d{4})$/);
  if (sg) {
    const num = SAVINGS_MONTHS[sg[2]!];
    if (num) return `${sg[3]}-${num}-${String(Number(sg[1])).padStart(2, "0")}`;
  }
  return trimmed;
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
  file?: string,
  opts?: IngestOptions,
): IngestResult {
  const { rows: parsedRows, file: readFile } = readOriginals(
    dataDir,
    account,
    file,
    opts,
  );
  // A multi-product file ingests one account at a time: keep only this
  // assignment's Product rows, so counts, balances and fingerprints
  // are all per-account from here on.
  const rows: StatementRow[] | SavingsRow[] = opts?.product
    ? (parsedRows as StatementRow[]).filter((r) => r.product === opts.product)
    : parsedRows;
  // A found file that parses to nothing is not an empty statement, it is
  // a corrupt or wrong-format export (a real export always has ≥1 row):
  // fail this account by name instead of silently recording a no-op run
  // with rowsSeen 0. ingestAccountSafe turns this throw into the named
  // per-account failure.
  if (rows.length === 0) {
    throw new Error(
      `${readFile}: no transactions parsed — the file does not look like a ${isSavingsAccount(account) ? "savings" : "statement"} export`,
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
    // Within-file occurrence counting for the fingerprint below: one
    // source file can hold genuinely separate rows that are
    // byte-identical (see statementRepeatFingerprint), and the plain
    // fingerprint would collapse them into a single stored
    // transaction. Occurrence is counted over this ingest's own row
    // stream — one file, already sliced to this account's Product,
    // REVERTED rows excluded — so a re-ingest of the same file
    // recomputes the same ids, and the store's INSERT OR IGNORE keeps
    // deduping across files and ingests exactly as before: a second
    // file carrying the same rows inserts nothing, and when two
    // overlapping files carry different repeat counts the union
    // converges to the richest file's multiplicity.
    const occurrences = new Map<string, number>();
    const lastByCurrency = new Map<string, { date: string; bal: number }>();
    for (const r of arows) {
      const effective = effectiveDateOf(r);
      const amountMinor = gbpPence(r.amount);
      const feeMinor = gbpPence(r.fee);
      const balMinor = gbpPence(r.balance);
      const merchant = merchantOf(r.description);
      const movement = learnedMovement(
        barclaysMovement(
          account,
          r.type,
          r.description,
          amountMinor,
          classifyMovement(
            r.type,
            r.description,
            amountMinor,
            r.currency,
            r.state,
          ),
        ),
        amountMinor,
        merchant,
      );
      const baseFingerprint = statementFingerprint(account, r);
      const occurrence = (occurrences.get(baseFingerprint) ?? 0) + 1;
      occurrences.set(baseFingerprint, occurrence);
      items.push([
        occurrence === 1
          ? baseFingerprint
          : statementRepeatFingerprint(baseFingerprint, occurrence),
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
      // Only a row that actually records a balance moves the account's
      // known balance: an export with no Balance column at all (the
      // Barclays current account) must stay "not recorded", never a
      // fabricated £0.00 from an empty cell.
      if (r.balance.trim() !== "") {
        const prev = lastByCurrency.get(r.currency);
        if (!prev || effective >= prev.date)
          lastByCurrency.set(r.currency, { date: effective, bal: balMinor });
      }
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
    `INSERT INTO ingest_runs (person, account, started_at, rows_seen, rows_added, balance_minor, currency, discrepancy)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    person,
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
    person,
    account,
    rowsSeen,
    rowsAdded,
    balanceMinor,
    currency,
    discrepancy,
    ok: true,
    file: readFile,
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
  file?: string,
  opts?: IngestOptions,
): IngestResult {
  let named: string | null = file ?? null;
  if (named === null) {
    try {
      named = findOriginalFile(dataDir, account);
    } catch {
      // No name could be determined; the read below fails with the detail.
    }
  }
  try {
    return ingestAccount(db, person, account, dataDir, file, opts);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      db.prepare(
        `INSERT INTO ingest_runs (person, account, started_at, rows_seen, rows_added, balance_minor, currency, discrepancy)
         VALUES (?, ?, ?, 0, 0, NULL, NULL, ?)`,
      ).run(
        person,
        account,
        new Date().toISOString(),
        `ingest failed${named ? ` for ${named}` : ""}: ${message}`,
      );
    } catch {
      // Recording the failure must never mask the failure itself.
    }
    return {
      person,
      account,
      rowsSeen: 0,
      rowsAdded: 0,
      balanceMinor: null,
      currency: null,
      discrepancy: null,
      ok: false,
      file: named,
      error: message,
    };
  }
}

const AGGREGATE_CATEGORY = `COALESCE(t.category, m.category,
         CASE t.movement
           WHEN 'spend' THEN 'One-off' WHEN 'income' THEN 'One-off'
           WHEN 'aside' THEN 'Moved aside' WHEN 'fee' THEN 'Fees'
           WHEN 'interest' THEN 'Interest' ELSE 'Transfer' END)`;

export function recomputeAggregates(
  db: import("better-sqlite3").Database,
  person: string,
): void {
  // Category resolution order: explicit transaction category (user/molang
  // override or Muse classification) → merchant memory → movement fallback.
  db.prepare(`DELETE FROM month_aggregates WHERE person = ?`).run(person);
  if (person === "household") {
    // Household rows are real stored aggregates over BOTH people's
    // transactions, summed per currency — never a second person's rows
    // relabelled, and never FX-converted into GBP.
    db.prepare(
      `INSERT INTO month_aggregates (person, year_month, category, currency, spend_minor, income_minor, aside_minor, txn_count)
       SELECT 'household', t.year_month, ${AGGREGATE_CATEGORY},
         t.currency,
         SUM(CASE WHEN t.amount_minor < 0 AND t.movement = 'spend' THEN -t.amount_minor ELSE 0 END),
         SUM(CASE WHEN t.amount_minor > 0 AND t.movement = 'income' THEN t.amount_minor ELSE 0 END),
         SUM(CASE WHEN t.movement = 'aside' AND t.amount_minor < 0 THEN -t.amount_minor ELSE 0 END),
         COUNT(*)
       FROM transactions t LEFT JOIN merchant_memory m ON m.merchant = t.merchant
       WHERE t.person <> 'household'
       GROUP BY t.year_month, t.currency, ${AGGREGATE_CATEGORY}`,
    ).run();
    return;
  }
  db.prepare(
    `INSERT INTO month_aggregates (person, year_month, category, currency, spend_minor, income_minor, aside_minor, txn_count)
     SELECT t.person, t.year_month, ${AGGREGATE_CATEGORY},
       t.currency,
       SUM(CASE WHEN t.amount_minor < 0 AND t.movement = 'spend' THEN -t.amount_minor ELSE 0 END),
       SUM(CASE WHEN t.amount_minor > 0 AND t.movement = 'income' THEN t.amount_minor ELSE 0 END),
       SUM(CASE WHEN t.movement = 'aside' AND t.amount_minor < 0 THEN -t.amount_minor ELSE 0 END),
       COUNT(*)
     FROM transactions t LEFT JOIN merchant_memory m ON m.merchant = t.merchant
     WHERE t.person = ?
     GROUP BY t.person, t.year_month, t.currency, ${AGGREGATE_CATEGORY}`,
  ).run(person);
}

/**
 * Cross-account transfer matching: now that the Barclays current
 * account is tracked, a Revolut top-up that came from it is visible
 * from BOTH sides — the "TO REVOLUT" outflow on the Barclays side
 * (already Moved aside at ingest) and the "Deposit" credit on the
 * Revolut side, which ingest counted as income because the source
 * used to be untracked. Pair them one-to-one (same absolute amount,
 * dates within ±3 days, greedy in date order, closest date first)
 * and mark the Revolut side Moved aside too, so the same money stops
 * counting as household income. A Deposit with no Barclays
 * counterpart stays income — the honest fallback when statements are
 * incomplete. Deterministic (both candidate lists are date- then
 * fingerprint-ordered) and idempotent: a matched pair is aside on
 * both sides, so a re-run finds nothing new to flip.
 *
 * Returns the number of pairs matched.
 */
export function matchInternalTransfers(
  db: import("better-sqlite3").Database,
): number {
  const outflows = db
    .prepare(
      `SELECT fingerprint, effective_date, amount_minor FROM transactions
       WHERE person = 'zonito' AND account = 'Barclays Current'
         AND currency = 'GBP' AND movement = 'aside' AND amount_minor < 0
         AND LOWER(description) LIKE '%revolut%'
       ORDER BY effective_date, fingerprint`,
    )
    .all() as {
    fingerprint: string;
    effective_date: string;
    amount_minor: number;
  }[];
  if (outflows.length === 0) return 0;
  const deposits = db
    .prepare(
      `SELECT fingerprint, effective_date, amount_minor FROM transactions
       WHERE person = 'zonito'
         AND account NOT IN ('Barclays Current', 'Barclaycard')
         AND currency = 'GBP' AND movement = 'income' AND amount_minor > 0
         AND (LOWER(description) LIKE '%deposit%'
           OR LOWER(description) LIKE '%top-up%'
           OR LOWER(description) LIKE '%top up%'
           OR LOWER(description) LIKE 'payment from %')
       ORDER BY effective_date, fingerprint`,
    )
    .all() as {
    fingerprint: string;
    effective_date: string;
    amount_minor: number;
  }[];
  const dayMs = (iso: string) =>
    Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / 86400000;
  const used = new Set<string>();
  const pairs: [string, string][] = [];
  for (const out of outflows) {
    let best: (typeof deposits)[number] | null = null;
    let bestDiff = Infinity;
    for (const dep of deposits) {
      if (used.has(dep.fingerprint)) continue;
      if (dep.amount_minor !== -out.amount_minor) continue;
      const diff = Math.abs(
        dayMs(dep.effective_date) - dayMs(out.effective_date),
      );
      if (diff > 3) continue;
      if (diff < bestDiff) {
        best = dep;
        bestDiff = diff;
      }
    }
    if (best) {
      used.add(best.fingerprint);
      pairs.push([out.fingerprint, best.fingerprint]);
    }
  }
  if (pairs.length > 0) {
    const flip = db.prepare(
      "UPDATE transactions SET movement = 'aside' WHERE fingerprint = ?",
    );
    db.transaction((items: [string, string][]) => {
      for (const [a, b] of items) {
        flip.run(a);
        flip.run(b);
      }
    })(pairs);
  }
  return pairs.length;
}

/**
 * Person-aware discovery of the Originals folder.
 *
 * Zonito's six accounts keep their filename-hint matching exactly as
 * findOriginalFile has always done it. Every other statement file in
 * Originals is Nikhila's: an account-statement file's account is its
 * rows' dominant Product value (her Current export carries 295 Current
 * rows plus 4 self-cancelling "Investments" balance-migration rows —
 * the migration rows belong to the export's balance chain and ingest
 * with it); a savings file's account is "Savings-<digits>" from the
 * filename tag (which may carry a leading minus, as hers does). Each
 * file's (person, account) assignment is persisted in the store's meta
 * the first time it is derived, and the persisted assignment wins
 * forever after — a file can never migrate between people, even if the
 * hint matching would one day claim it.
 *
 * A statement file with NO dominant Product (its rows split across
 * products with none holding 90%) is ambiguous: it fails loudly as its
 * own ingest result instead of being guessed into somebody's account.
 */
/** The prepared Barclays export: its bare filename (the persistence
 * identity), where it lives under the data dir, and the two accounts
 * its Product column distinguishes. */
const BARCLAYS_FILE = "barclaycard-full-history.csv";
const BARCLAYS_REL_PATH = "Zonito/Barclay/Barclaycard/barclaycard-full-history.csv";
const BARCLAYS_PRODUCTS: { product: string; account: string }[] = [
  { product: "Current", account: "Barclays Current" },
  { product: "Barclaycard", account: "Barclaycard" },
];

export type FileAssignment = {
  file: string;
  person: string;
  account: string;
  /** Path relative to the data dir when the file lives outside
   * Originals (the Barclays tree); absent for Originals files. */
  relPath?: string;
  /** The Product value this assignment ingests, when one file holds
   * several accounts (the Barclays file); absent when the whole file
   * is one account. */
  product?: string;
};

const ASSIGNMENT_KEY_PREFIX = "file_assignment:";

/**
 * The persistence key for an assignment: the bare filename for a
 * whole-file assignment, `file#Product` for one slice of a
 * multi-product file — one file can then hold several persisted
 * assignments without them overwriting each other.
 */
function assignmentKey(a: { file: string; product?: string }): string {
  return a.product ? `${a.file}#${a.product}` : a.file;
}

function persistedAssignments(
  db: import("better-sqlite3").Database,
): Map<string, FileAssignment> {
  const rows = db
    .prepare("SELECT key, value FROM meta WHERE key LIKE ?")
    .all(`${ASSIGNMENT_KEY_PREFIX}%`) as { key: string; value: string }[];
  const map = new Map<string, FileAssignment>();
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.value) as {
        person?: unknown;
        account?: unknown;
        relPath?: unknown;
        product?: unknown;
      };
      if (typeof parsed.person === "string" && typeof parsed.account === "string") {
        const key = row.key.slice(ASSIGNMENT_KEY_PREFIX.length);
        map.set(key, {
          file: key.split("#")[0]!,
          person: parsed.person,
          account: parsed.account,
          ...(typeof parsed.relPath === "string"
            ? { relPath: parsed.relPath }
            : {}),
          ...(typeof parsed.product === "string"
            ? { product: parsed.product }
            : {}),
        });
      }
    } catch {
      // A corrupt assignment is ignored; discovery re-derives it.
    }
  }
  return map;
}

function persistAssignment(
  db: import("better-sqlite3").Database,
  assignment: FileAssignment,
): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(
    `${ASSIGNMENT_KEY_PREFIX}${assignmentKey(assignment)}`,
    JSON.stringify({
      person: assignment.person,
      account: assignment.account,
      ...(assignment.relPath ? { relPath: assignment.relPath } : {}),
      ...(assignment.product ? { product: assignment.product } : {}),
    }),
  );
}

/** "Savings-<digits>" from a savings filename tag, tolerating the
 * leading minus her export carries ("..._en-sg_-900000003_3b9780.csv"). */
function savingsAccountFromFilename(file: string): string | null {
  const tokens = file.replace(/\.csv$/i, "").split("_");
  for (let i = tokens.length - 1; i >= 0; i--) {
    const m = tokens[i]!.match(/^-?(\d{4,})$/);
    if (m) return `Savings-${m[1]}`;
  }
  return null;
}

export function discoverFiles(
  db: import("better-sqlite3").Database,
  dataDir: string,
): { assignments: FileAssignment[]; failures: IngestResult[] } {
  const dir = join(dataDir, "Originals");
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".csv"))
      .sort();
  } catch {
    // An unlistable Originals folder discovers nothing; every Zonito
    // account then fails by name through the unassigned pass in
    // ingestAccounts, exactly as it did before discovery existed.
    files = [];
  }
  const persisted = persistedAssignments(db);
  const assignments: FileAssignment[] = [];
  const failures: IngestResult[] = [];
  const claimed = new Set<string>();
  const assign = (a: FileAssignment) => {
    assignments.push(a);
    claimed.add(a.file);
    if (!persisted.has(assignmentKey(a))) persistAssignment(db, a);
  };

  // Zonito first: a persisted assignment rules; otherwise the standing
  // filename hints claim their file (never one persisted to Nikhila).
  for (const account of INGEST_ACCOUNTS) {
    const mine = [...persisted.entries()].find(
      ([file, a]) =>
        a.person === "zonito" && a.account === account && files.includes(file),
    );
    if (mine) {
      assign({ file: mine[0], person: "zonito", account });
      continue;
    }
    let file: string | null = null;
    try {
      file = findOriginalFile(dataDir, account);
    } catch {
      file = null;
    }
    if (file && persisted.get(file)?.person === "nikhila") file = null;
    if (file) assign({ file, person: "zonito", account });
    // No file at all: ingestAccountSafe below is not run for this
    // account; the missing file surfaces when the account is attempted
    // through its own result (see the unassigned pass in ingestAccounts).
  }

  // The Barclays file: one prepared export living outside Originals
  // (Zonito/Barclay/Barclaycard/), holding two products side by side —
  // his current account and his credit card — so it discovers as TWO
  // assignments for Zonito, one per Product, each persisted under its
  // own composite key. It is found by its known path, never by the
  // Originals listing, so the Nikhila pass below never sees it. No
  // file at the path, no accounts: the pair simply does not exist
  // until the export is placed there.
  if (existsSync(join(dataDir, BARCLAYS_REL_PATH))) {
    for (const { product, account } of BARCLAYS_PRODUCTS) {
      const known = persisted.get(
        assignmentKey({ file: BARCLAYS_FILE, product }),
      );
      if (known) {
        assign({
          file: BARCLAYS_FILE,
          person: known.person,
          account: known.account,
          ...(known.relPath ? { relPath: known.relPath } : {}),
          product,
        });
      } else {
        assign({
          file: BARCLAYS_FILE,
          person: "zonito",
          account,
          relPath: BARCLAYS_REL_PATH,
          product,
        });
      }
    }
  }

  // Nikhila: every remaining statement file is hers.
  for (const file of files) {
    if (claimed.has(file)) continue;
    const known = persisted.get(file);
    if (known) {
      assign({ file, person: known.person, account: known.account });
      continue;
    }
    if (file.includes("savings")) {
      const account = savingsAccountFromFilename(file);
      if (account) {
        assign({ file, person: "nikhila", account });
      } else {
        failures.push({
          person: "nikhila",
          account: file,
          rowsSeen: 0,
          rowsAdded: 0,
          balanceMinor: null,
          currency: null,
          discrepancy: null,
          ok: false,
          file,
          error: `cannot read a savings account number from the filename ${file}`,
        });
      }
      continue;
    }
    if (file.includes("account-statement")) {
      let account: string | null = null;
      let failure: string | null = null;
      try {
        const text = readFileSync(join(dir, file), "utf8");
        const rows = parseAccountCsv(text);
        const counts = new Map<string, number>();
        for (const r of rows) {
          const product = r.product.trim();
          counts.set(product, (counts.get(product) ?? 0) + 1);
        }
        const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        const top = ranked[0];
        if (top && rows.length > 0 && top[1] / rows.length >= 0.9) {
          account = top[0];
        } else {
          const split = ranked
            .map(([p, n]) => `${p} ${n}`)
            .join(", ");
          failure = `${file}: ambiguous statement — its rows split across Products (${split}) with no single account holding 90%; refusing to guess whose account it is`;
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      if (failure !== null) {
        failures.push({
          person: "nikhila",
          account: file,
          rowsSeen: 0,
          rowsAdded: 0,
          balanceMinor: null,
          currency: null,
          discrepancy: null,
          ok: false,
          file,
          error: failure,
        });
        continue;
      }
      assign({ file, person: "nikhila", account: account! });
      continue;
    }
    // Not a statement file at all: not ours to ingest, leave it alone.
  }
  return { assignments, failures };
}

/**
 * Ingest every discovered account for BOTH people, each fault-tolerant
 * (see ingestAccountSafe), then refresh the household aggregates so the
 * combined view always equals the sum of the two people's rows.
 * Zonito accounts with no discoverable file still produce their named
 * failure result, exactly as before discovery existed.
 */
export function ingestAccounts(
  db: import("better-sqlite3").Database,
  dataDir: string,
): IngestResult[] {
  const { assignments, failures } = discoverFiles(db, dataDir);
  const results = assignments.map((a) =>
    ingestAccountSafe(db, a.person, a.account, dataDir, a.file, {
      ...(a.relPath ? { relPath: a.relPath } : {}),
      ...(a.product ? { product: a.product } : {}),
    }),
  );
  const assignedZonito = new Set(
    assignments.filter((a) => a.person === "zonito").map((a) => a.account),
  );
  for (const account of INGEST_ACCOUNTS) {
    if (!assignedZonito.has(account)) {
      results.push(ingestAccountSafe(db, "zonito", account, dataDir));
    }
  }
  // With every account in, pair up the transfers that are now
  // visible from both sides (Barclays -> Revolut top-ups) so they
  // net to zero in the aggregates, then rebuild both aggregate sets.
  matchInternalTransfers(db);
  recomputeAggregates(db, "zonito");
  recomputeAggregates(db, "household");
  return [...results, ...failures];
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
  "person, account, started_at, rows_seen, rows_added, balance_minor, currency, discrepancy, finished_at";
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

const NOTE_COLUMNS = "fingerprint, note, updated_at";

/**
 * Transaction notes are the user's own words keyed by fingerprint —
 * not derivable from the CSVs, so they get the merchant-memory
 * treatment: copied into the rebuild's temp store up front. (The swap
 * itself never touches the live store's txn_notes table, so notes
 * survive by construction as well; a note whose transaction vanishes
 * in a rebuild stays harmlessly orphaned and simply never renders.)
 */
function carryTxnNotes(
  from: import("better-sqlite3").Database,
  to: import("better-sqlite3").Database,
): void {
  const rows = from
    .prepare(`SELECT ${NOTE_COLUMNS} FROM txn_notes`)
    .all() as Record<string, unknown>[];
  if (rows.length === 0) return;
  const insert = to.prepare(
    `INSERT OR REPLACE INTO txn_notes (${NOTE_COLUMNS}) VALUES (?, ?, ?)`,
  );
  const copy = to.transaction((items: Record<string, unknown>[]) => {
    for (const r of items) {
      insert.run(r["fingerprint"], r["note"], r["updated_at"]);
    }
  });
  copy(rows);
}

const OVERRIDE_COLUMNS = "merchant, label, mode, source, updated_at";

/**
 * Subscription overrides are the user's corrections to the detector
 * (force / suppress / cancelled, keyed by canonical merchant) — same
 * treatment as notes: copied into the rebuild's temp store up front,
 * and the live table itself is outside the swap set, so they survive
 * rebuilds by construction as well.
 */
function carrySubscriptionOverrides(
  from: import("better-sqlite3").Database,
  to: import("better-sqlite3").Database,
): void {
  const rows = from
    .prepare(`SELECT ${OVERRIDE_COLUMNS} FROM subscription_overrides`)
    .all() as Record<string, unknown>[];
  if (rows.length === 0) return;
  const insert = to.prepare(
    `INSERT OR REPLACE INTO subscription_overrides (${OVERRIDE_COLUMNS})
     VALUES (?, ?, ?, ?, ?)`,
  );
  const copy = to.transaction((items: Record<string, unknown>[]) => {
    for (const r of items) {
      insert.run(r["merchant"], r["label"], r["mode"], r["source"], r["updated_at"]);
    }
  });
  copy(rows);
}

/**
 * File assignments (meta) are likewise not derivable state the rebuild
 * may drop: the temp store receives the live store's assignments before
 * its discovery runs, and the swap copies any assignments the rebuild
 * derived back into the live store.
 */
function carryFileAssignments(
  from: import("better-sqlite3").Database,
  to: import("better-sqlite3").Database,
): void {
  const rows = from
    .prepare("SELECT key, value FROM meta WHERE key LIKE ?")
    .all(`${ASSIGNMENT_KEY_PREFIX}%`) as { key: string; value: string }[];
  const insert = to.prepare(
    `INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`,
  );
  const copy = to.transaction((items: { key: string; value: string }[]) => {
    for (const r of items) insert.run(r.key, r.value);
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
    return ingestAccounts(db, dataDir);
  }
  const stored = storedRulesVersion(db);
  const tmpPath = join(dirname(livePath), `${STORE_FILENAME}.rebuild`);
  removeStoreFiles(tmpPath);
  const tmp = openStoreFile(tmpPath);
  let results: IngestResult[];
  try {
    carryMerchantMemory(db, tmp);
    carryTxnNotes(db, tmp);
    carrySubscriptionOverrides(db, tmp);
    carryFileAssignments(db, tmp);
    results = ingestAccounts(tmp, dataDir);
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
    db.exec(
      `INSERT OR REPLACE INTO meta (key, value)
       SELECT key, value FROM rebuild_src.meta
       WHERE key LIKE '${ASSIGNMENT_KEY_PREFIX}%'`,
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

/**
 * Ingest the whole Originals folder for BOTH people (see discoverFiles).
 * A rules-version mismatch routes through the atomic rebuild instead.
 */
export function ingestAll(
  db: import("better-sqlite3").Database,
  dataDir: string,
): IngestResult[] {
  if (storedRulesVersion(db) === String(RULES_VERSION)) {
    return ingestAccounts(db, dataDir);
  }
  return rebuildStore(db, dataDir);
}
