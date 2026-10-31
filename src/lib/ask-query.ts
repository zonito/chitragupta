import { questionTerms } from "./record-search";

/**
 * Plans a full-history Ask search from a free-text records question.
 * Browser-safe and pure: given the question, the store's current month
 * and today, it works out whether the question names a month or a
 * relative period ("this week", "last month", "this year", "last 30
 * days"), which content terms remain, and how the matching rows should
 * be pulled. The actual record matching still happens in searchRecords
 * over the fetched rows — except category questions with a period,
 * which the server totals directly over the pulled set.
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
  // "with" links the question to its merchant ("spend with Air India");
  // as a search term it would poison the every-term-must-match rule.
  "with",
  // Pure framing and period words: they describe the question's shape,
  // never a merchant, so they must not reach record search as terms
  // (its every-term-must-match rule would filter the answer to zero).
  "total", "expense", "expenses", "week", "weeks", "weekly", "yearly",
  "monthly", "days", "today",
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

/**
 * The code-computed figures behind an Ask answer (POST /api/ask). Every
 * number the answer may state comes from this object — the model writes
 * prose around them and never produces a figure of its own. Amounts are
 * pounds, already scoped to the requested person via shareOf.
 */
export interface AskFigures {
  /** Total of the matched spend set. */
  total: number;
  /** Number of transactions in the matched spend set. */
  count: number;
  /** The most recent matching record, when one exists. */
  latest: { merchant: string; date: string; amount: number } | null;
  /** Per-month totals, present only when the matched set spans months. */
  perMonth: { month: string; total: number; count: number }[] | null;
  /** YYYY-MM when the question named a month, else null. */
  month: string | null;
  /** True when the match pull hit the row cap, so totals are a floor. */
  truncated: boolean;
}

export interface AskQueryPlan {
  /** YYYY-MM when the question names a month, else undefined. */
  month?: string;
  /** Inclusive YYYY-MM-DD range start, for relative periods like "this week". */
  from?: string;
  /** Inclusive YYYY-MM-DD range end (the range's last day). */
  to?: string;
  /** Content terms, with framing words and the month name removed. */
  terms: string[];
  /** Value for the API's q parameter ("" when a category filter is used). */
  apiQuery: string;
  /** Value for the API's category parameter, when a term names one. */
  category?: string;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Shift a YYYY-MM-DD date by whole days, in UTC so no timezone drift. */
function shiftDate(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The Monday of the Monday-to-Sunday week containing a YYYY-MM-DD date. */
function mondayOfWeek(ymd: string): string {
  const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay(); // 0 Sun .. 6 Sat
  return shiftDate(ymd, -((dow + 6) % 7));
}

/** Shift a YYYY-MM month key by whole months. */
function shiftMonth(monthKey: string, delta: number): string {
  const d = new Date(
    Date.UTC(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7)) - 1 + delta, 1),
  );
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

/** Today in the machine's local timezone, as YYYY-MM-DD. */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function parseAskQuery(
  question: string,
  currentMonthKey: string,
  today: string = localToday(),
): AskQueryPlan {
  const lower = question.toLowerCase();
  let month: string | undefined;
  let monthWord: string | undefined;
  let from: string | undefined;
  let to: string | undefined;
  // Words consumed by a relative-period phrase; they are question shape,
  // not content, so they never become search terms.
  const periodWords = new Set<string>();
  const baseMonth = /^\d{4}-\d{2}$/.test(today.slice(0, 7))
    ? today.slice(0, 7)
    : currentMonthKey;
  if (/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    if (/\blast\s+30\s+days\b/.test(lower)) {
      from = shiftDate(today, -29);
      to = today;
      periodWords.add("30");
      periodWords.add("days");
    } else if (/\bthis\s+week\b/.test(lower)) {
      from = mondayOfWeek(today);
      to = shiftDate(from, 6);
      periodWords.add("week");
    } else if (/\blast\s+week\b/.test(lower)) {
      const thisMonday = mondayOfWeek(today);
      from = shiftDate(thisMonday, -7);
      to = shiftDate(thisMonday, -1);
      periodWords.add("week");
    } else if (/\bthis\s+year\b/.test(lower)) {
      from = `${today.slice(0, 4)}-01-01`;
      to = today;
      periodWords.add("year");
    } else if (/\blast\s+month\b/.test(lower)) {
      month = shiftMonth(baseMonth, -1);
      periodWords.add("month");
    } else if (/\bthis\s+month\b/.test(lower)) {
      month = baseMonth;
      periodWords.add("month");
    }
  }
  if (!month && !from && /^\d{4}-\d{2}$/.test(currentMonthKey)) {
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
    (term) =>
      term !== monthWord && !FRAMING.has(term) && !periodWords.has(term),
  );
  const category =
    terms.length === 1 ? SINGLE_WORD_CATEGORIES[terms[0]!] : undefined;
  return {
    ...(month ? { month } : {}),
    ...(from && to ? { from, to } : {}),
    terms,
    apiQuery: category ? "" : (terms[0] ?? ""),
    ...(category ? { category } : {}),
  };
}
