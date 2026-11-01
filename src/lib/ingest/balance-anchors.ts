import type Database from "better-sqlite3";

/**
 * Balance anchors: known balances, on known dates, for accounts
 * whose statement exports carry no balance column — the Barclays
 * current account's CSVs record amounts only, so ingest can never
 * record a balance for it and the account would otherwise sit at
 * "Not recorded" forever, excluded from Available.
 *
 * An anchor is a balance read off a bank statement (the end balance
 * of the account's latest PDF statement). The account's balance at
 * the latest data is then the anchor plus the signed sum of every
 * transaction after the anchor date — every movement moves a real
 * bank balance. The household validated this walk by hand against
 * 13 consecutive statements before it was productised: anchored at
 * one statement close, the CSV transactions reproduced each of the
 * next 13 closes to the penny.
 *
 * Storage is a dedicated `balance_anchors` table. Like settings and
 * merchant memory it sits entirely outside the ingest swap set (a
 * rebuild replaces only transactions, month_aggregates, ingest_runs
 * and assignment-prefixed meta keys), so anchors survive statement
 * rebuilds by construction — they are facts read off statements,
 * not derivable from any CSV. Several anchors may exist per account
 * (a newer statement supersedes an older one); the newest by date
 * wins, so a fresher statement can simply be added, never edited in.
 *
 * Amounts are minor units. Derivation never mixes currencies: the
 * sum runs over the account's rows in the anchor's own currency
 * only, as everywhere else in the app.
 */

export interface BalanceAnchor {
  person: string;
  account: string;
  /** YYYY-MM-DD the balance was true at (a statement end date). */
  anchorDate: string;
  balanceMinor: number;
  currency: string;
}

export interface DerivedBalance {
  balanceMinor: number;
  currency: string;
  /** The date the derived balance is as of: the account's latest
   *  transaction date in the anchor's currency, or the anchor date
   *  when no row postdates the anchor. */
  asOf: string;
  anchorDate: string;
}

/**
 * The one production anchor, seeded idempotently at store open:
 * the Barclays current account's latest PDF statement end balance,
 * £177.11 at 20 Apr 2026, validated against the 13-statement chain
 * described above. This is data configuration (a fact about the
 * household's real account), not a code constant anything computes
 * from; tests define their own synthetic anchors and never read
 * this one.
 */
const SEED_ANCHORS: BalanceAnchor[] = [
  {
    person: "zonito",
    account: "Barclays Current",
    anchorDate: "2026-04-20",
    balanceMinor: 17711,
    currency: "GBP",
  },
];

/** Insert the production seed anchors if absent. Safe to call on
 *  every store open: the (person, account, anchor_date) unique
 *  index makes re-seeding a no-op, and a household-added anchor for
 *  the same date is never overwritten. */
export function seedBalanceAnchors(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO balance_anchors
       (person, account, anchor_date, balance_minor, currency)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const seed = db.transaction((anchors: BalanceAnchor[]) => {
    for (const a of anchors) {
      insert.run(a.person, a.account, a.anchorDate, a.balanceMinor, a.currency);
    }
  });
  seed(SEED_ANCHORS);
}

/** Record an anchor (a newer statement's end balance). Idempotent
 *  per (person, account, date): re-adding the same date keeps the
 *  first value recorded. */
export function addBalanceAnchor(
  db: Database.Database,
  anchor: BalanceAnchor,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO balance_anchors
       (person, account, anchor_date, balance_minor, currency)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    anchor.person,
    anchor.account,
    anchor.anchorDate,
    anchor.balanceMinor,
    anchor.currency,
  );
}

export function listBalanceAnchors(db: Database.Database): BalanceAnchor[] {
  return (
    db
      .prepare(
        `SELECT person, account, anchor_date, balance_minor, currency
         FROM balance_anchors ORDER BY person, account, anchor_date`,
      )
      .all() as {
      person: string;
      account: string;
      anchor_date: string;
      balance_minor: number;
      currency: string;
    }[]
  ).map((r) => ({
    person: r.person,
    account: r.account,
    anchorDate: r.anchor_date,
    balanceMinor: r.balance_minor,
    currency: r.currency,
  }));
}

