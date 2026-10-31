import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import { openStore } from "./ingest/store";
import {
  DOC_EXTENSIONS,
  DOC_TYPES,
  MAX_DOCUMENT_BYTES,
  contentTypeForPath,
  documentExtension,
  documentRelativePath,
  documentRowToDoc,
  type DocumentRow,
} from "./documents.server";
import { CATEGORIES, type DocType } from "./data";
import { uiCategory } from "./txn-map";
import {
  ingestAll,
  recomputeAggregates,
  type IngestResult,
} from "./ingest/ingest";
import {
  dismissMerchant,
  reviewQueue,
  reviewQueueCount,
  setMerchant,
  seedMerchantMemory,
  type MerchantSource,
} from "./ingest/merchants";
import {
  classifyUnknownMerchants,
  claudeConfig,
} from "./ingest/classify";
import { answerAsk } from "./ask.server";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

/**
 * The resolved-category expression, identical to the one the SELECT in
 * /api/transactions computes (and to CATEGORY_SQL in ask.server.ts).
 * Filtering on it in SQL — before LIMIT — is what makes a category
 * query return that category's rows instead of whatever fraction of
 * the category happened to survive an unfiltered LIMIT.
 */
const CATEGORY_SQL = `COALESCE(t.category, m.category,
  CASE t.movement
    WHEN 'spend' THEN 'One-off' WHEN 'income' THEN 'One-off'
    WHEN 'aside' THEN 'Moved aside' WHEN 'fee' THEN 'Fees'
    WHEN 'interest' THEN 'Interest' ELSE 'Transfer' END)`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

let dbPromise: Promise<Database.Database> | null = null;

function storeDir(): string | null {
  const dir = process.env["CHITRAGUPTA_STORE_DIR"]?.trim();
  return dir ? dir : null;
}

function dataDir(): string | null {
  const dir = process.env["CHITRAGUPTA_DATA_DIR"]?.trim();
  return dir ? dir : null;
}

