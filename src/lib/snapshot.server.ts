import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { openStore } from "./ingest/store";
import { reviewQueueCount } from "./ingest/merchants";
import {
  EMPTY_SNAPSHOT,
  dateLabel,
  shareOf,
  type AccountInfo,
  type DataSnapshot,
  type IncomeEntry,
  type NewMerchant,
  type Owner,
  type Person,
  type Sub,
  type SubOverride,
  type Txn,
  type UpcomingPayment,
} from "./data";
import { accountTxnLabel } from "./txn-map";
import { listCategories } from "./ingest/categories";
import { getSettings } from "./ingest/settings";
import { applySubscriptionOverrides, detectSubscriptions } from "./subscriptions";
import {
  documentRowToDoc,
  type DocumentRow,
} from "./documents.server";
import type { Doc } from "./data";

/**
 * Builds the UI snapshot from the real store. Server-only (better-sqlite3);
 * imported dynamically from the getSnapshot server function so none of this
 * reaches the client bundle. Everything the screens show comes from the
 * transactions table and the precomputed month_aggregates — this file never
 * reads a CSV.
 */

function loadEnvFile(): void {
  try {
    for (const line of readFileSync(process.cwd() + "/.env", "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim();
    }
  } catch {
    // no .env — env vars only
  }
}

type Row = {
  fingerprint: string;
  person: string;
  account: string;
  effective_date: string;
  year_month: string;
  description: string;
  merchant: string;
  amount_minor: number;
  currency: string;
  movement: string;
  category: string | null;
  user_note: string | null;
};

const ACCOUNT_LIST_LABEL: Record<string, string> = {
  Main: "Revolut Main",
  Pro: "Revolut Pro",
  "USD-Invest": "Revolut USD-Invest",
  Joint: "Joint Bills",
  "Savings-9000000002": "Revolut Savings 0002",
  "Savings-9000000001": "Revolut Savings 0001",
};

/** Account-list label for one person's account. Nikhila's names derive
 * from her account names (savings keep their last four digits, so her
 * account reads "Revolut Savings 0003"); Zonito's use the fixed map. */
function accountListLabel(person: string, account: string): string {
  if (person === "nikhila") {
    if (account === "Current") return "Revolut Current";
    if (account.startsWith("Savings-")) {
      return `Revolut Savings ${account.slice(-4)}`;
    }
    return `Revolut ${account}`;
  }
  return ACCOUNT_LIST_LABEL[account] ?? account;
}

function resolveCategory(row: Row, memory: Map<string, string>): string {
  if (row.category) return row.category;
  const remembered = memory.get(row.merchant);
  if (remembered) return remembered;
  switch (row.movement) {
    case "aside":
      return "Moved aside";
    case "fee":
      return "Fees";
    case "interest":
      return "Interest";
    case "internal":
      return "Transfer";
    default:
      return "One-off";
  }
}

function monthLabel(key: string): string {
  const d = new Date(`${key}-02T00:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(d);
}
/** Store effective_date is usually YYYY-MM-DD but some rows carry a full
 * "YYYY-MM-DD HH:MM:SS" timestamp; consumers here only ever need the day. */
const day10 = (iso: string) => iso.slice(0, 10);
function shortDayLabel(iso: string): string {
  const d = new Date(`${day10(iso)}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(d);
}
function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export function buildSnapshot(): DataSnapshot {
  loadEnvFile();
  const storeDir = process.env["CHITRAGUPTA_STORE_DIR"]?.trim();
  if (!storeDir) return EMPTY_SNAPSHOT;
  let db: Database.Database;
  try {
    db = openStore(storeDir);
  } catch {
    return EMPTY_SNAPSHOT;
  }
  try {
    return buildFromDb(db);
  } catch (error) {
    console.error("chitragupta: snapshot build failed", error);
    return { ...EMPTY_SNAPSHOT, configured: true };
  } finally {
    db.close();
  }
}

function buildFromDb(db: Database.Database): DataSnapshot {
  // Floors & budgets: the household's own thresholds from the settings
  // table (outside the ingest swap set, so they survive rebuilds).
  const settings = getSettings(db);
  // The category fold for snapshot transactions uses the store's own
  // category list (built-ins + customs): the client-side uiCategory
  // reads hydrated module state, which the server never has.
  const knownCategories = new Set(listCategories(db).map((c) => c.name));
  const uiCategoryDb = (name: string): Txn["category"] =>
    (name === "Transfer" || name === "Moved aside" || knownCategories.has(name)
      ? name
      : "One-off") as Txn["category"];
  const memory = new Map<string, string>(
    (db.prepare("SELECT merchant, category FROM merchant_memory").all() as { merchant: string; category: string }[])
      .map((r) => [r.merchant, r.category]),
  );
  // Filed documents, from the documents table (files under the data
  // dir's Documents/ tree). An empty table is honestly docs: [].
  let docs: Doc[] = [];
  try {
    const docRows = db
      .prepare(
        `SELECT id, merchant, date, amount_minor, type, txn_id, path, warranty_ends
         FROM documents ORDER BY date DESC, created_at DESC`,
      )
      .all() as DocumentRow[];
    docs = docRows.map(documentRowToDoc);
  } catch {
    docs = [];
  }
  const monthRows = db
    .prepare(
      "SELECT DISTINCT year_month FROM transactions ORDER BY year_month DESC",
    )
    .all() as { year_month: string }[];
  if (monthRows.length === 0) return { ...EMPTY_SNAPSHOT, configured: true, docs, settings };
  const current = monthRows[0]!.year_month;
  const included = monthRows.slice(0, 2).map((r) => r.year_month);

  // Transactions for the current and previous month, GBP only (foreign
  // currency is reported per-currency by /api/aggregates, never mixed in).
  // Newest first — including within a day, where effective_date may
  // carry a time — matching /api/transactions' ORDER BY, so a snapshot
  // month and a fetched month list rows in the same order.
  const rawRows = db
    .prepare(
      `SELECT t.fingerprint, t.person, t.account, t.effective_date, t.year_month,
              t.description, t.merchant, t.amount_minor, t.currency, t.movement,
              t.category, n.note AS user_note
       FROM transactions t LEFT JOIN txn_notes n ON n.fingerprint = t.fingerprint
       WHERE t.currency = 'GBP' AND t.year_month IN (${included.map(() => "?").join(",")})
         AND t.movement IN ('spend', 'internal', 'aside', 'income')
       ORDER BY t.effective_date DESC`,
    )
    .all(...included) as Row[];

  const txns: Txn[] = [];
  const income: IncomeEntry[] = [];
  for (const row of rawRows) {
    const owner: Owner = row.account === "Joint" ? "joint" : (row.person as Owner);
    const amount = Math.abs(row.amount_minor) / 100;
    const day = Number(day10(row.effective_date).slice(8, 10));
    if (row.movement === "income") {
      if (row.year_month === current && row.amount_minor > 0) {
        income.push({
          day,
          amount,
          owner: owner === "joint" ? "zonito" : owner,
          type: /salary|payroll|wages/i.test(row.description) ? "Salary" : row.merchant,
        });
      }
      continue;
    }
    const kind = row.movement === "spend" ? "spend" : row.movement === "aside" ? "aside" : "transfer";
    txns.push({
      id: row.fingerprint,
      date: day10(row.effective_date),
      day,
      monthKey: row.year_month,
      merchant: row.merchant,
      category: uiCategoryDb(resolveCategory(row, memory)),
      amount,
      owner,
      account: accountTxnLabel(row.person, row.account),
      accountId: row.account,
      kind,
      // Mirror apiTxnToTxn (txn-map.ts) exactly, so a snapshot month and
      // a fetched month show the same detail for the same row: the
      // statement description becomes the note when it adds anything
      // beyond the merchant name, and fx is never set — this selection
      // is GBP-only and the API mapper drops non-GBP rows rather than
      // decorating them, so neither path invents an fx string.
      ...(row.amount_minor > 0 ? { incoming: true } : {}),
      ...(row.description && row.description !== row.merchant
        ? { note: row.description }
        : {}),
      // The user's own note (txn_notes), distinct from the statement
      // description above; mirrored in apiTxnToTxn via /api/transactions.
      ...(row.user_note ? { userNote: row.user_note } : {}),
    });
  }

  // Typical month (median of the previous 6 calendar months) and 6-month
  // spark series, from the precomputed aggregates — GBP rows only.
  const aggRows = db
    .prepare(
      `SELECT person, year_month, category, spend_minor, aside_minor FROM month_aggregates WHERE currency = 'GBP'`,
    )
    .all() as { person: string; year_month: string; category: string; spend_minor: number; aside_minor: number }[];
  // Household reads the stored 'household' aggregate rows (true
  // both-people sums). A store that predates them has none, so fall
  // back to summing the per-person rows — and never both, or every
  // household figure would double.
  const hasHouseholdRows = aggRows.some((r) => r.person === "household");
  const aggGet = (person: string | null, month: string, category: string): number =>
    aggRows
      .filter(
        (r) =>
          (person === null
            ? hasHouseholdRows
              ? r.person === "household"
              : r.person !== "household"
            : r.person === person) &&
          r.year_month === month &&
          r.category === category,
      )
      .reduce((s, r) => s + r.spend_minor, 0) / 100;
  const prev6 = [1, 2, 3, 4, 5, 6].map((d) => shiftMonth(current, -d));
  const sparkMonths = [5, 4, 3, 2, 1, 0].map((d) => shiftMonth(current, -d));
  const persons: Person[] = ["household", "zonito", "nikhila"];
  const personKey = (p: Person): string | null => (p === "household" ? null : p);
  const typical: DataSnapshot["typical"] = {};
  const sparks: DataSnapshot["sparks"] = {};
  const categories = new Set(aggRows.map((r) => r.category));
  for (const tx of txns) if (tx.kind === "spend") categories.add(tx.category);
  for (const category of categories) {
    typical[category] = {};
    sparks[category] = {};
    for (const p of persons) {
      typical[category]![p] = median(prev6.map((m) => aggGet(personKey(p), m, category)));
      sparks[category]![p] = sparkMonths.map((m) => aggGet(personKey(p), m, category));
    }
  }
  const months6 = sparkMonths.map((key) =>
    new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" }).format(new Date(`${key}-02T00:00:00Z`)),
  );

  // Full monthly history for the timeline charts, from the same GBP
  // aggregate rows typical/sparks read: one series per category per
  // person over a continuous month range, so a bucket total IS the
  // month_aggregates figure for that month, nothing recomputed.
  // Categories fold through the store's category list exactly as
  // snapshot transactions do. Household follows aggGet's rule: the
  // stored household rows when they exist, else the two people's rows
  // summed (never both, or every household figure would double).
  const monthly: DataSnapshot["monthly"] = (() => {
    const aggMonths = [...new Set(aggRows.map((r) => r.year_month))].sort();
    if (aggMonths.length === 0) return { months: [], series: {} };
    const months: string[] = [];
    for (let k = aggMonths[0]!; ; k = shiftMonth(k, 1)) {
      months.push(k);
      if (k === aggMonths[aggMonths.length - 1]) break;
    }
    const minor = new Map<string, number>();
    for (const r of aggRows) {
      const key = `${r.person}|${r.year_month}|${uiCategoryDb(r.category)}`;
      minor.set(key, (minor.get(key) ?? 0) + r.spend_minor);
    }
    const cats = [...new Set(aggRows.map((r) => uiCategoryDb(r.category)))];
    const series: DataSnapshot["monthly"]["series"] = {};
    for (const cat of cats) {
      const per: Partial<Record<Person, number[]>> = {};
      for (const p of persons) {
        per[p] = months.map((ym) => {
          if (p !== "household") {
            return (minor.get(`${p}|${ym}|${cat}`) ?? 0) / 100;
          }
          if (hasHouseholdRows) {
            return (minor.get(`household|${ym}|${cat}`) ?? 0) / 100;
          }
          return (
            ((minor.get(`zonito|${ym}|${cat}`) ?? 0) +
              (minor.get(`nikhila|${ym}|${cat}`) ?? 0)) /
            100
          );
        });
      }
      if (Object.values(per).some((s) => s!.some((v) => v > 0))) {
        series[cat] = per;
      }
    }
    return { months, series };
  })();

  // Monthly moved-aside totals per person, from the same GBP aggregate
  // rows (aside_minor is outgoing aside only, stored positive), aligned
  // to the spend history's month range and summed across categories —
  // Coach's floor pace and typical-aside math read this. Household
  // follows the same stored-rows rule as aggGet and the spend history:
  // the stored 'household' rows when they exist, else the two people's
  // rows summed — never both, or every household figure would double.
  const asideMonthly: DataSnapshot["asideMonthly"] = (() => {
    const months = monthly.months;
    if (months.length === 0) return { months: [], totals: {} };
    const minor = new Map<string, number>();
    for (const r of aggRows) {
      const key = `${r.person}|${r.year_month}`;
      minor.set(key, (minor.get(key) ?? 0) + r.aside_minor);
    }
    const totals: DataSnapshot["asideMonthly"]["totals"] = {};
    for (const p of persons) {
      totals[p] = months.map((ym) => {
        if (p !== "household") {
          return (minor.get(`${p}|${ym}`) ?? 0) / 100;
        }
        if (hasHouseholdRows) {
          return (minor.get(`household|${ym}`) ?? 0) / 100;
        }
        return (
          ((minor.get(`zonito|${ym}`) ?? 0) +
            (minor.get(`nikhila|${ym}`) ?? 0)) /
          100
        );
      });
    }
    return { months, totals };
  })();

  // Subscriptions: pattern-only detection (recurring amount cluster on a
  // regular cadence) — see src/lib/subscriptions.ts. Merchant memory's
  // category no longer admits or excludes anything here.
  const allSpend = db
    .prepare(
      `SELECT fingerprint, person, account, effective_date, year_month, description,
              merchant, amount_minor, currency, movement, category, NULL AS user_note
       FROM transactions WHERE currency = 'GBP' AND movement = 'spend' AND amount_minor < 0
       ORDER BY effective_date`,
    )
    .all() as Row[];
  const latestRow = db
    .prepare(`SELECT MAX(substr(effective_date, 1, 10)) AS d FROM transactions`)
    .get() as { d: string | null };
  const latestDate = latestRow.d ?? current;
  const subCharges = allSpend.map((r) => ({
    id: r.fingerprint,
    merchant: r.merchant,
    date: r.effective_date,
    amountMinor: r.amount_minor,
    account: r.account,
    person: r.person,
  }));
  const subFormat = {
    // Full dateLabel ("5 Oct 2026"), so a card's last-charged date is
    // in the same format as the next-expected date it renders beside.
    dateLabel,
    accountLabel: (account: string, person: string) => accountTxnLabel(person, account),
  };
  // Human overrides on the detector (subscription_overrides): applied
  // HERE, at the one place subscriptions are computed, so the
  // Subscriptions screen, Coach and Home's Coming up — all snapshot
  // readers — honour every correction at once.
  const overrideRows = db
    .prepare("SELECT merchant, label, mode FROM subscription_overrides ORDER BY label")
    .all() as { merchant: string; label: string; mode: string }[];
  const subOverrides: SubOverride[] = overrideRows
    .filter((r) => r.mode === "force" || r.mode === "suppress" || r.mode === "cancelled")
    .map((r) => ({
      merchant: r.merchant,
      label: r.label,
      mode: r.mode as SubOverride["mode"],
    }));
  const subs: Sub[] = applySubscriptionOverrides(
    detectSubscriptions(subCharges, latestDate, subFormat),
    subCharges,
    new Map(subOverrides.map((o) => [o.merchant, o.mode])),
    subFormat,
  );

  // Per-month charge totals for the Subscriptions trend, summed from
  // the very rows the detector clustered (chargeIds are their
  // fingerprints), so the trend can never disagree with the charges
  // the detail view lists for the same subscription.
  const chargeByFingerprint = new Map(allSpend.map((r) => [r.fingerprint, r]));
  for (const sub of subs) {
    const perMonth = new Map<string, number>();
    for (const id of sub.chargeIds) {
      const row = chargeByFingerprint.get(id);
      if (!row) continue;
      perMonth.set(
        row.year_month,
        (perMonth.get(row.year_month) ?? 0) + Math.abs(row.amount_minor) / 100,
      );
    }
    sub.chargeMonths = [...perMonth.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, total]) => ({ month, total }));
  }

  // Upcoming regulars on Home are the SAME subscriptions the Subscriptions
  // screen shows, not a second heuristic: an Active sub whose next
  // expected charge is still to come (after the store's latest
  // transaction) and lands by the end of next month. Amount is the sub's
  // own amount — the per-charge cluster amount its card renders
  // (Sub.amount, the latest cluster charge) — and owner is the sub's,
  // which the detector derives from its latest cluster charge (Joint
  // account → "joint", else that charge's person). A yearly sub due
  // next month appears here exactly like a monthly one.
  const nextMonthKey = shiftMonth(current, 1);
  const [nextYear, nextMonth] = nextMonthKey.split("-").map(Number) as [number, number];
  const windowEnd = new Date(Date.UTC(nextYear, nextMonth, 0)).toISOString().slice(0, 10);
  const upcoming: UpcomingPayment[] = subs
    .filter(
      (s) =>
        s.status === "Active" &&
        s.nextExpected !== null &&
        s.nextExpected > day10(latestDate) &&
        s.nextExpected <= windowEnd,
    )
    .map((s) => ({
      name: s.name,
      day: Number(s.nextExpected!.slice(8, 10)),
      date: s.nextExpected!,
      amount: s.amount,
      owner: s.owner,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // New merchants: first-ever spend lands in the current month.
  const firstSeen = db
    .prepare(
      `SELECT merchant, MIN(effective_date) AS first_seen FROM transactions
       WHERE movement = 'spend' AND currency = 'GBP' GROUP BY merchant
       HAVING substr(first_seen, 1, 7) = ?`,
    )
    .all(current) as { merchant: string; first_seen: string }[];
  const newMerchants: NewMerchant[] = firstSeen
    .map(({ merchant }) => {
      const rows = txns.filter((t) => t.merchant === merchant && t.kind === "spend");
      const biggest = rows.sort((a, b) => b.amount - a.amount)[0];
      return biggest
        ? { merchant, category: biggest.category, amount: biggest.amount, date: biggest.date }
        : null;
    })
    .filter((x): x is NewMerchant => x !== null)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 3);

  const biggestOneOff: DataSnapshot["biggestOneOff"] = {};
  for (const p of persons) {
    const best = txns
      .filter((t) => t.kind === "spend" && t.category === "One-off" && t.monthKey === current)
      .map((t) => ({ merchant: t.merchant, amount: shareOf(t, p), date: t.date }))
      .filter((x) => x.amount > 0)
      .sort((a, b) => b.amount - a.amount)[0];
    if (best) biggestOneOff[p] = best;
  }

  // Accounts from the last ingest run per (person, account) that
  // actually read a statement. Grouping by account alone would merge
  // the two people's "Pro" accounts into one row. A later no-op
  // re-import (rows_seen = 0) or a failed run must not pose as an
  // upload: last/added come from the latest run with rows_seen > 0,
  // falling back to the latest run when none qualify.
  // The __rebuild__ marker rows never appear (account filter below).
  // Staleness still compares against the newest run of any account, so
  // an account whose last real statement is old stays stale even after
  // a no-op re-run rewrites its latest run row to today.
  type RunRow = {
    person: string;
    account: string;
    started_at: string;
    rows_added: number;
    balance_minor: number | null;
    currency: string | null;
  };
  const runRows = db
    .prepare(
      `SELECT person, account, started_at, rows_added, balance_minor, currency FROM ingest_runs
       WHERE id IN (SELECT MAX(id) FROM ingest_runs GROUP BY person, account)
         AND substr(account, 1, 2) <> '__'`,
    )
    .all() as RunRow[];
  const contentRows = db
    .prepare(
      `SELECT person, account, started_at, rows_added, balance_minor, currency FROM ingest_runs
       WHERE id IN (SELECT MAX(id) FROM ingest_runs WHERE rows_seen > 0 GROUP BY person, account)
         AND substr(account, 1, 2) <> '__'`,
    )
    .all() as RunRow[];
  const contentByAccount = new Map(
    contentRows.map((r) => [`${r.person}|${r.account}`, r]),
  );
  const maxStarted = runRows.reduce((m, r) => (r.started_at > m ? r.started_at : m), "");
  const accounts: AccountInfo[] = runRows.map((r) => {
    const chosen = contentByAccount.get(`${r.person}|${r.account}`) ?? r;
    return {
      name: accountListLabel(r.person, r.account),
      owner: r.account === "Joint" ? "joint" : (r.person as Owner),
      last: shortDayLabel(chosen.started_at.slice(0, 10)),
      lastDate: chosen.started_at.slice(0, 10),
      added: chosen.rows_added,
      // The balance rides the SAME selected run as last/added: a later
      // failed run (balance NULL) never poses as the account's state,
      // and a run that recorded no balance leaves it unknown (null),
      // never a fabricated zero.
      balanceMinor: chosen.balance_minor ?? null,
      currency: chosen.currency ?? null,
      accountId: r.account,
      person: r.person,
      stale:
        maxStarted !== "" &&
        Date.parse(chosen.started_at) < Date.parse(maxStarted) - 7 * 86400000,
    };
  });

  // Merchant review: the snapshot carries only the TRUE queue size
  // for the Settings header chip. The review items themselves are
  // fetched by the sheet from /api/review-queue on open, so no
  // truncated, hard-labelled preview is baked in here.
  const reviewTotal = reviewQueueCount(db);

  return {
    configured: true,
    monthKey: current,
    latestDate: day10(latestDate),
    // Every month in the store, newest first — the picker and Ask route
    // older months to /api/transactions; txns below stay at two months.
    months: monthRows.map((r) => ({ key: r.year_month, label: monthLabel(r.year_month) })),
    txns,
    income,
    upcoming,
    subs,
    subOverrides,
    cards: [],
    migration: { moved: [], waiting: [] },
    reviewTotal,
    accounts,
    categories: listCategories(db),
    settings,
    docs,
    typical,
    sparks,
    monthly,
    asideMonthly,
    months6,
    newMerchants,
    biggestOneOff,
  };
}
