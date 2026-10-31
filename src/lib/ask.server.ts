import type Database from "better-sqlite3";
import { parseAskQuery, type AskFigures } from "./ask-query";
import {
  CATEGORIES,
  gbp,
  shareOf,
  tripAnswer,
  type Person,
  type Txn,
} from "./data";
import { searchRecords } from "./record-search";
import { apiTxnToTxn, type ApiTxnRow } from "./txn-map";
import {
  gatewayCallCount,
  gatewayConfig,
  lastGatewayStatus,
  museComplete,
  type GatewayStatus,
} from "./muse.server";

/**
 * POST /api/ask: the server half of Ask. Server-only (better-sqlite3).
 *
 * The pipeline is deliberately split so an AI model never produces a
 * number:
 *   0. Plan (model, when a key is configured): one gateway call turns
 *      the question into a validated JSON plan (kind, category, query,
 *      period). ANY invalidity in the reply — bad kind, unknown
 *      category, malformed dates — discards it, and the deterministic
 *      parser's plan is used instead, exactly as before.
 *   1. Pull (code): transactions matching the plan are read from the
 *      store across FULL history and scoped to the person with the UI's
 *      shareOf semantics.
 *   2. Compute (code): total, count, latest record and any per-month
 *      breakdown over the matched set. These are the only figures the
 *      answer may use. For "total"/"latest" plans the figures come
 *      straight from the pulled set; only "records" plans go through
 *      searchRecords matching.
 *   3. Analyse (model): one gateway call writes prose around the
 *      computed figures and up to ~50 representative rows.
 * With no key, or on any gateway failure or timeout, the answer is the
 * deterministic one composed from the same figures (ai: false) — the
 * endpoint never errors the user. The response's `gateway` field
 * reports the most recent gateway call made by this request, so a
 * failing gateway is visible instead of silent.
 */

/**
 * Safety ceiling for a computation pull, purely a memory guard. Ask
 * totals are computed over the COMPLETE filtered set: each pull first
 * counts its matches and then pulls exactly that many rows (see
 * pullComplete). `truncated` is true only when this ceiling actually
 * cut the set — never merely because a month holds many rows.
 */
const PULL_CEILING = 20_000;
const MODEL_ROW_LIMIT = 50;
const ASK_TIMEOUT_MS = 20_000;

const ASK_SYSTEM = [
  "You are Ask, the assistant inside Chitragupta, a household expense tracker.",
  "Answer the user's question using ONLY the computed figures and transaction rows provided with it.",
  "Never invent, estimate or alter a figure: every amount, count and date in your answer must come from the provided data.",
  "Amounts are in pounds; write them like £27.10.",
  "Be plain, warm and brief — a sentence or two is usually enough.",
  "If the provided data does not answer the question, say so honestly rather than guessing.",
].join(" ");

const PLANNER_SYSTEM = [
  "You are the query planner for Chitragupta, a household expense tracker.",
  "Convert the user's question into ONE JSON object and reply with ONLY that JSON object — no prose, no code fences, no explanation.",
  'Shape: {"kind":"total"|"latest"|"records"|"top","category":<category|null>,"query":<string|null>,"from":"YYYY-MM-DD"|null,"to":"YYYY-MM-DD"|null,"month":"YYYY-MM"|null,"limit":<number|null>}',
  `- category must be one of ${JSON.stringify(CATEGORIES)} when the question is about that spending category, else null.`,
  '- kind "total": the user wants amounts summed — how much, a total, the cost of a category, merchant or period.',
  '- kind "latest": the user asks when something last happened, or for the most recent matching record.',
  '- kind "top": the user asks for the biggest / top / largest N transactions (a ranked list, not a sum). Set "limit" to N when the question states one, else null. For other kinds "limit" is null.',
  '- kind "records": anything else — find or list the matching records.',
  '- query: the merchant or place named in the question (for example "Ocado", "India", "Mahavir Sweet Mart"), else null. Never invent a merchant or category the question does not imply.',
  '- Periods: "this week" is the Monday-to-Sunday week containing today (use from/to); "last week" is the Monday-to-Sunday week before it (from/to); "this year" is 1 January of this year to today (from/to); "last 30 days" is the 30 days ending today (from/to); "this month", "last month" and a named month are that single calendar month (use month; a named month is its most recent occurrence not after today). No period in the question: from, to and month are all null.',
].join(" ");

export interface AskResult {
  answer: string;
  figures: AskFigures;
  ai: boolean;
  /** The most recent gateway call this request made (planner or prose). */
  gateway: GatewayStatus;
}