async function getDb(): Promise<Database.Database | null> {
  const dir = storeDir();
  if (!dir) return null;
  if (!dbPromise) {
    dbPromise = (async () => {
      const { readFileSync } = await import("node:fs");
      const envPath = process.cwd() + "/.env";
      try {
        for (const line of readFileSync(envPath, "utf8").split("\n")) {
          const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
          if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim();
        }
      } catch {
        // no .env — env vars only
      }
      const resolved = storeDir();
      if (!resolved) throw new Error("CHITRAGUPTA_STORE_DIR is not set");
      const db = openStore(resolved);
      // A schema migration (store.ts) can leave the derived aggregates
      // cache empty while transactions survive; rebuild it once here so
      // read endpoints never serve a silently empty month.
      const aggCount = db
        .prepare("SELECT COUNT(*) AS n FROM month_aggregates")
        .get() as { n: number };
      if (aggCount.n === 0) {
        const txnCount = db
          .prepare("SELECT COUNT(*) AS n FROM transactions")
          .get() as { n: number };
        if (txnCount.n > 0) {
          const persons = db
            .prepare("SELECT DISTINCT person FROM transactions")
            .all() as { person: string }[];
          for (const { person } of persons) recomputeAggregates(db, person);
        }
      }
      return db;
    })();
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

function requireDb(db: Database.Database | null): Database.Database | Response {
  if (!db) {
    return json(
      {
        ok: false,
        error: "CHITRAGUPTA_STORE_DIR is not set; copy .env.example to .env",
      },
      503,
    );
  }
  return db;
}

export async function handleChitraguptaApi(
  request: Request,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith("/api/")) return null;

  // Jev is stateless and needs no store: route it before the DB gate so it
  // stays reachable (and fail-open) even with no store configured.
  if (path === "/api/jev/ask") {
    return routeJev(request);
  }

  const db = await getDb();
  const needDb =
    path === "/api/ingest/status" ||
    path === "/api/ingest/run" ||
    path === "/api/review-queue" ||
    path === "/api/review-queue/dismiss" ||
    path === "/api/merchants" ||
    path === "/api/digest" ||
    path === "/api/classify/run" ||
    path === "/api/transactions" ||
    path === "/api/aggregates" ||
    path === "/api/documents" ||
    path === "/api/documents/detach" ||
    /^\/api\/documents\/[^/]+\/file$/.test(path) ||
    path === "/api/ask";
  if (needDb) {
    const ensured = requireDb(db);
    if (ensured instanceof Response) return ensured;
    return routeWithDb(request, ensured as Database.Database);
  }
  return null;
}

/** Shift a YYYY-MM month key by delta months. */
function shiftMonthKey(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function shortMonthLabel(key: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${key}-02T00:00:00Z`));
}

/** Median of a non-empty list, unrounded (an even count averages the two
 * middle values, so the result can land on a half minor unit). */
function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const SCOPE_PERSONS: ReadonlySet<string> = new Set([
  "household",
  "zonito",
  "nikhila",
]);

/**
 * Scoped category aggregates for the Categories period selector.
 *
 * Params: person (household|zonito|nikhila, default household) and a
 * scope: scope=month with month=YYYY-MM, scope=year with year=YYYY, or
 * scope=all (bare year= / all=1 select the same scopes). Unlike the
 * legacy month response above — which serves the precomputed
 * month_aggregates for one stored person — scoped rows are computed from
 * transactions with the client's shareOf weighting replicated in SQL:
 * household counts every GBP spend row (movement='spend', amount<0) at
 * 100%; a named person counts Joint-account rows at 0.5, their own rows
 * at 100% and the other person's at 0 (month_aggregates does not encode
 * that split, so it cannot serve these scopes). Categories resolve with
 * the same COALESCE expression as everywhere else, then fold through
 * uiCategory and the CATEGORIES list, exactly as the snapshot's
 * byCategory does, so a scoped month agrees with the snapshot to the
 * penny. Amounts are minor units and can carry a half (a halved odd
 * Joint row), again mirroring the client.
 *
 * Response: { ok, person, scope, month? | year?, total_minor,
 * seriesPeriods, seriesLabels, rows } where total_minor is the scope's
 * whole weighted GBP spend (the spendTotal analogue: it includes any
 * spend whose category folds outside CATEGORIES, which rows omit), and
 * each row is { category, spend_minor, typical_minor, series }:
 * - typical_minor ("usually"): month scope → median of the prior 6
 *   calendar months' weighted spend; year scope → median of the other
 *   years' annual totals when at least 2 other years have data, else
 *   null; all scope → null.
 * - series: per-category weighted totals over seriesPeriods — month
 *   scope: the 6 months ending at the month; year scope: the 12 months
 *   of the year; all scope: one total per year with data.
 * With &category=<name> the response also carries merchants:
 * [{ merchant, spend_minor }] — per-merchant weighted spend in that
 * category within the scope, sorted desc — for the category sheet.
 */
function aggregatesScope(db: Database.Database, url: URL): Response {
  const person = url.searchParams.get("person") ?? "household";
  if (!SCOPE_PERSONS.has(person)) {
    return json({ ok: false, error: "person must be household, zonito or nikhila" }, 400);
  }
  const scopeParam = url.searchParams.get("scope");
  const kind =
    scopeParam ??
    (url.searchParams.has("year")
      ? "year"
      : url.searchParams.has("all")
        ? "all"
        : "month");
  if (kind !== "month" && kind !== "year" && kind !== "all") {
    return json({ ok: false, error: "scope must be month, year or all" }, 400);
  }
  const monthParam =
    url.searchParams.get("month") ?? new Date().toISOString().slice(0, 7);
  if (kind === "month" && !/^\d{4}-\d{2}$/.test(monthParam)) {
    return json({ ok: false, error: "month must be YYYY-MM" }, 400);
  }
  const yearParam = url.searchParams.get("year") ?? monthParam.slice(0, 4);
  if (kind === "year" && !/^\d{4}$/.test(yearParam)) {
    return json({ ok: false, error: "year must be YYYY" }, 400);
  }

  // shareOf as SQL: the two ? are the resolved person (household short-
  // circuits to full weight before the person comparison is reached).
  const WEIGHT_SQL = `CASE WHEN ? = 'household' THEN 1.0
    WHEN t.account = 'Joint' THEN 0.5
    WHEN t.person = ? THEN 1.0 ELSE 0.0 END`;
  const SPEND_WHERE = `t.currency = 'GBP' AND t.movement = 'spend' AND t.amount_minor < 0`;

  // Weighted GBP spend per (month, resolved category) over the whole
  // store; every scope below is derived from this one map in JS, so the
  // scopes can never disagree with each other.
  const monthlyRows = db
    .prepare(
      `SELECT t.year_month AS ym, ${CATEGORY_SQL} AS raw_category,
              SUM(-t.amount_minor * (${WEIGHT_SQL})) AS spend
       FROM transactions t LEFT JOIN merchant_memory m ON m.merchant = t.merchant
       WHERE ${SPEND_WHERE}
       GROUP BY t.year_month, raw_category`,
    )
    .all(person, person) as {
    ym: string;
    raw_category: string;
    spend: number;
  }[];
  const uiCategories: ReadonlySet<string> = new Set(CATEGORIES);
  const byMonth = new Map<string, Map<string, number>>();
  for (const r of monthlyRows) {
    const category = uiCategory(r.raw_category);
    if (!uiCategories.has(category)) continue;
    let monthMap = byMonth.get(r.ym);
    if (!monthMap) byMonth.set(r.ym, (monthMap = new Map()));
    monthMap.set(category, (monthMap.get(category) ?? 0) + r.spend);
  }
  const monthSpend = (ym: string, category: string): number =>
    byMonth.get(ym)?.get(category) ?? 0;
  const years = (
    db
      .prepare(
        "SELECT DISTINCT substr(year_month, 1, 4) AS y FROM transactions ORDER BY y",
      )
      .all() as { y: string }[]
  ).map((r) => r.y);
  const yearMonths = (y: string): string[] =>
    Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, "0")}`);
  const yearSpend = (y: string, category: string): number =>
    yearMonths(y).reduce((s, ym) => s + monthSpend(ym, category), 0);

  let seriesPeriods: string[];
  let seriesLabels: string[];
  let inScope: (ym: string) => boolean;
  let typicalFor: (category: string) => number | null;
  if (kind === "month") {
    seriesPeriods = [5, 4, 3, 2, 1, 0].map((d) => shiftMonthKey(monthParam, -d));
    seriesLabels = seriesPeriods.map(shortMonthLabel);
    const prior6 = [6, 5, 4, 3, 2, 1].map((d) => shiftMonthKey(monthParam, -d));
    inScope = (ym) => ym === monthParam;
    typicalFor = (category) =>
      medianOf(prior6.map((ym) => monthSpend(ym, category)));
  } else if (kind === "year") {
    seriesPeriods = yearMonths(yearParam);
    seriesLabels = seriesPeriods.map(shortMonthLabel);
    const otherYears = years.filter((y) => y !== yearParam);
    inScope = (ym) => ym.startsWith(`${yearParam}-`);
    typicalFor = (category) =>
      otherYears.length >= 2
        ? medianOf(otherYears.map((y) => yearSpend(y, category)))
        : null;
  } else {
    seriesPeriods = years;
    seriesLabels = years;
    inScope = () => true;
    typicalFor = () => null;
  }

  const totals = new Map<string, number>();
  for (const [ym, monthMap] of byMonth) {
    if (!inScope(ym)) continue;
    for (const [category, spend] of monthMap) {
      totals.set(category, (totals.get(category) ?? 0) + spend);
    }
  }
  const rows = [...totals.entries()]
    .filter(([, spend]) => spend > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([category, spend]) => ({
      category,
      spend_minor: spend,
      typical_minor: typicalFor(category),
      series:
        kind === "all"
          ? seriesPeriods.map((y) => yearSpend(y, category))
          : seriesPeriods.map((ym) => monthSpend(ym, category)),
    }));
  // The scope total counts every weighted spend row in scope, including
  // any whose category folds outside CATEGORIES (the rows omit those,
  // exactly as spendTotal and byCategory relate on the client).
  const total_minor = monthlyRows
    .filter((r) => inScope(r.ym))
    .reduce((s, r) => s + r.spend, 0);

  const body: Record<string, unknown> = {
    ok: true,
    person,
    scope: kind,
    ...(kind === "month" ? { month: monthParam } : {}),
    ...(kind === "year" ? { year: yearParam } : {}),
    total_minor,
    seriesPeriods,
    seriesLabels,
    rows,
  };

  const categoryParam = url.searchParams.get("category")?.trim();
  if (categoryParam) {
    const periodWhere =
      kind === "month"
        ? "AND t.year_month = ?"
        : kind === "year"
          ? "AND substr(t.year_month, 1, 4) = ?"
          : "";
    const periodParam =
      kind === "month" ? [monthParam] : kind === "year" ? [yearParam] : [];
    const merchantRows = db
      .prepare(
        `SELECT t.merchant AS merchant, ${CATEGORY_SQL} AS raw_category,
                SUM(-t.amount_minor * (${WEIGHT_SQL})) AS spend
         FROM transactions t LEFT JOIN merchant_memory m ON m.merchant = t.merchant
         WHERE ${SPEND_WHERE} ${periodWhere}
         GROUP BY t.merchant, raw_category`,
      )
      .all(person, person, ...periodParam) as {
      merchant: string;
      raw_category: string;
      spend: number;
    }[];
    const merchants = new Map<string, number>();
    for (const r of merchantRows) {
      if (uiCategory(r.raw_category) !== categoryParam) continue;
      merchants.set(r.merchant, (merchants.get(r.merchant) ?? 0) + r.spend);
    }
    body["category"] = categoryParam;
    body["merchants"] = [...merchants.entries()]
      .map(([merchant, spend]) => ({ merchant, spend_minor: spend }))
      .sort((a, b) => b.spend_minor - a.spend_minor || a.merchant.localeCompare(b.merchant));
  }
  return json(body);
}

async function routeWithDb(
  request: Request,
  db: Database.Database,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/ingest/status" && request.method === "GET") {
    const rows = db
      .prepare(
        `SELECT account, started_at AS lastIngest, rows_seen AS rowsSeen, rows_added AS rowsAdded,
                balance_minor AS balanceMinor, currency, discrepancy
         FROM ingest_runs
         WHERE id IN (SELECT MAX(id) FROM ingest_runs GROUP BY account)
           AND substr(account, 1, 2) <> '__'`,
      )
      .all();
    const rebuilds = db
      .prepare(
        `SELECT started_at AS at, discrepancy FROM ingest_runs
         WHERE account = '__rebuild__' ORDER BY id DESC LIMIT 5`,
      )
      .all();
    return json({ ok: true, accounts: rows, rebuilds });
  }

  if (path === "/api/ingest/run" && request.method === "POST") {
    const dir = dataDir();
    if (!dir)
      return json({ ok: false, error: "CHITRAGUPTA_DATA_DIR is not set" }, 503);
    try {
      const results = ingestAll(db, dir, "zonito");
      seedMerchantMemory(db);
      recomputeAggregates(db, "zonito");
      // Classification drains behind ingest; with no key it is an instant
      // no-op, and failures never fail the ingest itself.
      const classification = await classifyUnknownMerchants(db).catch(
        () => null,
      );
      // A partial failure (one account's file unreadable, say) reports
      // ok: false with the failed accounts named, never a bare success.
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        const detail = failed
          .map(
            (r) =>
              `${r.account}${r.file ? ` (${r.file})` : ""}: ${r.error ?? "failed"}`,
          )
          .join("; ");
        return json({
          ok: false,
          error: `${failed.length} of ${results.length} accounts failed: ${detail}`,
          results,
          classification,
        });
      }
      return json({ ok: true, results, classification });
    } catch (error) {
      return json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  }

  if (path === "/api/review-queue" && request.method === "GET") {
    return json({
      ok: true,
      queue: reviewQueue(db),
      total: reviewQueueCount(db),
    });
  }

  if (path === "/api/review-queue/dismiss" && request.method === "POST") {
    let body: { merchant?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ ok: false, error: "invalid JSON body" }, 400);
    }
    const merchant = body.merchant?.trim();
    if (!merchant) {
      return json({ ok: false, error: "merchant is required" }, 400);
    }
    // A dismissal only records the dismissal: it writes no merchant
    // memory, touches no transaction and recomputes no aggregate, so
    // the merchant simply stops being offered for review.
    dismissMerchant(db, merchant);
    return json({ ok: true });
  }

  if (path === "/api/classify/run" && request.method === "GET") {
    return json({ ok: true, configured: claudeConfig() !== null });
  }

  if (path === "/api/classify/run" && request.method === "POST") {
    const summary = await classifyUnknownMerchants(db);
    return json({ ok: true, ...summary });
  }

  if (path === "/api/merchants" && request.method === "POST") {
    let body: {
      merchant?: string;
      category?: string;
      colour?: string | null;
      icon?: string | null;
      source?: string;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ ok: false, error: "invalid JSON body" }, 400);
    }
    if (!body.merchant || !body.category) {
      return json(
        { ok: false, error: "merchant and category are required" },
        400,
      );
    }
    // The caller may name its source (the Activity sheet sends "user");
    // anything absent or unrecognised keeps the historical "molang"
    // default, so existing callers behave exactly as before.
    const MERCHANT_SOURCES: ReadonlySet<string> = new Set([
      "rules",
      "claude-api",
      "molang",
      "user",
    ]);
    const source: MerchantSource =
      body.source && MERCHANT_SOURCES.has(body.source)
        ? (body.source as MerchantSource)
        : "molang";
    db.prepare(`UPDATE transactions SET category = ? WHERE merchant = ?`).run(
      body.category,
      body.merchant,
    );
    if (source === "user") {
      // A user correction is a statement that this merchant is real
      // spending: payments filed as "moved aside" (transfers out) join
      // spend under the corrected category. Incoming rows and internal
      // moves are never touched.
      db.prepare(
        `UPDATE transactions SET movement = 'spend', category = ?
         WHERE merchant = ? AND movement = 'aside' AND amount_minor < 0`,
      ).run(body.category, body.merchant);
    }
    setMerchant(db, body.merchant, body.category, {
      colour: body.colour ?? null,
      icon: body.icon ?? null,
      source,
    });
    for (const person of ["zonito", "nikhila", "household"]) {
      try {
        recomputeAggregates(db, person);
      } catch {
        // person with no rows yet — aggregates stay empty
      }
    }
    return json({ ok: true, merchant: body.merchant, category: body.category });
  }

  if (path === "/api/ask" && request.method === "POST") {
    let body: { question?: string; person?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ ok: false, error: "invalid JSON body" }, 400);
    }
    const question = body.question?.trim();
    if (!question) {
      return json({ ok: false, error: "question is required" }, 400);
    }
    // answerAsk never throws for gateway problems (it falls back to the
    // deterministic answer); a throw here is a store problem.
    try {
      const result = await answerAsk(db, {
        question,
        ...(body.person ? { person: body.person } : {}),
      });
      return json({ ok: true, ...result });
    } catch (error) {
      return json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  }

  if (path === "/api/digest" && request.method === "GET") {
    const week = url.searchParams.get("week") ?? currentWeek();
    // The month is the month of the week's Monday (ISO week), never a
    // string slice of "2026-W44" (which produced the bogus month "2026-W4"
    // and an always-empty byMonth).
    const weekStart = isoWeekMonday(week);
    const month = weekStart ? weekStart.slice(0, 7) : week.slice(0, 7);
    const weekEnd = weekStart
      ? new Date(Date.parse(weekStart) + 7 * 86400000).toISOString().slice(0, 10)
      : null;
    const monthRows = db
      .prepare(
        `SELECT person, category, SUM(spend_minor) AS spend, SUM(income_minor) AS income,
                SUM(aside_minor) AS aside, SUM(txn_count) AS txns
         FROM month_aggregates WHERE year_month = ? AND currency = 'GBP' GROUP BY person, category`,
      )
      .all(month);
    const weekTxns = weekStart
      ? db
          .prepare(
            `SELECT effective_date, description, merchant, amount_minor, currency, movement, category
             FROM transactions WHERE effective_date >= ? AND effective_date < ? ORDER BY effective_date DESC LIMIT 200`,
          )
          .all(weekStart, weekEnd)
      : [];
    const upcoming = db
      .prepare(
        `SELECT merchant, category, COUNT(*) AS times, AVG(-amount_minor) AS avg_minor
         FROM transactions WHERE movement = 'spend' AND amount_minor < 0
         GROUP BY merchant, category HAVING times >= 3 ORDER BY times DESC LIMIT 20`,
      )
      .all();
    const oneOffs = db
      .prepare(
        `SELECT effective_date, description, merchant, amount_minor, currency
         FROM transactions WHERE movement = 'spend' AND amount_minor <= -25000
           AND substr(effective_date, 1, 7) = ? ORDER BY amount_minor LIMIT 50`,
      )
      .all(month);
    const movedAside = db
      .prepare(
        `SELECT COALESCE(SUM(-amount_minor), 0) AS total FROM transactions
         WHERE movement = 'aside' AND amount_minor < 0 AND currency = 'GBP' AND substr(effective_date, 1, 7) = ?`,
      )
      .get(month) as { total: number };
    const movedAsideForeign = db
      .prepare(
        `SELECT currency, COALESCE(SUM(-amount_minor), 0) AS total FROM transactions
         WHERE movement = 'aside' AND amount_minor < 0 AND currency <> 'GBP' AND substr(effective_date, 1, 7) = ?
         GROUP BY currency`,
      )
      .all(month);
    const newMerchants = db
      .prepare(
        `SELECT merchant, COUNT(*) AS n FROM transactions
         WHERE merchant NOT IN (SELECT merchant FROM merchant_memory)
         GROUP BY merchant ORDER BY n DESC LIMIT 20`,
      )
      .all();
    return json({
      ok: true,
      week,
      month,
      byMonth: monthRows,
      weekTransactions: weekTxns,
      upcomingRegulars: upcoming,
      oneOffs,
      movedAsideTotal: movedAside.total,
      movedAsideForeign,
      unclassifiedMerchants: newMerchants,
    });
  }

  if (path === "/api/transactions" && request.method === "GET") {
    const person = url.searchParams.get("person");
    const month = url.searchParams.get("month");
    const merchant = url.searchParams.get("merchant")?.trim();
    const q = url.searchParams.get("q")?.trim();
    const category = url.searchParams.get("category");
    const ids = (url.searchParams.get("ids") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 1000);
    const limit = Math.min(
      Math.max(Number(url.searchParams.get("limit") ?? 200) || 200, 1),
      1000,
    );
    const where: string[] = [];
    const params: unknown[] = [];
    if (ids.length > 0) {
      // Exact fingerprint match: the subscription detail view asks for a
      // subscription's own charge rows by id, nothing else.
      where.push(`t.fingerprint IN (${ids.map(() => "?").join(", ")})`);
      params.push(...ids);
    }
    if (person && person !== "household") {
      where.push("t.person = ?");
      params.push(person);
    }
    if (month) {
      where.push("t.year_month = ?");
      params.push(month);
    }
    if (merchant) {
      // Exact merchant match (unlike q's LIKE over merchant+description) —
      // the subscription detail view fetches one merchant's charges.
      where.push("t.merchant = ?");
      params.push(merchant);
    }
    if (q) {
      where.push("(t.merchant LIKE ? OR t.description LIKE ?)");
      params.push(`%${q}%`, `%${q}%`);
    }
    if (category) {
      // Filter in SQL, before LIMIT: a JS post-filter over a limited
      // unfiltered pull silently drops most of the category's rows.
      where.push(`${CATEGORY_SQL} = ?`);
      params.push(category);
    }
    const rows = db
      .prepare(
        `SELECT t.fingerprint AS id, t.person, t.account, t.effective_date AS date,
                t.year_month AS month, t.description, t.merchant,
                t.amount_minor AS amountMinor, t.currency, t.movement,
                ${CATEGORY_SQL} AS category
         FROM transactions t LEFT JOIN merchant_memory m ON m.merchant = t.merchant
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY t.effective_date DESC LIMIT ?`,
      )
      .all(...params, limit) as {
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
    }[];
    return json({ ok: true, count: rows.length, transactions: rows });
  }

  if (path === "/api/aggregates" && request.method === "GET") {
    // Scoped aggregates (Categories period selector): a request carrying
    // a scope — scope=month|year|all, or a bare year= / all=1 — is served
    // by aggregatesScope below. A request with no scope keeps the legacy
    // month_aggregates response below, byte-for-byte.
    if (
      url.searchParams.has("scope") ||
      url.searchParams.has("year") ||
      url.searchParams.has("all")
    ) {
      return aggregatesScope(db, url);
    }
    const month =
      url.searchParams.get("month") ?? new Date().toISOString().slice(0, 7);
    const person = url.searchParams.get("person") ?? "household";
    const resolvedPerson = person === "household" ? "zonito" : person;
    // GBP totals are GBP rows only; foreign-currency amounts are reported
    // in their own per-currency buckets, never face-value mixed in.
    const rows = db
      .prepare(
        `SELECT category, spend_minor, income_minor, aside_minor, txn_count
         FROM month_aggregates WHERE person = ? AND year_month = ? AND currency = 'GBP'
         ORDER BY spend_minor DESC`,
      )
      .all(resolvedPerson, month);
    const otherCurrencies = db
      .prepare(
        `SELECT currency, SUM(spend_minor) AS spend, SUM(income_minor) AS income,
                SUM(aside_minor) AS aside, SUM(txn_count) AS txns
         FROM month_aggregates WHERE person = ? AND year_month = ? AND currency <> 'GBP'
         GROUP BY currency ORDER BY currency`,
      )
      .all(resolvedPerson, month);
    return json({ ok: true, person, month, rows, otherCurrencies });
  }

  if (path === "/api/documents" && request.method === "POST") {
    let body: {
      filename?: unknown;
      contentBase64?: unknown;
      type?: unknown;
      merchant?: unknown;
      date?: unknown;
      amount?: unknown;
      txnId?: unknown;
      warrantyEnds?: unknown;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ ok: false, error: "invalid JSON body" }, 400);
    }
    const filename = typeof body.filename === "string" ? body.filename : "";
    const extension = documentExtension(filename);
    if (!DOC_EXTENSIONS.has(extension)) {
      return json(
        { ok: false, error: "file must be a PDF or an image (pdf, jpg, jpeg, png)" },
        400,
      );
    }
    if (
      typeof body.type !== "string" ||
      !(DOC_TYPES as readonly string[]).includes(body.type)
    ) {
      return json(
        { ok: false, error: "type must be Receipt, Bill, Invoice or Warranty" },
        400,
      );
    }
    const merchant =
      typeof body.merchant === "string" ? body.merchant.trim() : "";
    if (!merchant) {
      return json({ ok: false, error: "merchant is required" }, 400);
    }
    const date = typeof body.date === "string" ? body.date.trim() : "";
    const parsedDate = new Date(`${date}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      Number.isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== date
    ) {
      return json({ ok: false, error: "date must be YYYY-MM-DD" }, 400);
    }
    if (typeof body.amount !== "number" || !Number.isFinite(body.amount)) {
      return json({ ok: false, error: "amount is required" }, 400);
    }
    if (typeof body.contentBase64 !== "string" || !body.contentBase64) {
      return json({ ok: false, error: "contentBase64 is required" }, 400);
    }
    const bytes = Buffer.from(body.contentBase64, "base64");
    if (bytes.length === 0) {
      return json({ ok: false, error: "file is empty" }, 400);
    }
    if (bytes.length > MAX_DOCUMENT_BYTES) {
      return json({ ok: false, error: "file is larger than 10 MB" }, 400);
    }
    const dir = dataDir();
    if (!dir)
      return json({ ok: false, error: "CHITRAGUPTA_DATA_DIR is not set" }, 503);
    const type = body.type as DocType;
    const amount = body.amount;
    const txnId =
      typeof body.txnId === "string" && body.txnId.trim()
        ? body.txnId.trim()
        : null;
    const warrantyEnds =
      typeof body.warrantyEnds === "string" && body.warrantyEnds.trim()
        ? body.warrantyEnds.trim()
        : null;
    const root = resolve(dir);
    let relative = documentRelativePath({
      type,
      date,
      merchant,
      amount,
      extension,
    });
    let target = resolve(root, relative);
    if (!target.startsWith(root + sep)) {
      return json({ ok: false, error: "invalid document path" }, 400);
    }
    if (existsSync(target)) {
      const existingBytes = readFileSync(target);
      if (existingBytes.equals(bytes)) {
        const existing = db
          .prepare("SELECT * FROM documents WHERE path = ?")
          .get(relative) as DocumentRow | undefined;
        if (existing) {
          // The same file filed again is the same document: link it as
          // asked if it is not linked yet, but never duplicate it.
          if (txnId && existing.txn_id !== txnId) {
            db.prepare(
              "UPDATE documents SET txn_id = NULL WHERE txn_id = ?",
            ).run(txnId);
            db.prepare("UPDATE documents SET txn_id = ? WHERE id = ?").run(
              txnId,
              existing.id,
            );
            existing.txn_id = txnId;
          }
          return json({ ok: true, document: documentRowToDoc(existing) });
        }
        // Identical bytes already filed on disk but unregistered: fall
        // through and register them under the same path, no rewrite.
      } else {
        // Different bytes would collide on the convention name; suffix
        // until the name is free rather than overwriting a filed file.
        let n = 2;
        let candidate = relative;
        while (existsSync(resolve(root, candidate))) {
          candidate = relative.replace(/(\.[^.]+)$/, `_${n}$1`);
          n += 1;
        }
        relative = candidate;
        target = resolve(root, relative);
      }
    }
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target)) writeFileSync(target, bytes);
    // One document per transaction: a new attachment for a transaction
    // detaches the previous one, which stays filed as unmatched.
    if (txnId) {
      db.prepare("UPDATE documents SET txn_id = NULL WHERE txn_id = ?").run(
        txnId,
      );
    }
    const row: DocumentRow = {
      id: randomUUID(),
      merchant,
      date,
      amount_minor: Math.round(amount * 100),
      type,
      txn_id: txnId,
      path: relative,
      warranty_ends: warrantyEnds,
    };
    db.prepare(
      `INSERT INTO documents (id, merchant, date, amount_minor, type, txn_id, path, warranty_ends)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.merchant,
      row.date,
      row.amount_minor,
      row.type,
      row.txn_id,
      row.path,
      row.warranty_ends,
    );
    return json({ ok: true, document: documentRowToDoc(row) });
  }

  if (path === "/api/documents/detach" && request.method === "POST") {
    let body: { txnId?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ ok: false, error: "invalid JSON body" }, 400);
    }
    const txnId = typeof body.txnId === "string" ? body.txnId.trim() : "";
    if (!txnId) {
      return json({ ok: false, error: "txnId is required" }, 400);
    }
    // Detaching only clears the link: the file and its record stay,
    // listed as unmatched (the house rule for documents).
    const info = db
      .prepare("UPDATE documents SET txn_id = NULL WHERE txn_id = ?")
      .run(txnId);
    return json({ ok: true, detached: info.changes });
  }

  const fileMatch = path.match(/^\/api\/documents\/([^/]+)\/file$/);
  if (fileMatch && request.method === "GET") {
    const id = decodeURIComponent(fileMatch[1]!);
    const row = db
      .prepare("SELECT * FROM documents WHERE id = ?")
      .get(id) as DocumentRow | undefined;
    if (!row) {
      return json({ ok: false, error: "document not found" }, 404);
    }
    const dir = dataDir();
    if (!dir)
      return json({ ok: false, error: "CHITRAGUPTA_DATA_DIR is not set" }, 503);
    const root = resolve(dir);
    const target = resolve(root, row.path);
    // The stored path must stay inside the data dir, whatever it holds.
    if (!target.startsWith(root + sep)) {
      return json({ ok: false, error: "invalid document path" }, 400);
    }
    if (!existsSync(target)) {
      return json({ ok: false, error: "document file not found" }, 404);
    }
    const bytes = readFileSync(target);
    return new Response(bytes, {
      headers: {
        "content-type": contentTypeForPath(row.path),
        "content-disposition": `inline; filename="${basename(row.path).replace(/"/g, "")}"`,
        "content-length": String(bytes.length),
      },
    });
  }

  return null;
}

