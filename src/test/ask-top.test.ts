import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { answerAsk, parseAskPlan } from "@/lib/ask.server";
import { parseAskQuery } from "@/lib/ask-query";
import { ingestAll } from "@/lib/ingest/ingest";
import { recomputeAggregates } from "@/lib/ingest/ingest";
import { openStore } from "@/lib/ingest/store";

/**
 * Top-N Ask answers and the zero-match guard. "Top 5 transactions for
 * this month" is a LIST question: before this work the planner mapped
 * it onto a filtered total that matched nothing, and the app answered
 * a false £0.00 for a month with heavy spend. These tests pin the
 * ranked-list computation (rows and sums computed by code alone), the
 * planner's "top" kind, and the guard that turns any total/top zero in
 * a spend-bearing period into an honest fallback instead.
 */

const TODAY = "2026-10-31";

function topDb() {
  const db = openStore(mkdtempSync(join(tmpdir(), "chitra-top-")));
  const insert = db.prepare(
    `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
      description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
     VALUES (?, 'zonito', 'Main', ?, ?, ?, ?, ?, 0, 'GBP', 100000, 'spend', ?)`,
  );
  const rows: [string, string, string, string, number][] = [
    // fingerprint, date, merchant, category, amountMinor
    ["o1", "2026-10-02", "Alpha Flights", "Holidays", -90000],
    ["o2", "2026-10-09", "Beta Store", "Shopping", -45000],
    ["o3", "2026-10-11", "Gamma Cafe", "Shopping", -1200],
    ["o4", "2026-10-15", "Delta Market", "Groceries", -30000],
    ["o5", "2026-10-20", "Delta Market", "Groceries", -30000],
    ["o6", "2026-10-21", "Epsilon Books", "Shopping", -750],
    ["s1", "2026-09-03", "Zeta Travel", "Holidays", -60000],
    ["s2", "2026-09-10", "Eta Pharmacy", "Shopping", -2000],
    ["s3", "2026-09-18", "Theta Gym", "Shopping", -4999],
  ];
  for (const [fp, date, merchant, category, amount] of rows) {
    insert.run(
      fp,
      date,
      date.slice(0, 7),
      merchant,
      merchant,
      amount,
      category,
    );
  }
  // The guard reads month_aggregates; build them as ingest would.
  recomputeAggregates(db, "zonito");
  recomputeAggregates(db, "household");
  return db;
}

const OCT_TOP5 = [
  { merchant: "Alpha Flights", date: "2 Oct 2026", amount: 900 },
  { merchant: "Beta Store", date: "9 Oct 2026", amount: 450 },
  { merchant: "Delta Market", date: "20 Oct 2026", amount: 300 },
  { merchant: "Delta Market", date: "15 Oct 2026", amount: 300 },
  { merchant: "Gamma Cafe", date: "11 Oct 2026", amount: 12 },
];
// September renders as "Sept" in the app's en-GB day format.
const SEP_TOP3 = [
  { merchant: "Zeta Travel", date: "3 Sept 2026", amount: 600 },
  { merchant: "Theta Gym", date: "18 Sept 2026", amount: 49.99 },
  { merchant: "Eta Pharmacy", date: "10 Sept 2026", amount: 20 },
];
// Every October spend row: 900 + 450 + 12 + 300 + 300 + 7.50.
const OCT_TOTAL = 1969.5;

/** A gateway mock: the planner call gets `planText`, prose gets `prose`. */
function gatewayFetch(planText: string, prose: string) {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { system?: string };
    const isPlanner = (body.system ?? "").includes("query planner");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: "text", text: isPlanner ? planText : prose }],
      }),
    } as Response;
  }) as typeof fetch;
}

describe("parseAskQuery list shapes", () => {
  it("routes 'Top 5 transactions for this month' to a top plan", () => {
    const plan = parseAskQuery(
      "Top 5 transactions for this month",
      "2026-10",
      TODAY,
    );
    expect(plan.top).toBe(5);
    expect(plan.month).toBe("2026-10");
  });

  it("routes 'Biggest 3 payments in September' to a top plan for that month", () => {
    const plan = parseAskQuery(
      "Biggest 3 payments in September",
      "2026-10",
      TODAY,
    );
    expect(plan.top).toBe(3);
    expect(plan.month).toBe("2026-09");
  });

  it("keeps a count stated before the ranking word", () => {
    const plan = parseAskQuery(
      "Show me 3 biggest transactions this month",
      "2026-10",
      TODAY,
    );
    expect(plan.top).toBe(3);
    expect(plan.month).toBe("2026-10");
  });

  it("understands a number word and defaults a plural noun to 5", () => {
    expect(
      parseAskQuery("Top five transactions this month", "2026-10", TODAY).top,
    ).toBe(5);
    expect(
      parseAskQuery("Show my top transactions", "2026-10", TODAY).top,
    ).toBe(5);
    expect(
      parseAskQuery(
        "What was my biggest payment in September?",
        "2026-10",
        TODAY,
      ).top,
    ).toBe(1);
  });

  it("does not mistake 'top up' or an ordinary total for a list", () => {
    expect(
      parseAskQuery("How much did I top up this month?", "2026-10", TODAY).top,
    ).toBeUndefined();
    expect(
      parseAskQuery("What did we spend in August?", "2026-10", TODAY).top,
    ).toBeUndefined();
    expect(
      parseAskQuery("What is my biggest spending category?", "2026-10", TODAY)
        .top,
    ).toBeUndefined();
  });
});

