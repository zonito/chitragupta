import type Database from "better-sqlite3";
import { parseAskQuery, type AskFigures } from "./ask-query";
import { gbp, shareOf, tripAnswer, type Person, type Txn } from "./data";
import { searchRecords } from "./record-search";
import { apiTxnToTxn, type ApiTxnRow } from "./txn-map";
import { museComplete } from "./muse.server";

/**
 * POST /api/ask: the server half of Ask. Server-only (better-sqlite3).
 *
 * The pipeline is deliberately split so an AI model never produces a
 * number:
 *   1. Pull (code): the ask-query parser plans the question, matching
 *      transactions are read from the store across FULL history and
 *      scoped to the person with the UI's shareOf semantics.
 *   2. Compute (code): total, count, latest record and any per-month
 *      breakdown over the matched set. These are the only figures the
 *      answer may use.
 *   3. Analyse (model): one gateway call writes prose around the
 *      computed figures and up to ~50 representative rows.
 * With no key, or on any gateway failure or timeout, the answer is the
 * deterministic one composed from the same figures (ai: false) — the
 * endpoint never errors the user.
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

export interface AskResult {
  answer: string;
  figures: AskFigures;
  ai: boolean;
}

const CATEGORY_SQL = `COALESCE(t.category, m.category,
  CASE t.movement
    WHEN 'spend' THEN 'One-off' WHEN 'income' THEN 'One-off'
    WHEN 'aside' THEN 'Moved aside' WHEN 'fee' THEN 'Fees'
    WHEN 'interest' THEN 'Interest' ELSE 'Transfer' END)`;

/** The /api/transactions row query, reused so Ask never HTTP-calls itself. */
function pullRows(
  db: Database.Database,
  params: { month?: string; q?: string; category?: string; limit: number },
): ApiTxnRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (params.month) {
    where.push("t.year_month = ?");
    args.push(params.month);
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
        date: new Intl.DateTimeFormat("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
          timeZone: "UTC",
        }).format(new Date(`${best.date}T00:00:00Z`)),
        amount: pennies(shareOf(best, amountPerson)),
      }
    : null;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export async function answerAsk(
  db: Database.Database,
  opts: {
    question: string;
    person?: string;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
  },
): Promise<AskResult> {
  const question = opts.question;
  const person: Person =
    opts.person === "zonito" || opts.person === "nikhila"
      ? opts.person
      : "household";
  const current = currentMonthKey(db);
  const plan = parseAskQuery(question, current);

  let spend: Txn[] = [];
  let matched: Txn[] = [];
  let amountPerson: Person = person;
  let truncated = false;
  let deterministic = "";

  const isOcado =
    /ocado/i.test(question) && !/last|receipt|document/i.test(question);
  const isTrip =
    !isOcado && /holiday/i.test(question) && /cost|spend|spent|total/i.test(question);

  if (isOcado || isTrip) {
    const rows = pullRows(db, {
      ...(current ? { month: current } : {}),
      limit: PULL_LIMIT,
    });
    const txns = toTxns(rows);
    truncated = rows.length >= PULL_LIMIT;
    let orders: Txn[];
    let fallback: boolean;
    if (isTrip) {
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
    const label = isTrip ? "Holidays" : "Ocado";
    const unit = isTrip ? "booking" : "order";
    if (orders.length === 0) {
      deterministic = isTrip
        ? "No Holidays charges this month."
        : "No Ocado orders this month.";
    } else if (fallback && person !== "household") {
      deterministic = `No ${label} ${plural(orders.length, unit, `${unit}s`)} on your own accounts; the household total is ${gbp(total)} across ${orders.length} ${plural(orders.length, unit, `${unit}s`)} this month.`;
    } else {
      deterministic = `${label} this month: ${gbp(total)} across ${orders.length} ${plural(orders.length, unit, `${unit}s`)}.`;
    }
  } else {
    const rows = pullRows(db, {
      ...(plan.month ? { month: plan.month } : {}),
      ...(plan.category
        ? { category: plan.category }
        : plan.apiQuery
          ? { q: plan.apiQuery }
          : {}),
      limit: PULL_LIMIT,
    });
    const txns = toTxns(rows);
    truncated = rows.length >= PULL_LIMIT;
    const monthOnly = Boolean(plan.month && plan.terms.length === 0 && !plan.category);
    if (monthOnly) {
      matched = txns.filter((t) => shareOf(t, person) > 0);
      spend = matched.filter((t) => t.kind === "spend");
      const label = monthName(plan.month!);
      const total = spend.reduce((s, t) => s + shareOf(t, person), 0);
      deterministic =
        spend.length === 0
          ? `Total in ${label}: ${gbp(0)}.`
          : `${gbp(total)} spent in ${label} across ${spend.length} ${plural(spend.length, "transaction", "transactions")}.`;
    } else {
      const scopedQuestion =
        plan.terms.length > 0 ? plan.terms.join(" ") : question;
      let result = searchRecords(scopedQuestion, person, [], txns);
      if (result.records.length === 0 && scopedQuestion !== question) {
        const alt = searchRecords(question, person, [], txns);
        if (alt.records.length > 0) result = alt;
      }
      const seen = new Map<string, Txn>();
      for (const record of result.records) {
        if (record.transaction) seen.set(record.transaction.id, record.transaction);
      }
      matched = [...seen.values()];
      spend = matched.filter((t) => t.kind === "spend");
      const latest = result.latest;
      const total = spend.reduce((s, t) => s + shareOf(t, person), 0);
      if (result.warrantyQuestion) {
        deterministic = latest
          ? "The matching records do not include a warranty end date."
          : `No matching transactions or documents in ${person === "household" ? "the household" : "your"} records. This does not mean it never happened; it is not recorded here.`;
      } else if (latest) {
        deterministic = `The latest matching record is ${latest.merchant}, dated ${latest.date} — ${gbp(latest.amount)}.`;
        if (spend.length > 1) {
          deterministic += ` Total across ${spend.length} matching transactions: ${gbp(total)}.`;
        }
        if (truncated) {
          deterministic += " Totals cover the most recent 200 matches.";
        }
      } else {
        deterministic = `No matching transactions or documents in ${person === "household" ? "the household" : "your"} records. This does not mean it never happened; it is not recorded here.`;
      }
    }
  }

  const figures = buildFigures(
    spend,
    amountPerson,
    isOcado || isTrip
      ? latestOf(matched, amountPerson)
      : matched.length > 0
        ? latestOf(matched, amountPerson)
        : null,
    plan.month ?? null,
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
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (prose) return { answer: prose, figures, ai: true };
  return { answer: deterministic, figures, ai: false };
}
