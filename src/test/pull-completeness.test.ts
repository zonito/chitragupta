import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { answerAsk } from "@/lib/ask.server";
import { ingestAll, recomputeAggregates } from "@/lib/ingest/ingest";
import { seedMerchantMemory } from "@/lib/ingest/merchants";
import { openStore } from "@/lib/ingest/store";

/**
 * B3: Ask and /api/transactions must not silently undercount beyond a
 * 200-row pull.
 *
 * - /api/transactions filtered category in JS AFTER a SQL LIMIT, so a
 *   category query returned only the category rows that happened to
 *   sit inside the newest `limit` unfiltered rows. The predicate now
 *   lives in the SQL WHERE, before LIMIT.
 * - Ask totalled over a 200-row capped pull and flagged `truncated`
 *   whenever the pull hit the cap, even for complete months. Ask now
 *   counts the filtered set and pulls all of it (a 20,000-row safety
 *   ceiling aside), so totals are complete and `truncated` means the
 *   ceiling actually cut the set.
 */

type Api = typeof import("@/lib/api");

// ---------------------------------------------------------------------------
// Synthetic /api/transactions store: 30 newer Shopping rows and 14 older
// Groceries rows in March 2026. A category query limited below the
// unfiltered row count must still return the right category's rows.
// ---------------------------------------------------------------------------

const SYNTH_STORE_DIR = mkdtempSync(join(tmpdir(), "chitra-pull-"));
process.env["CHITRAGUPTA_STORE_DIR"] = SYNTH_STORE_DIR;

let api: Api;

function synthTxn(
  db: Database.Database,
  fp: string,
  date: string,
  merchant: string,
  category: string,
  amountMinor: number,
) {
  db.prepare(
    `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
      description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
     VALUES (?, 'zonito', 'Main', ?, ?, ?, ?, ?, 0, 'GBP', 0, 'spend', ?)`,
  ).run(fp, date, date.slice(0, 7), merchant, merchant, amountMinor, category);
}

beforeAll(async () => {
  const db = openStore(SYNTH_STORE_DIR);
  for (let i = 0; i < 14; i++) {
    synthTxn(db, `g${i}`, "2026-03-02", "Corner Grocer", "Groceries", -150);
  }
  for (let i = 0; i < 30; i++) {
    synthTxn(db, `s${i}`, "2026-03-20", "Mall", "Shopping", -500);
  }
  db.close();
  api = await import("@/lib/api");
});

async function getTransactions(qs: string, apiImpl: Api = api) {
  const res = await apiImpl.handleChitraguptaApi(
    new Request(`http://local/api/transactions?${qs}`),
  );
  expect(res?.status).toBe(200);
  return (await res!.json()) as {
    ok: boolean;
    count: number;
    transactions: { category: string; merchant: string }[];
  };
}

describe("/api/transactions category filter (synthetic)", () => {
  it("filters before LIMIT: a small limit still returns the right category", async () => {
    const body = await getTransactions(
      "category=Groceries&month=2026-03&limit=5",
    );
    expect(body.count).toBe(5);
    expect(body.transactions).toHaveLength(5);
    expect(body.transactions.every((t) => t.category === "Groceries")).toBe(
      true,
    );
  });

  it("returns the category's full count when the limit covers it", async () => {
    const body = await getTransactions(
      "category=Groceries&month=2026-03&limit=200",
    );
    expect(body.count).toBe(14);
    expect(body.transactions.every((t) => t.category === "Groceries")).toBe(
      true,
    );
  });

  it("leaves other categories and params behaving as before", async () => {
    const shopping = await getTransactions(
      "category=Shopping&month=2026-03&limit=200",
    );
    expect(shopping.count).toBe(30);
    const all = await getTransactions("month=2026-03&limit=200");
    expect(all.count).toBe(44);
  });
});

// ---------------------------------------------------------------------------
// Synthetic Ask stores: every computation path gets a set larger than
// the old 200-row cap and must total ALL of it, with truncated false.
// ---------------------------------------------------------------------------

function bulkDb(
  rows: {
    date: string;
    merchant: string;
    category: string;
    amountMinor: number;
  }[],
): Database.Database {
  const db = openStore(mkdtempSync(join(tmpdir(), "chitra-pull-ask-")));
  const insert = db.prepare(
    `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
      description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
     VALUES (?, 'zonito', 'Main', ?, ?, ?, ?, ?, 0, 'GBP', 100000, 'spend', ?)`,
  );
  rows.forEach((r, i) => {
    insert.run(
      `b${i}`,
      r.date,
      r.date.slice(0, 7),
      r.merchant,
      r.merchant,
      r.amountMinor,
      r.category,
    );
  });
  return db;
}

const repeat = (
  n: number,
  make: (i: number) => {
    date: string;
    merchant: string;
    category: string;
    amountMinor: number;
  },
) => Array.from({ length: n }, (_, i) => make(i));