describe("parseAskPlan top kind", () => {
  const base = {
    category: null,
    query: null,
    from: null,
    to: null,
    month: "2026-10",
  };

  it("accepts a top plan with a limit", () => {
    const plan = parseAskPlan(
      JSON.stringify({ ...base, kind: "top", limit: 3 }),
    );
    expect(plan?.kind).toBe("top");
    expect(plan?.limit).toBe(3);
  });

  it("defaults an absent limit to 5 and clamps an oversized one to 25", () => {
    expect(
      parseAskPlan(JSON.stringify({ ...base, kind: "top", limit: null }))
        ?.limit,
    ).toBe(5);
    expect(
      parseAskPlan(JSON.stringify({ ...base, kind: "top", limit: 100 }))?.limit,
    ).toBe(25);
  });

  it("rejects a non-numeric or fractional limit", () => {
    expect(
      parseAskPlan(JSON.stringify({ ...base, kind: "top", limit: "3" })),
    ).toBeNull();
    expect(
      parseAskPlan(JSON.stringify({ ...base, kind: "top", limit: 2.5 })),
    ).toBeNull();
  });

  it("keeps non-top plans free of any limit field", () => {
    const plan = parseAskPlan(
      JSON.stringify({ ...base, kind: "total", limit: 3 }),
    );
    expect(plan).toEqual({
      kind: "total",
      category: null,
      query: null,
      from: null,
      to: null,
      month: "2026-10",
    });
  });
});

describe("top-N answers", () => {
  it("ranks this month's transactions deterministically with no key", async () => {
    const db: Database.Database = topDb();
    const result = await answerAsk(db, {
      question: "Top 5 transactions for this month",
      today: TODAY,
      env: {},
    });
    expect(result.ai).toBe(false);
    expect(result.figures.top).toEqual(OCT_TOP5);
    expect(result.figures).toMatchObject({
      total: 1962,
      count: 5,
      month: "2026-10",
      perMonth: null,
      truncated: false,
    });
    expect(result.answer).toContain("Alpha Flights");
    expect(result.answer).toContain("Together: £1,962.00.");
    db.close();
  });

  it("ranks a named month's biggest payments deterministically", async () => {
    const db: Database.Database = topDb();
    const result = await answerAsk(db, {
      question: "Biggest 3 payments in September",
      today: TODAY,
      env: {},
    });
    expect(result.ai).toBe(false);
    expect(result.figures.top).toEqual(SEP_TOP3);
    expect(result.figures.total).toBe(669.99);
    expect(result.figures.count).toBe(3);
    db.close();
  });

  it("drives a planner top plan to the same ranked rows", async () => {
    const db: Database.Database = topDb();
    const plan = JSON.stringify({
      kind: "top",
      category: null,
      query: null,
      from: null,
      to: null,
      month: "2026-09",
      limit: 3,
    });
    const result = await answerAsk(db, {
      question: "Biggest 3 payments in September",
      today: TODAY,
      env: { MUSE_API_KEY: "LLM_test" },
      fetchImpl: gatewayFetch(
        plan,
        "Your biggest September payment was Zeta Travel at £600.00.",
      ),
    });
    expect(result.ai).toBe(true);
    expect(result.figures.top).toEqual(SEP_TOP3);
    expect(result.figures.total).toBe(669.99);
    db.close();
  });
});