/** The winning anchor for one account: the newest by date (a later
 *  insert breaks a same-date tie, though the unique index makes
 *  same-date duplicates impossible in practice). Null when the
 *  account has no anchor — anchors for unknown accounts are inert:
 *  they simply never match an account the snapshot builds. */
export function anchorFor(
  db: Database.Database,
  person: string,
  account: string,
): BalanceAnchor | null {
  const row = db
    .prepare(
      `SELECT anchor_date, balance_minor, currency FROM balance_anchors
       WHERE person = ? AND account = ?
       ORDER BY anchor_date DESC, id DESC LIMIT 1`,
    )
    .get(person, account) as
    | { anchor_date: string; balance_minor: number; currency: string }
    | undefined;
  if (!row) return null;
  return {
    person,
    account,
    anchorDate: row.anchor_date,
    balanceMinor: row.balance_minor,
    currency: row.currency,
  };
}

/**
 * Derive one account's current balance from its newest anchor:
 * the anchor balance plus the signed sum of ALL its transactions
 * dated after the anchor date, in the anchor's currency. Rows on
 * the anchor date itself are already inside the statement balance
 * and never counted. An anchor dated after every row yields the
 * anchor balance itself, as of the anchor date.
 */
export function deriveBalance(
  db: Database.Database,
  person: string,
  account: string,
): DerivedBalance | null {
  const anchor = anchorFor(db, person, account);
  if (!anchor) return null;
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN substr(effective_date, 1, 10) > ?
                           THEN amount_minor ELSE 0 END), 0) AS post_minor,
         MAX(substr(effective_date, 1, 10)) AS latest
       FROM transactions
       WHERE person = ? AND account = ? AND currency = ?`,
    )
    .get(anchor.anchorDate, person, account, anchor.currency) as {
    post_minor: number;
    latest: string | null;
  };
  return {
    balanceMinor: anchor.balanceMinor + row.post_minor,
    currency: anchor.currency,
    asOf:
      row.latest !== null && row.latest > anchor.anchorDate
        ? row.latest
        : anchor.anchorDate,
    anchorDate: anchor.anchorDate,
  };
}

/**
 * The balance the account's selected ingest run recorded, using the
 * snapshot's own selection rule: the latest run that actually read
 * a statement (rows_seen > 0), falling back to the latest run of
 * any kind. Null when that run recorded no balance — an unknown
 * balance, never a fabricated zero.
 */
export function recordedBalance(
  db: Database.Database,
  person: string,
  account: string,
): { balanceMinor: number; currency: string | null } | null {
  const pick = (where: string): { balance_minor: number | null; currency: string | null } | undefined =>
    db
      .prepare(
        `SELECT balance_minor, currency FROM ingest_runs
         WHERE person = ? AND account = ? ${where}
         ORDER BY id DESC LIMIT 1`,
      )
      .get(person, account) as
      | { balance_minor: number | null; currency: string | null }
      | undefined;
  const chosen = pick("AND rows_seen > 0") ?? pick("");
  if (!chosen || chosen.balance_minor === null) {
    return null;
  }
  return { balanceMinor: chosen.balance_minor, currency: chosen.currency };
}

/**
 * Provenance of one account's balance, from the same rules the
 * snapshot applies: "statement" when the selected ingest run
 * recorded one, "derived" when an anchor walk supplies one instead,
 * null when the account has no balance at all. GET /api/accounts
 * exposes this so API consumers label balances exactly as the
 * snapshot's surfaces do.
 */
export function balanceSourceFor(
  db: Database.Database,
  person: string,
  account: string,
): "statement" | "derived" | null {
  if (recordedBalance(db, person, account)) return "statement";
  if (deriveBalance(db, person, account)) return "derived";
  return null;
}