/** A validated query plan, from the model planner. */
export interface AskPlan {
  kind: "total" | "latest" | "records" | "top";
  category: string | null;
  query: string | null;
  /** Inclusive range start, YYYY-MM-DD. */
  from: string | null;
  /** Inclusive range end, YYYY-MM-DD. */
  to: string | null;
  /** Single calendar month, YYYY-MM. */
  month: string | null;
  /** Rows to list for a "top" plan (1–25, default 5). */
  limit?: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

/**
 * Strictly validate a planner reply. Anything unexpected — not JSON, a
 * kind outside the enum, a category outside the app's list, malformed
 * or backwards dates — returns null, and the caller falls back to the
 * deterministic parser unchanged.
 */
export function parseAskPlan(text: string): AskPlan | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const {
    kind,
    category: rawCategory,
    query: rawQuery,
    from: rawFrom,
    to: rawTo,
    month: rawMonth,
    limit: rawLimit,
  } = parsed as Record<string, unknown>;
  if (
    kind !== "total" &&
    kind !== "latest" &&
    kind !== "records" &&
    kind !== "top"
  ) {
    return null;
  }
  // "limit" belongs to "top" plans alone: a stated value must be a
  // real number (never a string or fraction), clamped to 1–25, and an
  // absent one means the default 5. Other kinds ignore it entirely,
  // so their parsed shape is unchanged.
  let limit: number | undefined;
  if (kind === "top") {
    if (rawLimit !== null && rawLimit !== undefined) {
      if (
        typeof rawLimit !== "number" ||
        !Number.isFinite(rawLimit) ||
        !Number.isInteger(rawLimit)
      ) {
        return null;
      }
      limit = Math.min(25, Math.max(1, rawLimit));
    } else {
      limit = 5;
    }
  }
  let category: string | null = null;
  if (rawCategory !== null && rawCategory !== undefined) {
    if (typeof rawCategory !== "string") return null;
    category =
      CATEGORIES.find(
        (c) => c.toLowerCase() === rawCategory.trim().toLowerCase(),
      ) ?? null;
    if (!category) return null;
  }
  let query: string | null = null;
  if (rawQuery !== null && rawQuery !== undefined) {
    if (typeof rawQuery !== "string") return null;
    query = rawQuery.trim().slice(0, 80) || null;
  }
  let from: string | null = null;
  let to: string | null = null;
  if (rawFrom !== null && rawFrom !== undefined) {
    if (typeof rawFrom !== "string" || !isRealDate(rawFrom)) return null;
    from = rawFrom;
  }
  if (rawTo !== null && rawTo !== undefined) {
    if (typeof rawTo !== "string" || !isRealDate(rawTo)) return null;
    to = rawTo;
  }
  if ((from === null) !== (to === null)) return null;
  if (from && to && from > to) return null;
  let month: string | null = null;
  if (rawMonth !== null && rawMonth !== undefined) {
    if (
      typeof rawMonth !== "string" ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(rawMonth)
    ) {
      return null;
    }
    month = rawMonth;
  }
  // A range and a month cannot both scope the pull; the range wins.
  if (month && (from || to)) month = null;
  return {
    kind,
    category,
    query,
    from,
    to,
    month,
    ...(limit !== undefined ? { limit } : {}),
  };
}

const CATEGORY_SQL = `COALESCE(t.category, m.category,
  CASE t.movement
    WHEN 'spend' THEN 'One-off' WHEN 'income' THEN 'One-off'
    WHEN 'aside' THEN 'Moved aside' WHEN 'fee' THEN 'Fees'
    WHEN 'interest' THEN 'Interest' ELSE 'Transfer' END)`;

interface PullParams {
  month?: string;
  q?: string;
  category?: string;
  from?: string;
  to?: string;
}

/**
 * The single WHERE construction behind both the counting pull and the
 * row pull, factored so the two can never drift: a count and its pull
 * always describe exactly the same filtered set.
 */
function pullWhere(params: PullParams): { clause: string; args: unknown[] } {
  const where: string[] = [];
  const args: unknown[] = [];
  if (params.month) {
    where.push("t.year_month = ?");
    args.push(params.month);
  }
  if (params.from) {
    where.push("date(t.effective_date) >= date(?)");
    args.push(params.from);
  }
  if (params.to) {
    where.push("date(t.effective_date) <= date(?)");
    args.push(params.to);
  }
  if (params.q) {
    where.push("(t.merchant LIKE ? OR t.description LIKE ?)");
    args.push(`%${params.q}%`, `%${params.q}%`);
  }
  if (params.category) {
    where.push(`${CATEGORY_SQL} = ?`);
    args.push(params.category);
  }
  return {
    clause: where.length ? `WHERE ${where.join(" AND ")}` : "",
    args,
  };
}

