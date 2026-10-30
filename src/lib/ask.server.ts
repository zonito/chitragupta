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

const PULL_LIMIT = 200;
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
  'Shape: {"kind":"total"|"latest"|"records","category":<category|null>,"query":<string|null>,"from":"YYYY-MM-DD"|null,"to":"YYYY-MM-DD"|null,"month":"YYYY-MM"|null}',
  `- category must be one of ${JSON.stringify(CATEGORIES)} when the question is about that spending category, else null.`,
  '- kind "total": the user wants amounts summed — how much, a total, the cost of a category, merchant or period.',
  '- kind "latest": the user asks when something last happened, or for the most recent matching record.',
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
  kind: "total" | "latest" | "records";
  category: string | null;
  query: string | null;
  /** Inclusive range start, YYYY-MM-DD. */
  from: string | null;
  /** Inclusive range end, YYYY-MM-DD. */
  to: string | null;
  /** Single calendar month, YYYY-MM. */
  month: string | null;
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
  } = parsed as Record<string, unknown>;
  if (kind !== "total" && kind !== "latest" && kind !== "records") {
    return null;
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
  return { kind, category, query, from, to, month };
}

const CATEGORY_SQL = `COALESCE(t.category, m.category,
  CASE t.movement
    WHEN 'spend' THEN 'One-off' WHEN 'income' THEN 'One-off'
    WHEN 'aside' THEN 'Moved aside' WHEN 'fee' THEN 'Fees'
    WHEN 'interest' THEN 'Interest' ELSE 'Transfer' END)`;

/** The /api/transactions row query, reused so Ask never HTTP-calls itself. */
function pullRows(
  db: Database.Database,
  params: {
    month?: string;
    q?: string;
    category?: string;
    from?: string;
    to?: string;
    limit: number;
  },
): ApiTxnRow[] {
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
  return db
    .prepare(
      `SELECT t.fingerprint AS id, t.person, t.account, t.effective_date AS date,
              t.year_month AS month, t.description, t.merchant,
              t.amount_minor AS amountMinor, t.currency, t.movement,
              ${CATEGORY_SQL} AS category
       FROM transactions t LEFT JOIN merchant_memory m ON m.merchant = t.merchant
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY t.effective_date DESC LIMIT ?`,
    )
    .all(...args, params.limit) as ApiTxnRow[];
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
    perMonth:
      byMonth.size > 1
        ? [...byMonth.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([m, v]) => ({ month: m, total: v.total, count: v.count }))
        : null,
    month,
    truncated,
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
      deterministic += " Totals cover the most recent 200 matches.";
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
      deterministic += " Totals cover the most recent 200 matches.";
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
    const rows = pullRows(db, {
      ...(modelPlan.month ? { month: modelPlan.month } : {}),
      ...(modelPlan.from && modelPlan.to
        ? { from: modelPlan.from, to: modelPlan.to }
        : {}),
      ...(modelPlan.category
        ? { category: modelPlan.category }
        : modelPlan.query
          ? { q: modelPlan.query }
          : {}),
      limit: PULL_LIMIT,
    });
    const txns = toTxns(rows);
    truncated = rows.length >= PULL_LIMIT;
    figuresMonth = modelPlan.month;
    const phrase = periodPhrase(modelPlan.month, modelPlan.from, modelPlan.to);
    if (phrase) scopeLine = `The figures cover${phrase}.`;
    const searchable =
      modelPlan.kind === "records" &&
      (modelPlan.query !== null || det.terms.length > 0);
    if (searchable) {
      const scoped =
        modelPlan.query ??
        (det.terms.length > 0 ? det.terms.join(" ") : question);
      const computed = recordsComputation(question, scoped, person, txns, truncated);
      spend = computed.spend;
      matched = computed.matched;
      deterministic = computed.deterministic;
    } else {
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
  } else if (isOcadoExample || isTripExample) {
    const isOcado = isOcadoExample;
    const rows = pullRows(db, {
      ...(current ? { month: current } : {}),
      limit: PULL_LIMIT,
    });
    const txns = toTxns(rows);
    truncated = rows.length >= PULL_LIMIT;
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
      const rows = pullRows(db, {
        ...(det.month ? { month: det.month } : {}),
        ...(det.from && det.to ? { from: det.from, to: det.to } : {}),
        category: det.category,
        limit: PULL_LIMIT,
      });
      const txns = toTxns(rows);
      truncated = rows.length >= PULL_LIMIT;
      figuresMonth = det.month ?? null;
      const phrase = periodPhrase(det.month ?? null, det.from ?? null, det.to ?? null);
      if (phrase) scopeLine = `The figures cover${phrase}.`;
      const computed = directComputation(txns, person, "total", det.category, phrase, truncated);
      spend = computed.spend;
      matched = computed.matched;
      deterministic = computed.deterministic;
    } else if (det.from && det.to && !det.category && det.terms.length === 0) {
      // A bare period question ("how much did we spend this week?"):
      // total everything in the range.
      const rows = pullRows(db, { from: det.from, to: det.to, limit: PULL_LIMIT });
      const txns = toTxns(rows);
      truncated = rows.length >= PULL_LIMIT;
      const phrase = periodPhrase(null, det.from, det.to);
      if (phrase) scopeLine = `The figures cover${phrase}.`;
      const computed = directComputation(txns, person, "total", "Total spend", phrase, truncated);
      spend = computed.spend;
      matched = computed.matched;
      deterministic = computed.deterministic;
    } else {
      const rows = pullRows(db, {
        ...(det.month ? { month: det.month } : {}),
        ...(det.from && det.to ? { from: det.from, to: det.to } : {}),
        ...(det.category
          ? { category: det.category }
          : det.apiQuery
            ? { q: det.apiQuery }
            : {}),
        limit: PULL_LIMIT,
      });
      const txns = toTxns(rows);
      truncated = rows.length >= PULL_LIMIT;
      figuresMonth = det.month ?? null;
      const monthOnly = Boolean(det.month && det.terms.length === 0 && !det.category);
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

  const figures = buildFigures(
    spend,
    amountPerson,
    matched.length > 0 ? latestOf(matched, amountPerson) : null,
    figuresMonth,
    truncated,
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
      ? [`- Note: only the most recent 200 matches were totalled.`]
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