describe("Ask completeness over sets larger than 200 rows (synthetic)", () => {
  it("totals a whole month beyond the old cap (month-only path)", async () => {
    const db = bulkDb(
      repeat(250, (i) => ({
        date: `2026-09-${String((i % 28) + 1).padStart(2, "0")}`,
        merchant: "Mall",
        category: "Shopping",
        amountMinor: -100,
      })),
    );
    const result = await answerAsk(db, {
      question: "How much did we spend in September?",
      env: {},
    });
    expect(result.figures).toMatchObject({
      total: 250,
      count: 250,
      truncated: false,
    });
    db.close();
  });

  it("totals a category with a period beyond the old cap", async () => {
    const db = bulkDb(
      repeat(210, (i) => ({
        date: `2026-08-${String((i % 28) + 1).padStart(2, "0")}`,
        merchant: "Corner Grocer",
        category: "Groceries",
        amountMinor: -200,
      })),
    );
    const result = await answerAsk(db, {
      question: "How much did we spend on groceries in August?",
      env: {},
    });
    expect(result.figures).toMatchObject({
      total: 420,
      count: 210,
      truncated: false,
    });
    db.close();
  });

  it("totals a bare period beyond the old cap", async () => {
    const days = [
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
    ];
    const db = bulkDb(
      repeat(210, (i) => ({
        date: days[i % days.length]!,
        merchant: "Mall",
        category: "Shopping",
        amountMinor: -100,
      })),
    );
    const result = await answerAsk(db, {
      question: "How much did we spend this week?",
      today: "2026-10-30",
      env: {},
    });
    expect(result.figures).toMatchObject({
      total: 210,
      count: 210,
      truncated: false,
    });
    db.close();
  });

  it("totals the Ocado example month beyond the old cap, untruncated", async () => {
    const db = bulkDb([
      ...repeat(210, (i) => ({
        date: `2026-10-${String((i % 28) + 1).padStart(2, "0")}`,
        merchant: "Ocado",
        category: "Groceries",
        amountMinor: -100,
      })),
      ...repeat(3, () => ({
        date: "2026-10-05",
        merchant: "Tesco",
        category: "Groceries",
        amountMinor: -500,
      })),
    ]);
    const result = await answerAsk(db, {
      question: "How much on Ocado this month?",
      env: {},
    });
    expect(result.answer).toBe("Ocado this month: £210.00 across 210 orders.");
    expect(result.figures).toMatchObject({
      total: 210,
      count: 210,
      truncated: false,
    });
    db.close();
  });

  it("totals a records question beyond the old cap", async () => {
    const db = bulkDb(
      repeat(210, (i) => ({
        date: `2026-0${(i % 6) + 1}-${String((i % 28) + 1).padStart(2, "0")}`,
        merchant: "Corner Shop",
        category: "Groceries",
        amountMinor: -100,
      })),
    );
    const result = await answerAsk(db, {
      question: "When did we last pay Corner Shop?",
      env: {},
    });
    expect(result.figures).toMatchObject({
      total: 210,
      count: 210,
      truncated: false,
    });
    expect(result.figures.latest?.merchant).toBe("Corner Shop");
    db.close();
  });

  it("totals a model-planned month beyond the old cap", async () => {
    const db = bulkDb(
      repeat(250, (i) => ({
        date: `2026-09-${String((i % 28) + 1).padStart(2, "0")}`,
        merchant: "Mall",
        category: "Shopping",
        amountMinor: -100,
      })),
    );
    const plan = JSON.stringify({
      kind: "total",
      category: null,
      query: null,
      from: null,
      to: null,
      month: "2026-09",
    });
    const fetchImpl = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body)) as { system?: string };
      const isPlanner = (body.system ?? "").includes("query planner");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [
            { type: "text", text: isPlanner ? plan : "September: £250.00." },
          ],
        }),
      } as Response;
    }) as typeof fetch;
    const result = await answerAsk(db, {
      question: "How much did we spend in September?",
      env: { MUSE_API_KEY: "LLM_test" },
      fetchImpl,
    });
    expect(result.ai).toBe(true);
    expect(result.figures).toMatchObject({
      total: 250,
      count: 250,
      truncated: false,
    });
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Real-data assertions (data-dir mode only). Expected figures are
// derived from the fixture with direct SQL in setup, then pinned to
// the audited values so a fixture change fails loudly here first.
// ---------------------------------------------------------------------------

const DATA_DIR = process.env["CHITRAGUPTA_DATA_DIR"]?.trim() || null;
const describeData = DATA_DIR ? describe : describe.skip;

const CATEGORY_SQL = `COALESCE(t.category, m.category,
  CASE t.movement
    WHEN 'spend' THEN 'One-off' WHEN 'income' THEN 'One-off'
    WHEN 'aside' THEN 'Moved aside' WHEN 'fee' THEN 'Fees'
    WHEN 'interest' THEN 'Interest' ELSE 'Transfer' END)`;