/** The /api/transactions row query, reused so Ask never HTTP-calls itself. */
function pullRows(
  db: Database.Database,
  params: PullParams & { limit: number },
): ApiTxnRow[] {
  const { clause, args } = pullWhere(params);
  return db
    .prepare(
      `SELECT t.fingerprint AS id, t.person, t.account, t.effective_date AS date,
              t.year_month AS month, t.description, t.merchant,
              t.amount_minor AS amountMinor, t.currency, t.movement,
              ${CATEGORY_SQL} AS category
       FROM transactions t LEFT JOIN merchant_memory m ON m.merchant = t.merchant
       ${clause}
       ORDER BY t.effective_date DESC LIMIT ?`,
    )
    .all(...args, params.limit) as ApiTxnRow[];
}

function countRows(db: Database.Database, params: PullParams): number {
  const { clause, args } = pullWhere(params);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM transactions t LEFT JOIN merchant_memory m ON m.merchant = t.merchant
       ${clause}`,
    )
    .get(...args) as { n: number };
  return row.n;
}

/**
 * A counting pull: count the filtered set, then pull with limit = the
 * count, so computations run over the complete set. The ceiling is a
 * memory guard only; `truncated` means the ceiling actually cut the
 * set (pulled < count) and nothing else.
 */
function pullComplete(
  db: Database.Database,
  params: PullParams,
): { rows: ApiTxnRow[]; matchedCount: number; truncated: boolean } {
  const matchedCount = countRows(db, params);
  const limit = Math.min(Math.max(matchedCount, 1), PULL_CEILING);
  const rows = pullRows(db, { ...params, limit });
  return { rows, matchedCount, truncated: rows.length < matchedCount };
}

function toTxns(rows: ApiTxnRow[]): Txn[] {
  return rows
    .map(apiTxnToTxn)
    .filter((t): t is Txn => t !== null);
}

function currentMonthKey(db: Database.Database): string {
  const row = db
    .prepare("SELECT MAX(year_month) AS m FROM transactions")
    .get() as { m: string | null };
  return row.m ?? "";
}

/**
 * Whether month_aggregates record any GBP spend for this view in the
 * scoped period. The zero-match guard's ground truth: aggregates are
 * built from the same transactions, so spend there but zero matches
 * in a computation means the plan's filter — not the period — is what
 * matched nothing. An empty aggregates table (a store ingest has not
 * built yet) reads as "no spend", so the guard simply never fires.
 */
function periodHasSpend(
  db: Database.Database,
  person: Person,
  scope: { month: string | null; from: string | null; to: string | null },
): boolean {
  if (scope.month) {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(spend_minor), 0) AS s FROM month_aggregates
         WHERE person = ? AND year_month = ? AND currency = 'GBP'`,
      )
      .get(person, scope.month) as { s: number };
    return row.s > 0;
  }
  if (scope.from && scope.to) {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(spend_minor), 0) AS s FROM month_aggregates
         WHERE person = ? AND year_month BETWEEN ? AND ? AND currency = 'GBP'`,
      )
      .get(person, scope.from.slice(0, 7), scope.to.slice(0, 7)) as {
      s: number;
    };
    return row.s > 0;
  }
  return false;
}

function monthName(key: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${key}-02T00:00:00Z`));
}

