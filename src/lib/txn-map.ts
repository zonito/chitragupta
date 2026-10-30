import type { Category, Owner, Txn } from "./data";

/**
 * Browser-safe mapping from GET /api/transactions rows to the UI Txn
 * shape, shared by Activity (older months fetched on demand) and Ask
 * (full-history record search). The mapping mirrors the snapshot builder
 * exactly — same GBP-only window, same movements, same owner and account
 * labels — so a fetched month behaves like a snapshot month.
 */

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
}

export const ACCOUNT_TXN_LABEL: Record<string, string> = {
  Main: "Revolut Main · Zonito",
  Pro: "Revolut Pro · Zonito",
  "USD-Invest": "Revolut USD-Invest · Zonito",
  Joint: "Joint Bills · Revolut",
  "Savings-9000000002": "Revolut Savings · Zonito",
  "Savings-9000000001": "Revolut Savings · Zonito",
};

const UI_CATEGORIES = new Set([
  "Groceries", "Eating out", "Transport", "School", "Home",
  "Subscriptions", "Holidays", "Shopping", "One-off",
]);

export function uiCategory(name: string): Category {
  if (name === "Transfer" || name === "Moved aside") return name;
  return (UI_CATEGORIES.has(name) ? name : "One-off") as Category;
}

export function apiTxnToTxn(row: ApiTxnRow): Txn | null {
  if (row.currency !== "GBP") return null;
  // The snapshot's txns carry spend, internal transfers and moved-aside
  // only; income, fees and interest never appear there.
  if (row.movement !== "spend" && row.movement !== "internal" && row.movement !== "aside") {
    return null;
  }
  const date = row.date.slice(0, 10);
  return {
    id: row.id,
    date,
    day: Number(date.slice(8, 10)),
    monthKey: row.month,
    merchant: row.merchant,
    category: uiCategory(row.category),
    amount: Math.abs(row.amountMinor) / 100,
    owner: row.account === "Joint" ? "joint" : (row.person as Owner),
    account: ACCOUNT_TXN_LABEL[row.account] ?? row.account,
    kind: row.movement === "spend" ? "spend" : row.movement === "aside" ? "aside" : "transfer",
    ...(row.description && row.description !== row.merchant ? { note: row.description } : {}),
  };
}

export async function fetchApiTransactions(params: Record<string, string>): Promise<Txn[]> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`/api/transactions?${qs}`);
  if (!res.ok) throw new Error(`transactions request failed: ${res.status}`);
  const body = (await res.json()) as { transactions: ApiTxnRow[] };
  return body.transactions
    .map(apiTxnToTxn)
    .filter((t): t is Txn => t !== null);
}