describeData("pull completeness on the real fixture", () => {
  let realDb: Database.Database;
  let realDir: string | null = null;
  let apiReal: Api;
  let sep: { n: number; s: number };
  let oct: { n: number; s: number };
  let ocado: { n: number; s: number };
  let holidaysAll: number;
  let holidaysSep: number;
  let groceriesMar: number;

  beforeAll(async () => {
    realDir = mkdtempSync(join(tmpdir(), "chitra-pull-real-"));
    realDb = openStore(realDir);
    ingestAll(realDb, DATA_DIR!, "zonito");
    seedMerchantMemory(realDb);
    recomputeAggregates(realDb, "zonito");

    const spendFor = (month: string) =>
      realDb
        .prepare(
          `SELECT COUNT(*) AS n, COALESCE(SUM(-amount_minor), 0) AS s
           FROM transactions
           WHERE year_month = ? AND movement = 'spend' AND currency = 'GBP'`,
        )
        .get(month) as { n: number; s: number };
    sep = spendFor("2026-09");
    oct = spendFor("2026-10");
    ocado = realDb
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(-amount_minor), 0) AS s
         FROM transactions
         WHERE year_month = '2026-10' AND movement = 'spend' AND currency = 'GBP'
           AND merchant LIKE 'Ocado%'`,
      )
      .get() as { n: number; s: number };
    const catCount = (category: string, month?: string) =>
      (
        realDb
          .prepare(
            `SELECT COUNT(*) AS n FROM transactions t
             LEFT JOIN merchant_memory m ON m.merchant = t.merchant
             WHERE ${CATEGORY_SQL} = ? ${month ? "AND t.year_month = ?" : ""}`,
          )
          .get(...(month ? [category, month] : [category])) as { n: number }
      ).n;
    holidaysAll = catCount("Holidays");
    holidaysSep = catCount("Holidays", "2026-09");
    groceriesMar = catCount("Groceries", "2026-03");

    // The real-data API handler needs its own store binding: reset the
    // module registry so api.ts builds its cached connection from the
    // real-data store dir instead of the synthetic one above.
    vi.resetModules();
    process.env["CHITRAGUPTA_STORE_DIR"] = realDir;
    apiReal = await import("@/lib/api");
  }, 180_000);

  afterAll(() => {
    realDb?.close();
    if (realDir) rmSync(realDir, { recursive: true, force: true });
    process.env["CHITRAGUPTA_STORE_DIR"] = SYNTH_STORE_DIR;
  });

  it("pins the fixture-derived figures the Ask assertions rest on", () => {
    expect(sep).toEqual({ n: 84, s: 324178 });
    expect(oct).toEqual({ n: 73, s: 195238 });
    expect(ocado).toEqual({ n: 5, s: 21329 });
    expect(holidaysAll).toBe(49);
    expect(groceriesMar).toBe(14);
    expect(holidaysSep).toBeGreaterThan(0);
  });

  it("Ask totals September 2026 completely (226 rows in the month)", async () => {
    const result = await answerAsk(realDb, {
      question: "How much did we spend in September?",
      env: {},
    });
    expect(result.figures.total).toBe(sep.s / 100);
    expect(result.figures.total).toBe(3241.78);
    expect(result.figures.count).toBe(sep.n);
    expect(result.figures.truncated).toBe(false);
    expect(result.answer).toContain("£3,241.78");
  });

  it("Ask totals October 2026 completely", async () => {
    const result = await answerAsk(realDb, {
      question: "How much did we spend in October?",
      env: {},
    });
    expect(result.figures.total).toBe(oct.s / 100);
    expect(result.figures.total).toBe(1952.38);
    expect(result.figures.count).toBe(oct.n);
    expect(result.figures.truncated).toBe(false);
  });

  it("Ask answers the October Ocado example untruncated (204 rows in the month)", async () => {
    const result = await answerAsk(realDb, {
      question: "How much on Ocado this month?",
      env: {},
    });
    expect(result.figures.total).toBe(ocado.s / 100);
    expect(result.figures.total).toBe(213.29);
    expect(result.figures.count).toBe(ocado.n);
    expect(result.figures.count).toBe(5);
    expect(result.figures.truncated).toBe(false);
  });

  it("/api/transactions returns every Holidays row, not just those inside the newest 200", async () => {
    const body = await getTransactions("category=Holidays&limit=200", apiReal);
    expect(body.count).toBe(holidaysAll);
    expect(body.count).toBe(49);
    expect(body.transactions.every((t) => t.category === "Holidays")).toBe(
      true,
    );
  });

  it("/api/transactions scopes category by month in SQL", async () => {
    const sepBody = await getTransactions(
      "category=Holidays&month=2026-09&limit=200",
      apiReal,
    );
    expect(sepBody.count).toBe(holidaysSep);
    expect(sepBody.transactions.every((t) => t.category === "Holidays")).toBe(
      true,
    );
    const marBody = await getTransactions(
      "category=Groceries&month=2026-03&limit=200",
      apiReal,
    );
    expect(marBody.count).toBe(groceriesMar);
    expect(marBody.count).toBe(14);
    expect(marBody.transactions.every((t) => t.category === "Groceries")).toBe(
      true,
    );
  });
});
