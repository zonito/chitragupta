import Database from "better-sqlite3";
import { openStore } from "./ingest/store";
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
    path === "/api/ask";
  if (needDb) {
    const ensured = requireDb(db);
    if (ensured instanceof Response) return ensured;
    return routeWithDb(request, ensured as Database.Database);
  }
  return null;
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
