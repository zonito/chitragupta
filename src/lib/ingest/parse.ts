import { createHash } from "node:crypto";

export type IngestAccount =
  | "Main"
  | "Pro"
  | "USD-Invest"
  | "Joint"
  | "Savings-9000000002"
  | "Savings-9000000001";

export const INGEST_ACCOUNTS: IngestAccount[] = [
  "Main",
  "Pro",
  "USD-Invest",
  "Joint",
  "Savings-9000000002",
  "Savings-9000000001",
];

export type StatementRow = {
  type: string;
  product: string;
  startedDate: string;
  completedDate: string;
  description: string;
  amount: string;
  fee: string;
  currency: string;
  state: string;
  balance: string;
};

export type SavingsRow = {
  date: string;
  description: string;
  moneyOut: string;
  moneyIn: string;
  balance: string;
};

function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

export function parseAccountCsv(text: string): StatementRow[] {
  const rows: StatementRow[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const f = splitCsvLine(line);
    if (f[0] === "Type") continue;
    if (f.length < 10) continue;
    rows.push({
      type: f[0]!,
      product: f[1]!,
      startedDate: f[2]!,
      completedDate: f[3]!,
      description: f[4]!,
      amount: f[5]!,
      fee: f[6]!,
      currency: f[7]!,
      state: f[8]!,
      balance: f[9]!,
    });
  }
  return rows;
}

export function parseSavingsCsv(text: string): SavingsRow[] {
  const rows: SavingsRow[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const f = splitCsvLine(line);
    if (f[0] === "Date") continue;
    if (f.length < 5) continue;
    if (!f[0] || !f[1]) continue;
    rows.push({
      date: f[0]!,
      description: f[1]!,
      moneyOut: f[2]!,
      moneyIn: f[3]!,
      balance: f[4]!,
    });
  }
  return rows;
}

export function isSavingsAccount(account: IngestAccount): boolean {
  return account.startsWith("Savings-");
}

export function fingerprint(parts: string[]): string {
  return createHash("sha256")
    .update(parts.join("\u0001"), "utf8")
    .digest("hex")
    .slice(0, 32);
}

export function statementFingerprint(
  account: IngestAccount,
  r: StatementRow,
): string {
  const effectiveDate = r.completedDate || r.startedDate;
  return fingerprint([
    account,
    effectiveDate,
    r.description,
    r.amount,
    r.fee,
    r.currency,
    r.balance,
    r.type,
    r.product,
    r.state,
  ]);
}

export function savingsFingerprint(
  account: IngestAccount,
  r: SavingsRow,
): string {
  return fingerprint([
    account,
    r.date,
    r.description,
    r.moneyOut,
    r.moneyIn,
    r.balance,
  ]);
}

export type MoneyMovement =
  "spend" | "income" | "internal" | "aside" | "fee" | "interest";

const ASIDE_PATTERNS = [
  /ibkr/i,
  /interactive brokers/i,
  /trading 212/i,
  /trading212/i,
  /investment account/i,
  /gepp.*son/i,
  /geppandsons/i,
  /vanguard/i,
  /savings.*pocket/i,
  /to pocket/i,
  /from pocket/i,
];

const NIKHILA_PATTERNS = [/nikhila/i, /dhyani/i];

const EXCHANGE_TYPE = "exchange";

export function classifyMovement(
  type: string,
  description: string,
  amountMinor: number,
  _currency: string,
): MoneyMovement {
  const t = type.toLowerCase();
  const d = description.toLowerCase();
  if (t === "reverted") return "internal";
  if (t === EXCHANGE_TYPE) return "internal";
  if (/^(withdrawal|deposit)$/i.test(description.trim()) && _currency === "GBP")
    return "internal";
  if (ASIDE_PATTERNS.some((p) => p.test(d))) return "aside";
  if (/(^|\b)(to|from)\b.*\b(pocket|savings)\b/i.test(description))
    return "aside";
  if (t === "transfer") {
    if (/^(to|from)\s+(gbp|usd|eur|inr|pro|current)\b/i.test(description))
      return "internal";
    if (
      /transfer\s+(to|from)\s+(love|zonito|arth|dhyani|nikhila)/i.test(
        description,
      )
    )
      return "internal";
    if (NIKHILA_PATTERNS.some((p) => p.test(d))) return "internal";
    if (/top-up|add money|deposit/i.test(d) && amountMinor > 0)
      return "internal";
    return amountMinor < 0 ? "aside" : "internal";
  }
  if (t === "fee" || /^(fee|revolut fee)/i.test(d)) return "fee";
  if (/gross interest|interest/i.test(d)) return "interest";
  if (t === "deposit" || t === "interest") {
    if (amountMinor < 0) return "spend";
    return "income";
  }
  if (t === "card payment" || t === "card_payment") return "spend";
  return amountMinor < 0 ? "spend" : "income";
}

export function gbpPence(amount: string): number {
  const cleaned = amount.replace(/[£,\s]/g, "");
  if (!cleaned || cleaned === "-") return 0;
  const pounds = Number(cleaned);
  if (!Number.isFinite(pounds)) return 0;
  return Math.round(pounds * 100);
}
