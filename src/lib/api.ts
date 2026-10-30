import Database from "better-sqlite3";
import { openStore } from "./ingest/store";
import {
  ingestAll,
  recomputeAggregates,
  type IngestResult,
} from "./ingest/ingest";
import {
  reviewQueue,
  setMerchant,
  seedMerchantMemory,
} from "./ingest/merchants";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

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
      return openStore(resolved);
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
    path === "/api/merchants" ||
    path === "/api/digest" ||
    path === "/api/aggregates";
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
    const runs = db
      .prepare(
        `SELECT account, started_at, rows_seen, rows_added, balance_minor, currency, discrepancy
         FROM ingest_runs WHERE id IN (SELECT MAX(id) FROM ingest_runs GROUP BY account)`,
      )
      .all() as IngestResult[] & { started_at: string }[];
    void runs;
    const rows = db
      .prepare(
        `SELECT account, started_at AS lastIngest, rows_seen AS rowsSeen, rows_added AS rowsAdded,
                balance_minor AS balanceMinor, currency, discrepancy
         FROM ingest_runs WHERE id IN (SELECT MAX(id) FROM ingest_runs GROUP BY account)`,
      )
      .all();
    return json({ ok: true, accounts: rows });
  }

  if (path === "/api/ingest/run" && request.method === "POST") {
    const dir = dataDir();
    if (!dir)
      return json({ ok: false, error: "CHITRAGUPTA_DATA_DIR is not set" }, 503);
    try {
      const results = ingestAll(db, dir, "zonito");
      seedMerchantMemory(db);
      recomputeAggregates(db, "zonito");
      return json({ ok: true, results });
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
    return json({ ok: true, queue: reviewQueue(db) });
  }

  if (path === "/api/merchants" && request.method === "POST") {
    let body: {
      merchant?: string;
      category?: string;
      colour?: string | null;
      icon?: string | null;
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
    db.prepare(`UPDATE transactions SET category = ? WHERE merchant = ?`).run(
      body.category,
      body.merchant,
    );
    setMerchant(db, body.merchant, body.category, {
      colour: body.colour ?? null,
      icon: body.icon ?? null,
      source: "molang",
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

  if (path === "/api/digest" && request.method === "GET") {
    const week = url.searchParams.get("week") ?? currentWeek();
    const month = week.slice(0, 7);
    const monthRows = db
      .prepare(
        `SELECT person, category, SUM(spend_minor) AS spend, SUM(income_minor) AS income,
                SUM(aside_minor) AS aside, SUM(txn_count) AS txns
         FROM month_aggregates WHERE year_month = ? GROUP BY person, category`,
      )
      .all(month);
    const weekRows = db
      .prepare(
        `SELECT person, category,
                SUM(CASE WHEN amount_minor < 0 AND movement = 'spend' THEN -amount_minor ELSE 0 END) AS spend,
                COUNT(*) AS txns
         FROM transactions WHERE substr(effective_date, 1, 7) = ? GROUP BY person, category`,
      )
      .all(month);
    void weekRows;
    const weekTxns = db
      .prepare(
        `SELECT effective_date, description, merchant, amount_minor, currency, movement, category
         FROM transactions WHERE strftime('%Y-W%W', effective_date) = ? ORDER BY effective_date DESC LIMIT 200`,
      )
      .all(week);
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
         WHERE movement = 'aside' AND amount_minor < 0 AND substr(effective_date, 1, 7) = ?`,
      )
      .get(month) as { total: number };
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
      unclassifiedMerchants: newMerchants,
    });
  }

  if (path === "/api/aggregates" && request.method === "GET") {
    const month =
      url.searchParams.get("month") ?? new Date().toISOString().slice(0, 7);
    const person = url.searchParams.get("person") ?? "household";
    const rows = db
      .prepare(
        `SELECT category, spend_minor, income_minor, aside_minor, txn_count
         FROM month_aggregates WHERE person = ? AND year_month = ? ORDER BY spend_minor DESC`,
      )
      .all(person === "household" ? "zonito" : person, month);
    return json({ ok: true, person, month, rows });
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

function currentWeek(): string {
  const now = new Date();
  const onejan = new Date(now.getFullYear(), 0, 1);
  const week = Math.ceil(
    ((now.getTime() - onejan.getTime()) / 86400000 + onejan.getDay() + 1) / 7,
  );
  return `${now.getFullYear()}-W${String(week).padStart(2, "0")}`;
}
