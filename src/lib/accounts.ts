/**
 * Browser-safe client for GET /api/accounts (per-account insights for
 * the Cards Accounts section) plus the figure-shaping the cards use.
 * The endpoint computes everything server-side from transactions; this
 * module only fetches and picks which currency a card headlines.
 */

export interface AccountInsight {
  person: string;
  account: string; // store account name
  /** Spend per currency, minor units (positive amounts). */
  spend: Record<string, number>;
  /** Money in per currency, minor units. */
  moneyIn: Record<string, number>;
  topCategories: { category: string; spend_minor: number }[];
  biggest: {
    merchant: string;
    amount_minor: number;
    currency: string;
    date: string;
  } | null;
}

export interface AccountsData {
  month: string | null; // the display month, YYYY-MM
  accounts: AccountInsight[];
}

export async function fetchAccountInsights(): Promise<AccountsData> {
  const res = await fetch("/api/accounts");
  if (!res.ok) throw new Error(`accounts request failed: ${res.status}`);
  const body = (await res.json()) as AccountsData & { ok: boolean };
  if (!body.ok) throw new Error("accounts request failed");
  return { month: body.month, accounts: body.accounts };
}

export interface PrimaryFigures {
  currency: string;
  spend: number; // pounds
  moneyIn: number; // pounds
  /** Other currencies with any activity this month, in their own
   * currency (never converted into the headline figures). */
  others: { currency: string; spend: number; moneyIn: number }[];
}

/**
 * Which currency an account card headlines: GBP whenever the account
 * has GBP figures or a GBP balance (the household's working currency),
 * else the balance currency, else the first currency with activity.
 * Everything else is reported separately in its own currency.
 */
export function primaryFigures(
  insight: AccountInsight,
  balanceCurrency: string | null,
): PrimaryFigures | null {
  const currencies = new Set([
    ...Object.keys(insight.spend),
    ...Object.keys(insight.moneyIn),
  ]);
  if (currencies.size === 0) return null;
  const pick = (c: string | null): c is string => !!c && currencies.has(c);
  const primary = pick("GBP")
    ? "GBP"
    : pick(balanceCurrency)
      ? balanceCurrency
      : [...currencies].sort()[0]!;
  const toPounds = (map: Record<string, number>, c: string) =>
    (map[c] ?? 0) / 100;
  return {
    currency: primary,
    spend: toPounds(insight.spend, primary),
    moneyIn: toPounds(insight.moneyIn, primary),
    others: [...currencies]
      .filter((c) => c !== primary)
      .sort()
      .map((c) => ({
        currency: c,
        spend: toPounds(insight.spend, c),
        moneyIn: toPounds(insight.moneyIn, c),
      })),
  };
}