describe("zero-match guard", () => {
  it("never answers £0.00 for a category the deterministic parser totals to zero in a spend month", async () => {
    const db: Database.Database = topDb();
    const result = await answerAsk(db, {
      question: "How much did we spend on transport in October?",
      today: TODAY,
      env: {},
    });
    expect(result.ai).toBe(false);
    expect(result.figures.total).toBe(OCT_TOTAL);
    expect(result.figures.count).toBe(6);
    expect(result.answer).toContain(
      "Nothing matched that specific search in October 2026.",
    );
    expect(result.answer).toContain("£1,969.50");
    expect(result.answer).not.toContain("£0.00");
    db.close();
  });

  it("never answers £0.00 for an engineered planner filter that matches nothing", async () => {
    const db: Database.Database = topDb();
    // The live failure's shape: the planner chose a category filter
    // that excludes every row of a spend-heavy month.
    const plan = JSON.stringify({
      kind: "total",
      category: "Transport",
      query: null,
      from: null,
      to: null,
      month: "2026-10",
    });
    const result = await answerAsk(db, {
      question: "Top 5 transactions for this month",
      today: TODAY,
      env: { MUSE_API_KEY: "LLM_test" },
      fetchImpl: gatewayFetch(plan, "October's spend came to £1,969.50."),
    });
    expect(result.ai).toBe(true);
    expect(result.figures.total).toBe(OCT_TOTAL);
    expect(result.figures.count).toBe(6);
    expect(result.answer).not.toContain("£0.00");
    db.close();
  });

  it("falls back to the unfiltered ranking when a top plan's filter matches nothing", async () => {
    const db: Database.Database = topDb();
    const plan = JSON.stringify({
      kind: "top",
      category: "Transport",
      query: null,
      from: null,
      to: null,
      month: "2026-10",
      limit: 2,
    });
    const result = await answerAsk(db, {
      question: "Top 2 transport transactions this month",
      today: TODAY,
      env: { MUSE_API_KEY: "LLM_test" },
      fetchImpl: gatewayFetch(plan, "Alpha Flights leads at £900.00."),
    });
    expect(result.figures.top).toEqual(OCT_TOP5.slice(0, 2));
    expect(result.figures.total).toBe(1350);
    expect(result.figures.count).toBe(2);
    db.close();
  });

  it("leaves a genuine zero alone: a spend-free month is not guarded", async () => {
    const db: Database.Database = topDb();
    const plan = JSON.stringify({
      kind: "total",
      category: "Transport",
      query: null,
      from: null,
      to: null,
      month: "2026-08",
    });
    const result = await answerAsk(db, {
      question: "How much on transport in August?",
      today: TODAY,
      env: { MUSE_API_KEY: "LLM_test" },
      fetchImpl: gatewayFetch(
        plan,
        "No Transport spending in August 2026 — the total is £0.00.",
      ),
    });
    // August has no rows and no aggregates: the zero is true and stands.
    expect(result.figures.total).toBe(0);
    expect(result.figures.count).toBe(0);
    db.close();
  });
});

const DATA_DIR = process.env["CHITRAGUPTA_DATA_DIR"]?.trim() || null;
const describeRepro = DATA_DIR ? describe : describe.skip;

describeRepro("top-N answers on the repro fixture", () => {
  let dir: string | null = null;
  let db: Database.Database;

  const dayFmt = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  const dayName = (ymd: string) => dayFmt.format(new Date(`${ymd}T00:00:00Z`));

  /**
   * The expected ranking, derived straight from the store with plain
   * SQL — never through the code under test. Largest spend first;
   * ties broken newest-first, then merchant, then fingerprint, the
   * same documented order the ranking promises.
   */
  function expectedTop(month: string, n: number) {
    const rows = db
      .prepare(
        `SELECT merchant, substr(effective_date, 1, 10) AS date, -amount_minor AS amt
         FROM transactions
         WHERE movement = 'spend' AND currency = 'GBP' AND amount_minor < 0
           AND year_month = ?
         ORDER BY amount_minor ASC, substr(effective_date, 1, 10) DESC, merchant ASC, fingerprint ASC
         LIMIT ?`,
      )
      .all(month, n) as { merchant: string; date: string; amt: number }[];
    return {
      top: rows.map((r) => ({
        merchant: r.merchant,
        date: dayName(r.date),
        amount: r.amt / 100,
      })),
      total: Math.round(rows.reduce((s, r) => s + r.amt, 0)) / 100,
    };
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "chitra-ask-top-"));
    db = openStore(dir);
    ingestAll(db, DATA_DIR!);
  }, 180_000);

  afterAll(() => {
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("answers 'Top 5 transactions for this month' with the fixture's true October ranking", async () => {
    const expected = expectedTop("2026-10", 5);
    expect(expected.top.length).toBe(5);
    expect(expected.total).toBeGreaterThan(0);

    const result = await answerAsk(db, {
      question: "Top 5 transactions for this month",
      today: TODAY,
      env: {},
    });
    expect(result.ai).toBe(false);
    expect(result.figures.top).toEqual(expected.top);
    expect(result.figures.total).toBe(expected.total);
    expect(result.figures.count).toBe(5);
    expect(result.figures.month).toBe("2026-10");
    expect(result.answer).not.toContain("£0.00");
  }, 60_000);

  it("answers 'Biggest 3 payments in September' with the fixture's true September ranking", async () => {
    const expected = expectedTop("2026-09", 3);
    expect(expected.top.length).toBe(3);
    expect(expected.total).toBeGreaterThan(0);

    const result = await answerAsk(db, {
      question: "Biggest 3 payments in September",
      today: TODAY,
      env: {},
    });
    expect(result.ai).toBe(false);
    expect(result.figures.top).toEqual(expected.top);
    expect(result.figures.total).toBe(expected.total);
    expect(result.figures.count).toBe(3);
    expect(result.figures.month).toBe("2026-09");
  }, 60_000);
});
