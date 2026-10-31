import { questionTerms } from "./record-search";

/**
 * Plans a full-history Ask search from a free-text records question.
 * Browser-safe and pure: given the question, the store's current month
 * and today, it works out whether the question names a month or a
 * relative period ("this week", "last month", "this year", "last 30
 * days"), which content terms remain, and how the matching rows should
 * be pulled. A 4-digit year stated next to a month name pins that month
 * to the stated year, and a standalone stated year becomes that year's
 * range; a year token is question shape, never a content term. The
 * actual record matching still happens in searchRecords over the
 * fetched rows — except category questions with a period, which the
 * server totals directly over the pulled set.
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

// A stated 4-digit year, 1900–2099. Years are period shape, never
// content: one sitting next to a month name pins that month, one
// standing alone scopes the question to that year, and no year token
// ever survives into the search terms (transaction text does not
// contain the year, so as a term it would match nothing).
const YEAR_TOKEN = /^(?:19|20)\d{2}$/;
const isYearToken = (term: string) => YEAR_TOKEN.test(term);

/**
 * The stated year that scopes a question with no month and no relative
 * period, or undefined when no year reads as a period. A year counts
 * as standalone when it is led by a period preposition ("in 2025"),
 * when it ends the question ("…spend 2025"), or when it is the only
 * content token. A year buried inside a merchant name ("Boiler
 * Service 2026 Ltd") meets none of these and pins nothing.
 */
function standaloneYear(lower: string, hasOtherContent: boolean): string | undefined {
  for (const match of lower.matchAll(/\b((?:19|20)\d{2})\b/g)) {
    const year = match[1]!;
    const prevWord = lower
      .slice(0, match.index)
      .match(/([a-z]+)[^a-z]*$/)?.[1];
    const hasNextWord = /[a-z]/.test(lower.slice(match.index + year.length));
    if (
      prevWord === "in" ||
      prevWord === "during" ||
      prevWord === "for" ||
      !hasNextWord ||
      !hasOtherContent
    ) {
      return year;
    }
  }
  return undefined;
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
      const mm = String(found.index + 1).padStart(2, "0");
      // A 4-digit year immediately beside the month name ("September
      // 2026", "September, 2026", "2026 September") pins the month to
      // that year, overriding the most-recent-occurrence inference. A
      // year anywhere else in the question pins nothing.
      const statedYear =
        lower
          .slice(found.at + found.name.length)
          .match(/^[\s,]*((?:19|20)\d{2})\b/)?.[1] ??
        lower.slice(0, found.at).match(/\b((?:19|20)\d{2})[\s,]*$/)?.[1];
      if (statedYear) {
        month = `${statedYear}-${mm}`;
      } else {
        // The most recent occurrence of that month not after the current one.
        const year = Number(currentMonthKey.slice(0, 4));
        const candidate = `${year}-${mm}`;
        month = candidate <= currentMonthKey ? candidate : `${year - 1}-${candidate.slice(5)}`;
      }
    }
  }
  if (!month && !from) {
    // Standalone stated year ("What did we spend in 2025?"): scope to
    // that calendar year. Relative phrases above ("this year") already
    // set a range and take precedence, so this only fires when neither
    // a month nor a relative period matched.
    const hasOtherContent = questionTerms(question).some(
      (term) => !FRAMING.has(term) && !isYearToken(term),
    );
    const year = standaloneYear(lower, hasOtherContent);
    if (year) {
      from = `${year}-01-01`;
      // The current year is capped at today, like "this year"; any
      // other year runs to its 31 December.
      to =
        /^\d{4}-\d{2}-\d{2}$/.test(today) && today.slice(0, 4) === year
          ? today
          : `${year}-12-31`;
      periodWords.add(year);
    }
  }
  const terms = questionTerms(question).filter(
    (term) =>
      term !== monthWord &&
      !FRAMING.has(term) &&
      !periodWords.has(term) &&
      !isYearToken(term),
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
