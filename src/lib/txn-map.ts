import type { Category, Owner, Txn } from "./data";
import { categoryNames } from "./data";

/**
 * Browser-safe mapping from GET /api/transactions rows to the UI Txn
 * shape, shared by Activity (older months fetched on demand) and Ask
 * (full-history record search). The mapping mirrors the snapshot builder
 * exactly — same GBP-only window, same movements, same owner and account
 * labels — so a fetched month behaves like a snapshot month.
 */

/**
 * The time of day recorded on a store timestamp, "HH:MM", or
 * undefined when the row carries no time. Store effective_date is
 * usually a bare "YYYY-MM-DD" and sometimes "YYYY-MM-DD HH:MM:SS"
 * (an ISO T separator works too). A 00:00 stamp is the date-only
 * placeholder, not a real midnight transaction, so it reads as no
 * time — the sheet must never print 00:00. One exception: a stamp in
 * the first minute of the day with real seconds (00:00:29, a payment
 * landing just after midnight) is genuine, so it is returned in full
 * as "00:00:SS" — shown whole, it can neither be mistaken for the
 * placeholder nor needs hiding. Times are shown exactly as
 * recorded: no parsing into a Date, no timezone conversion.
 */
export const timeOfDay = (iso: string): string | undefined => {
  const match = /[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(iso);
  if (!match) return undefined;
  const hhmm = `${match[1]}:${match[2]}`;
  if (hhmm !== "00:00") return hhmm;
  const seconds = match[3];
  return seconds !== undefined && seconds !== "00"
    ? `00:00:${seconds}`
    : undefined;
};

/**
 * The full time of day recorded on a store timestamp, "HH:MM:SS",
 * for the detail sheet — or undefined when the stamp carries no
 * seconds or is exactly 00:00:00 (the date-only placeholder). A
 * stamp like 00:00:29 is a genuine recorded time (a payment landing
 * just after midnight), so it survives here, and timeOfDay returns
 * it in full for the list too: a real time is never hidden.
 */
export const timeOfDayFull = (iso: string): string | undefined => {
  const match = /[T ](\d{2}):(\d{2}):(\d{2})/.exec(iso);
  if (!match) return undefined;
  const full = `${match[1]}:${match[2]}:${match[3]}`;
  return full === "00:00:00" ? undefined : full;
};

export interface ApiTxnRow {
  id: string;
  person: string;
  account: string;
  date: string;
  month: string;
  description: string;
  merchant: string;
  amountMinor: number;
  currency: string;
  movement: string;
  category: string;
  /** The user's own note (txn_notes), when one exists. */
  userNote?: string | null;
}

export const ACCOUNT_TXN_LABEL: Record<string, string> = {
  Main: "Revolut Main · Zonito",
  Pro: "Revolut Pro · Zonito",
  "USD-Invest": "Revolut USD-Invest · Zonito",
  Joint: "Joint Bills · Revolut",
};

/**
 * The display label for a transaction's account. Account names repeat
 * across people (both hold a "Pro"), so the label is person-aware:
 * Nikhila's accounts are derived from her account names, never borrowed
 * from Zonito's map.
 */
export function accountTxnLabel(person: string, account: string): string {
  if (account.startsWith("Savings-") && person !== "nikhila") {
    return "Revolut Savings · Zonito";
  }
  if (person === "nikhila") {
    if (account === "Current") return "Revolut Current · Nikhila";
    if (account.startsWith("Savings-")) return "Revolut Savings · Nikhila";
    return `Revolut ${account} · Nikhila`;
  }
  return ACCOUNT_TXN_LABEL[account] ?? account;
}

/**
 * Fold a stored category name to the UI shape: system movement labels
 * pass through, live categories (built-ins + customs, from the
 * hydrated snapshot list with the built-ins as fallback) pass through,
 * anything else is an unknown label and shows as One-off.
 */
export function uiCategory(name: string): Category {
  if (name === "Transfer" || name === "Moved aside") return name;
  return (categoryNames().includes(name) ? name : "One-off") as Category;
}

export function apiTxnToTxn(row: ApiTxnRow): Txn | null {
  if (row.currency !== "GBP") return null;
  // The snapshot's txns carry spend, internal transfers, moved-aside
  // and income; fees and interest never appear there.
  if (
    row.movement !== "spend" &&
    row.movement !== "internal" &&
    row.movement !== "aside" &&
    row.movement !== "income"
  ) {
    return null;
  }
  const date = row.date.slice(0, 10);
  const time = timeOfDay(row.date);
  const timeFull = timeOfDayFull(row.date);
  return {
    id: row.id,
    date,
    day: Number(date.slice(8, 10)),
    monthKey: row.month,
    merchant: row.merchant,
    category: uiCategory(row.category),
    amount: Math.abs(row.amountMinor) / 100,
    owner: row.account === "Joint" ? "joint" : (row.person as Owner),
    account: accountTxnLabel(row.person, row.account),
    accountId: row.account,
    kind:
      row.movement === "spend"
        ? "spend"
        : row.movement === "aside"
          ? "aside"
          : row.movement === "income"
            ? "income"
            : "transfer",
    ...(row.amountMinor > 0 ? { incoming: true } : {}),
    ...(time ? { time } : {}),
    ...(timeFull ? { timeFull } : {}),
    ...(row.description && row.description !== row.merchant
      ? { note: row.description }
      : {}),
    ...(row.userNote ? { userNote: row.userNote } : {}),
  };
}

export async function fetchApiTransactions(
  params: Record<string, string>,
): Promise<Txn[]> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`/api/transactions?${qs}`);
  if (!res.ok) throw new Error(`transactions request failed: ${res.status}`);
  const body = (await res.json()) as { transactions: ApiTxnRow[] };
  return body.transactions.map(apiTxnToTxn).filter((t): t is Txn => t !== null);
}
