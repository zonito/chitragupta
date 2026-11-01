/**
 * Amount matching for Activity search, shared by the client filter
 * (snapshot months) and the /api/transactions q path (fetched
 * months), so a query behaves identically however the rows arrived.
 * Browser-safe and pure: unit-testable without rendering or a store.
 *
 * A query is an amount query when, after stripping £ signs, commas
 * and spaces, it is a plain non-negative number with at most two
 * decimal places ("148", "148.00", "£1,284", "7.45"). Anything else
 * ("ocado", "12.345", "-5", "1e3") is not, and search falls back to
 * the merchant/note text match exactly as before.
 *
 * An amount query matches a transaction when EITHER
 *  - the absolute amount equals the parsed value exactly, or
 *  - the amount's canonical two-decimal string ("128.04", the way
 *    the amount is displayed, without £ or thousands separators)
 *    starts with the query text — so "128" finds £128.04 and
 *    £1,284.00 alike, and "7.4" finds £7.45.
 */

export interface AmountQuery {
  /** The parsed value in minor units (pence). */
  minor: number;
  /** The normalised query text ("128", "7.45") for prefix matching. */
  text: string;
}

export function parseAmountQuery(raw: string): AmountQuery | null {
  const cleaned = raw.replace(/[£,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return { minor: Math.round(value * 100), text: cleaned };
}

/** Does an absolute amount (major units, e.g. 128.04) match? */
export function amountMatchesQuery(
  absMajor: number,
  query: AmountQuery,
): boolean {
  const minor = Math.round(absMajor * 100);
  if (minor === query.minor) return true;
  return (minor / 100).toFixed(2).startsWith(query.text);
}
