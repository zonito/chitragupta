import { questionTerms } from "./record-search";

/**
 * Plans a full-history Ask search from a free-text records question.
 * Browser-safe and pure: given the question and the store's current
 * month, it works out whether the question names a month, which content
 * terms remain, and how /api/transactions should be queried. The actual
 * record matching still happens in searchRecords over the fetched rows.
 */

const MONTH_INDEX: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

// Question-framing words that are never merchant or category content.
// The record-search stop-word list keeps some of these (they are harmless
// there because every term must match); for planning they would poison
// the term list, so they are stripped here.
const FRAMING = new Set([
  "what", "spend", "spent", "spending", "money", "transaction",
  "transactions", "record", "records", "during", "year", "went", "go", "goes",
]);

// Single-word categories the transactions API can filter on directly;
// an API q search would miss them (merchants are not named "groceries").
const SINGLE_WORD_CATEGORIES: Record<string, string> = {
  groceries: "Groceries",
  transport: "Transport",
  school: "School",
  home: "Home",
  subscriptions: "Subscriptions",
  holidays: "Holidays",
  shopping: "Shopping",
};

export interface AskQueryPlan {
  /** YYYY-MM when the question names a month, else undefined. */
  month?: string;
  /** Content terms, with framing words and the month name removed. */
  terms: string[];
  /** Value for the API's q parameter ("" when a category filter is used). */
  apiQuery: string;
  /** Value for the API's category parameter, when a term names one. */
  category?: string;
}

export function parseAskQuery(question: string, currentMonthKey: string): AskQueryPlan {
  const lower = question.toLowerCase();
  let month: string | undefined;
  let monthWord: string | undefined;
  if (/^\d{4}-\d{2}$/.test(currentMonthKey)) {
    let found: { name: string; index: number; at: number } | undefined;
    for (const [name, index] of Object.entries(MONTH_INDEX)) {
      const at = lower.search(new RegExp(`\\b${name}\\b`));
      if (at >= 0 && (!found || at < found.at)) found = { name, index, at };
    }
    if (found) {
      monthWord = found.name;
      // The most recent occurrence of that month not after the current one.
      const year = Number(currentMonthKey.slice(0, 4));
      const candidate = `${year}-${String(found.index + 1).padStart(2, "0")}`;
      month = candidate <= currentMonthKey ? candidate : `${year - 1}-${candidate.slice(5)}`;
    }
  }
  const terms = questionTerms(question).filter(
    (term) => term !== monthWord && !FRAMING.has(term),
  );
  const category =
    terms.length === 1 ? SINGLE_WORD_CATEGORIES[terms[0]!] : undefined;
  return {
    ...(month ? { month } : {}),
    terms,
    apiQuery: category ? "" : (terms[0] ?? ""),
    ...(category ? { category } : {}),
  };
}