/** "26 Oct 2026" for a YYYY-MM-DD date. */
function dayName(ymd: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${ymd}T00:00:00Z`));
}

/** Today in the server's local timezone, as YYYY-MM-DD. */
function serverToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Penny-exact rounding so the figures JSON carries no float dust. */
const pennies = (n: number) => Math.round(n * 100) / 100;

function buildFigures(
  spend: Txn[],
  amountPerson: Person,
  latest: AskFigures["latest"],
  month: string | null,
  truncated: boolean,
  topList?: NonNullable<AskFigures["top"]>,
): AskFigures {
  const total = pennies(
    spend.reduce((s, t) => s + shareOf(t, amountPerson), 0),
  );
  const byMonth = new Map<string, { total: number; count: number }>();
  for (const t of spend) {
    const entry = byMonth.get(t.monthKey) ?? { total: 0, count: 0 };
    entry.total += shareOf(t, amountPerson);
    entry.count += 1;
    byMonth.set(t.monthKey, entry);
  }
  for (const entry of byMonth.values()) entry.total = pennies(entry.total);
  return {
    total,
    count: spend.length,
    latest,
    // A top answer's figures describe the listed rows alone; a
    // per-month split of a ranking would read as period totals.
    perMonth:
      topList || byMonth.size <= 1
        ? null
        : [...byMonth.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([m, v]) => ({ month: m, total: v.total, count: v.count })),
    month,
    truncated,
    ...(topList ? { top: topList } : {}),
  };
}

function latestOf(txns: Txn[], amountPerson: Person): AskFigures["latest"] {
  const best = [...txns].sort((a, b) => b.date.localeCompare(a.date))[0];
  return best
    ? {
        merchant: best.merchant,
        date: dayName(best.date),
        amount: pennies(shareOf(best, amountPerson)),
      }
    : null;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const noRecordsText = (person: Person) =>
  `No matching transactions or documents in ${person === "household" ? "the household" : "your"} records. This does not mean it never happened; it is not recorded here.`;

interface ComputedSet {
  spend: Txn[];
  matched: Txn[];
  deterministic: string;
}

/**
 * Figures computed DIRECTLY over a pulled set — no record-search
 * re-filtering. Used for "total" and "latest" plans (model or
 * deterministic): the pull already scoped the set, so the answer is a
 * plain sum / newest row over the person's share of it.
 */
function directComputation(
  txns: Txn[],
  person: Person,
  kind: "total" | "latest",
  label: string,
  periodPhrase: string,
  truncated: boolean,
): ComputedSet {
  const visible = txns.filter((t) => shareOf(t, person) > 0);
  const spend = visible.filter((t) => t.kind === "spend");
  const total = spend.reduce((s, t) => s + shareOf(t, person), 0);
  if (kind === "latest") {
    const latest = latestOf(spend.length > 0 ? spend : visible, person);
    if (!latest) return { spend, matched: visible, deterministic: noRecordsText(person) };
    let deterministic = `The latest matching record is ${latest.merchant}, dated ${latest.date} — ${gbp(latest.amount)}.`;
    if (spend.length > 1) {
      deterministic += ` Total across ${spend.length} matching transactions: ${gbp(total)}.`;
    }
    if (truncated) {
      deterministic +=
        " Totals are partial: the matching set exceeded the safety ceiling and was cut.";
    }
    return { spend, matched: visible, deterministic };
  }
  const deterministic =
    spend.length === 0
      ? `No ${label} spending${periodPhrase} — the total is ${gbp(0)}.`
      : `${label}${periodPhrase}: ${gbp(total)} across ${spend.length} ${plural(spend.length, "transaction", "transactions")}.`;
  return { spend, matched: visible, deterministic };
}

/**
 * The top-N path: rank a pulled set's spend by the person's share,
 * biggest first (ties: newest first, then merchant, then id, so the
 * order is fully deterministic), and list the first N. The figures
 * describe the listed rows alone — their sum is the answer's total,
 * never the whole period's.
 */
function topComputation(
  txns: Txn[],
  person: Person,
  n: number,
  periodPhrase: string,
): { set: ComputedSet; topList: NonNullable<AskFigures["top"]> } {
  const visible = txns.filter((t) => shareOf(t, person) > 0);
  const spend = visible.filter((t) => t.kind === "spend");
  const ranked = [...spend].sort(
    (a, b) =>
      shareOf(b, person) - shareOf(a, person) ||
      b.date.localeCompare(a.date) ||
      a.merchant.localeCompare(b.merchant) ||
      a.id.localeCompare(b.id),
  );
  const listed = ranked.slice(0, Math.max(1, n));
  const topList = listed.map((t) => ({
    merchant: t.merchant,
    date: dayName(t.date),
    amount: pennies(shareOf(t, person)),
  }));
  const total = listed.reduce((s, t) => s + shareOf(t, person), 0);
  const deterministic =
    listed.length === 0
      ? `No spending${periodPhrase} — there is nothing to rank.`
      : [
          `Your ${listed.length} biggest ${plural(listed.length, "transaction", "transactions")}${periodPhrase}:`,
          ...listed.map(
            (t) =>
              `${dayName(t.date)} · ${t.merchant} — ${gbp(pennies(shareOf(t, person)))}`,
          ),
          `Together: ${gbp(total)}.`,
        ].join("\n");
  return {
    set: { spend: listed, matched: listed, deterministic },
    topList,
  };
}

/**
 * The records path: searchRecords matching over a pulled set, with the
 * scoped question already reduced to content terms (framing words like
 * "total" and "week" stripped by the planner/parser layers, so the
 * every-term-must-match rule cannot filter a good pull to zero).
 */
function recordsComputation(
  question: string,
  scopedQuestion: string,
  person: Person,
  txns: Txn[],
  truncated: boolean,
): ComputedSet {
  let result = searchRecords(scopedQuestion, person, [], txns);
  if (result.records.length === 0 && scopedQuestion !== question) {
    const alt = searchRecords(question, person, [], txns);
    if (alt.records.length > 0) result = alt;
  }
  const seen = new Map<string, Txn>();
  for (const record of result.records) {
    if (record.transaction) seen.set(record.transaction.id, record.transaction);
  }
  const matched = [...seen.values()];
  const spend = matched.filter((t) => t.kind === "spend");
  const latest = result.latest;
  const total = spend.reduce((s, t) => s + shareOf(t, person), 0);
  let deterministic: string;
  if (result.warrantyQuestion) {
    deterministic = latest
      ? "The matching records do not include a warranty end date."
      : noRecordsText(person);
  } else if (latest) {
    deterministic = `The latest matching record is ${latest.merchant}, dated ${latest.date} — ${gbp(latest.amount)}.`;
    if (spend.length > 1) {
      deterministic += ` Total across ${spend.length} matching transactions: ${gbp(total)}.`;
    }
    if (truncated) {
      deterministic +=
        " Totals are partial: the matching set exceeded the safety ceiling and was cut.";
    }
  } else {
    deterministic = noRecordsText(person);
  }
  return { spend, matched, deterministic };
}

export async function answerAsk(
  db: Database.Database,
  opts: {
    question: string;
    person?: string;
    today?: string;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
  },
): Promise<AskResult> {
  const question = opts.question;
  const person: Person =
    opts.person === "zonito" || opts.person === "nikhila"
      ? opts.person
      : "household";
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const today = opts.today ?? serverToday();
  const current = currentMonthKey(db);
  const det = parseAskQuery(question, current, today);

  // Gateway diagnostics for THIS request: poll the shared client's call
  // counter after each call so the response can report the first
  // failure (or the last outcome) of the calls made here.
  let gatewaySeen = gatewayCallCount();
  let gatewayLast: GatewayStatus | undefined;
  let gatewayFailure: GatewayStatus | undefined;
  const pollGateway = () => {
    const count = gatewayCallCount();
    if (count > gatewaySeen) {
      gatewaySeen = count;
      const status = lastGatewayStatus();
      gatewayLast = status;
      if (!status.ok && !gatewayFailure) gatewayFailure = status;
    }
  };
  const gateway = (): GatewayStatus =>
    gatewayFailure ?? gatewayLast ?? { attempted: false, ok: false, provider: null };

  // 0. Plan: the model planner runs first when a key is configured; a
  // reply that fails strict validation is discarded wholesale.
  let modelPlan: AskPlan | null = null;
  if (gatewayConfig(env) !== null) {
    const weekday = new Intl.DateTimeFormat("en-GB", {
      weekday: "long",
      timeZone: "UTC",
    }).format(new Date(`${today}T00:00:00Z`));
    const planText = await museComplete({
      system: PLANNER_SYSTEM,
      prompt: [
        `Today is ${today} (${weekday}). The current month is ${current}.`,
        `Question: ${question}`,
      ].join("\n"),
      maxTokens: 300,
      timeoutMs: ASK_TIMEOUT_MS,
      env,
      fetchImpl,
    });
    pollGateway();
    if (planText) modelPlan = parseAskPlan(planText);
  }

  let spend: Txn[] = [];
  let matched: Txn[] = [];
  let amountPerson: Person = person;
  let truncated = false;
  let deterministic = "";
  let figuresMonth: string | null = null;
  let scopeLine: string | null = null;
  let topList: NonNullable<AskFigures["top"]> | undefined;
  let topN = 5;
  // The zero-match guard's view of this answer: its shape, and the
  // period scope the pull actually used. Only total/top shapes over a
  // known period can be guarded — records/latest empties are honest
  // "not recorded here" answers, and the worked examples carry their
  // own empty copy.
  let shape: "total" | "latest" | "records" | "top" | "example" = "records";
  let scopeMonth: string | null = null;
  let scopeFrom: string | null = null;
  let scopeTo: string | null = null;

  const periodPhrase = (month: string | null, from: string | null, to: string | null) =>
    month
      ? ` in ${monthName(month)}`
      : from && to
        ? ` (${dayName(from)} – ${dayName(to)})`
        : "";

  const isOcadoExample =
    /ocado/i.test(question) && !/last|receipt|document/i.test(question);
  const isTripExample =
    !isOcadoExample &&
    /holiday/i.test(question) &&
    /cost|spend|spent|total/i.test(question);

  if (modelPlan) {
    const pull = pullComplete(db, {
      ...(modelPlan.month ? { month: modelPlan.month } : {}),
      ...(modelPlan.from && modelPlan.to
        ? { from: modelPlan.from, to: modelPlan.to }
        : {}),
      ...(modelPlan.category
        ? { category: modelPlan.category }
        : modelPlan.query
          ? { q: modelPlan.query }
          : {}),
    });
    const txns = toTxns(pull.rows);
    truncated = pull.truncated;
    figuresMonth = modelPlan.month;
    scopeMonth = modelPlan.month;
    scopeFrom = modelPlan.from;
    scopeTo = modelPlan.to;
    const phrase = periodPhrase(modelPlan.month, modelPlan.from, modelPlan.to);
    if (phrase) scopeLine = `The figures cover${phrase}.`;
    const searchable =
      modelPlan.kind === "records" &&
      (modelPlan.query !== null || det.terms.length > 0);
    if (modelPlan.kind === "top") {
      shape = "top";
      topN = modelPlan.limit ?? 5;
      const computed = topComputation(txns, person, topN, phrase);
      spend = computed.set.spend;
      matched = computed.set.matched;
      deterministic = computed.set.deterministic;
      topList = computed.topList;
    } else if (searchable) {
      shape = "records";
      const scoped =
        modelPlan.query ??
        (det.terms.length > 0 ? det.terms.join(" ") : question);
      const computed = recordsComputation(question, scoped, person, txns, truncated);
      spend = computed.spend;
      matched = computed.matched;
      deterministic = computed.deterministic;
    } else {
      shape = modelPlan.kind === "latest" ? "latest" : "total";
      const label =
        modelPlan.category ??
        (modelPlan.query ? `Spending matching "${modelPlan.query}"` : "Total spend");
      const computed = directComputation(
        txns,
        person,
        modelPlan.kind === "latest" ? "latest" : "total",
        label,
        phrase,
        truncated,
      );
      spend = computed.spend;
      matched = computed.matched;
      deterministic = computed.deterministic;
    }
  } else if (det.top !== undefined) {
    // A list question with no gateway (or a discarded plan): rank the
    // period pull directly. Period and category come from the
    // deterministic parser; the ranking words themselves never become
    // a text search.
    shape = "top";
    topN = det.top;
    scopeMonth = det.month ?? null;
    scopeFrom = det.from ?? null;
    scopeTo = det.to ?? null;
    const pull = pullComplete(db, {
      ...(det.month ? { month: det.month } : {}),
      ...(det.from && det.to ? { from: det.from, to: det.to } : {}),
      ...(det.category ? { category: det.category } : {}),
    });
    const txns = toTxns(pull.rows);
    truncated = pull.truncated;
    figuresMonth = det.month ?? null;
    const phrase = periodPhrase(det.month ?? null, det.from ?? null, det.to ?? null);
    if (phrase) scopeLine = `The figures cover${phrase}.`;
    const computed = topComputation(txns, person, topN, phrase);
    spend = computed.set.spend;
    matched = computed.set.matched;
    deterministic = computed.set.deterministic;
    topList = computed.topList;
  } else if (isOcadoExample || isTripExample) {
    shape = "example";
    const isOcado = isOcadoExample;
    const pull = pullComplete(db, {
      ...(current ? { month: current } : {}),
    });
    const txns = toTxns(pull.rows);
    truncated = pull.truncated;
    let orders: Txn[];
    let fallback: boolean;
    if (!isOcado) {
      const answer = tripAnswer(person, txns);
      orders = answer.orders;
      fallback = answer.fallback;
      amountPerson = answer.answerPerson;
    } else {
      // ocadoAnswer over the pulled current month (it reads the snapshot
      // TXNS itself, so its few lines are mirrored here).
      const household = txns.filter(
        (t) => t.kind === "spend" && /^ocado/i.test(t.merchant),
      );
      const own = household.filter((t) => shareOf(t, person) > 0);
      fallback = own.length === 0;
      amountPerson = fallback ? "household" : person;
      orders = fallback ? household : own;
    }
    spend = orders;
    matched = orders;
    const total = orders.reduce((s, t) => s + shareOf(t, amountPerson), 0);
    const label = isOcado ? "Ocado" : "Holidays";
    const unit = isOcado ? "order" : "booking";
    if (orders.length === 0) {
      deterministic = isOcado
        ? "No Ocado orders this month."
        : "No Holidays charges this month.";
    } else if (fallback && person !== "household") {
      deterministic = `No ${label} ${plural(orders.length, unit, `${unit}s`)} on your own accounts; the household total is ${gbp(total)} across ${orders.length} ${plural(orders.length, unit, `${unit}s`)} this month.`;
    } else {
      deterministic = `${label} this month: ${gbp(total)} across ${orders.length} ${plural(orders.length, unit, `${unit}s`)}.`;
    }
  } else {
    const hasScope = Boolean(det.month || det.from);
    if (det.category && hasScope) {
      // Category question with a period: total the pulled category set
      // directly — record search would re-filter it away, because its
      // terms ("transport", "week") are not transaction text.
      const pull = pullComplete(db, {
        ...(det.month ? { month: det.month } : {}),
        ...(det.from && det.to ? { from: det.from, to: det.to } : {}),
        category: det.category,
      });
      const txns = toTxns(pull.rows);
      truncated = pull.truncated;
      figuresMonth = det.month ?? null;
      shape = "total";
      scopeMonth = det.month ?? null;
      scopeFrom = det.from ?? null;
      scopeTo = det.to ?? null;
      const phrase = periodPhrase(det.month ?? null, det.from ?? null, det.to ?? null);
      if (phrase) scopeLine = `The figures cover${phrase}.`;
      const computed = directComputation(txns, person, "total", det.category, phrase, truncated);
      spend = computed.spend;
      matched = computed.matched;
      deterministic = computed.deterministic;
    } else if (det.from && det.to && !det.category && det.terms.length === 0) {
      // A bare period question ("how much did we spend this week?"):
      // total everything in the range.
      const pull = pullComplete(db, { from: det.from, to: det.to });
      const txns = toTxns(pull.rows);
      truncated = pull.truncated;
      shape = "total";
      scopeFrom = det.from;
      scopeTo = det.to;
      const phrase = periodPhrase(null, det.from, det.to);
      if (phrase) scopeLine = `The figures cover${phrase}.`;
      const computed = directComputation(txns, person, "total", "Total spend", phrase, truncated);
      spend = computed.spend;
      matched = computed.matched;
      deterministic = computed.deterministic;
    } else {
      const pull = pullComplete(db, {
        ...(det.month ? { month: det.month } : {}),
        ...(det.from && det.to ? { from: det.from, to: det.to } : {}),
        ...(det.category
          ? { category: det.category }
          : det.apiQuery
            ? { q: det.apiQuery }
            : {}),
      });
      const txns = toTxns(pull.rows);
      truncated = pull.truncated;
      figuresMonth = det.month ?? null;
      const monthOnly = Boolean(det.month && det.terms.length === 0 && !det.category);
      shape = monthOnly ? "total" : "records";
      scopeMonth = det.month ?? null;
      scopeFrom = det.from ?? null;
      scopeTo = det.to ?? null;
      if (monthOnly) {
        matched = txns.filter((t) => shareOf(t, person) > 0);
        spend = matched.filter((t) => t.kind === "spend");
        const label = monthName(det.month!);
        const total = spend.reduce((s, t) => s + shareOf(t, person), 0);
        deterministic =
          spend.length === 0
            ? `Total in ${label}: ${gbp(0)}.`
            : `${gbp(total)} spent in ${label} across ${spend.length} ${plural(spend.length, "transaction", "transactions")}.`;
      } else {
        const scopedQuestion =
          det.terms.length > 0 ? det.terms.join(" ") : question;
        const computed = recordsComputation(
          question,
          scopedQuestion,
          person,
          txns,
          truncated,
        );
        spend = computed.spend;
        matched = computed.matched;
        deterministic = computed.deterministic;
      }
    }
  }

  // Zero-match guard: a total/top computation that matched nothing in
  // a period month_aggregates show HAS spend for this view means the
  // plan's filter broke — not that the period was empty. Presenting
  // that £0.00 as the answer is the one unacceptable output (it is
  // exactly what "Top 5 transactions for this month" produced when
  // the planner mapped the list question onto a filtered total).
  // Recompute over the period's UNFILTERED pull — a plain total, or
  // the unfiltered ranking for a list question — and say plainly that
  // the specific search matched nothing. Records/latest shapes never
  // reach here: their empty answers are honest "not recorded" claims.
  if (
    (shape === "total" || shape === "top") &&
    spend.length === 0 &&
    matched.length === 0 &&
    (scopeMonth !== null || (scopeFrom !== null && scopeTo !== null)) &&
    periodHasSpend(db, person, {
      month: scopeMonth,
      from: scopeFrom,
      to: scopeTo,
    })
  ) {
    const pull = pullComplete(db, {
      ...(scopeMonth ? { month: scopeMonth } : {}),
      ...(scopeFrom && scopeTo ? { from: scopeFrom, to: scopeTo } : {}),
    });
    const txns = toTxns(pull.rows);
    truncated = pull.truncated;
    figuresMonth = scopeMonth;
    const phrase = periodPhrase(scopeMonth, scopeFrom, scopeTo);
    if (phrase) scopeLine = `The figures cover${phrase}.`;
    if (shape === "top") {
      const computed = topComputation(txns, person, topN, phrase);
      if (computed.set.spend.length > 0) {
        spend = computed.set.spend;
        matched = computed.set.matched;
        topList = computed.topList;
        deterministic = `Nothing matched that specific search${phrase}; the unfiltered ranking is:\n${computed.set.deterministic}`;
      }
    } else {
      const computed = directComputation(
        txns,
        person,
        "total",
        "Total spend",
        phrase,
        truncated,
      );
      if (computed.spend.length > 0) {
        const total = computed.spend.reduce(
          (s, t) => s + shareOf(t, person),
          0,
        );
        spend = computed.spend;
        matched = computed.matched;
        deterministic = `Nothing matched that specific search${phrase}. Total spend${phrase} was ${gbp(total)} across ${computed.spend.length} ${plural(computed.spend.length, "transaction", "transactions")}.`;
      }
    }
    if (spend.length === 0) {
      // Aggregates claim spend the pull cannot see: distrust both
      // rather than present either as fact, and say the question
      // could not be interpreted.
      deterministic =
        "I couldn't interpret that question against your records. Try naming a merchant, a category or a month.";
      topList = undefined;
    }
  }

  const figures = buildFigures(
    spend,
    amountPerson,
    matched.length > 0 ? latestOf(matched, amountPerson) : null,
    figuresMonth,
    truncated,
    topList,
  );

  // Analyse: one gateway call. The model sees the computed figures plus
  // representative rows only — never the whole store.
  const representative = [...matched]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, MODEL_ROW_LIMIT);
  const promptLines = [
    `Question: ${question}`,
    `View: ${person === "household" ? "Household" : person === "zonito" ? "Zonito" : "Nikhila"}`,
    `Computed figures (the only numbers you may use):`,
    `- Total of the matched spend set: ${gbp(figures.total)}`,
    `- Matching spend transactions: ${figures.count}`,
    ...(figures.latest
      ? [
          `- Latest matching record: ${figures.latest.merchant}, ${figures.latest.date}, ${gbp(figures.latest.amount)}`,
        ]
      : [`- Latest matching record: none`]),
    ...(figures.month
      ? [`- The question names the month ${monthName(figures.month)}.`]
      : scopeLine
        ? [`- ${scopeLine}`]
        : []),
    ...(figures.perMonth
      ? [
          `- Per-month breakdown: ${figures.perMonth
            .map((m) => `${m.month}: ${gbp(m.total)} across ${m.count}`)
            .join("; ")}`,
        ]
      : []),
    ...(figures.truncated
      ? [
          `- Note: the matching set exceeded the safety ceiling, so these totals cover only part of it.`,
        ]
      : []),
    ...(figures.top
      ? [
          `- This answer is a ranked list: the total above is the sum of the listed transactions only, not a period total.`,
          `- Largest first: ${figures.top
            .map((t) => `${t.date} · ${t.merchant} · ${gbp(t.amount)}`)
            .join("; ")}`,
        ]
      : []),
    `Representative transactions (most recent first):`,
    ...(representative.length > 0
      ? representative.map(
          (t) =>
            `${t.date} · ${t.merchant} · ${gbp(shareOf(t, amountPerson))} · ${t.category}`,
        )
      : [`(none)`]),
  ];
  const prose = await museComplete({
    system: ASK_SYSTEM,
    prompt: promptLines.join("\n"),
    maxTokens: 600,
    timeoutMs: ASK_TIMEOUT_MS,
    env,
    fetchImpl,
  });
  pollGateway();
  if (prose) return { answer: prose, figures, ai: true, gateway: gateway() };
  return { answer: deterministic, figures, ai: false, gateway: gateway() };
}