async function routeJev(request: Request): Promise<Response | null> {
  if (request.method !== "POST") return null;
  const tunnel =
    process.env["VARUNA_TUNNEL_URL"]?.trim() ?? "http://127.0.0.1:8400";
  try {
    const body = await request.text();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetch(`${tunnel}/v1/varuna/jev/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body,
      });
      const text = await res.text();
      return new Response(text, {
        status: res.status,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return json(
      {
        ok: false,
        jev: "unavailable",
        error: error instanceof Error ? error.message : String(error),
      },
      502,
    );
  }
}

/** Monday (ISO) of a "YYYY-Www" week string, as YYYY-MM-DD; null if malformed. */
export function isoWeekMonday(week: string): string | null {
  const m = week.match(/^(\d{4})-W(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const wk = Number(m[2]);
  if (wk < 1 || wk > 53) return null;
  // 4 January is always in ISO week 1; walk back to its Monday, then forward.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dow = jan4.getUTCDay() || 7; // Mon=1 .. Sun=7
  const monday = new Date(
    jan4.getTime() - (dow - 1) * 86400000 + (wk - 1) * 7 * 86400000,
  );
  return monday.toISOString().slice(0, 10);
}

function currentWeek(): string {
  const now = new Date();
  const onejan = new Date(now.getFullYear(), 0, 1);
  const week = Math.ceil(
    ((now.getTime() - onejan.getTime()) / 86400000 + onejan.getDay() + 1) / 7,
  );
  return `${now.getFullYear()}-W${String(week).padStart(2, "0")}`;
}
