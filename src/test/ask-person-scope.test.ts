import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { parseAskQuery, personFromQuestion } from "@/lib/ask-query";
import { answerAsk, parseAskPlan } from "@/lib/ask.server";
import { ingestAll, recomputeAggregates } from "@/lib/ingest/ingest";
import { openStore } from "@/lib/ingest/store";

/**
 * Person scoping in Ask: a person NAMED IN THE QUESTION scopes the
 * computation, overriding the current view. Before this work the name
 * was picked up for phrasing only — asked from the household view,
 * "Top 5 transactions from nikhila for this month" returned the
 * HOUSEHOLD top 5 while the prose called them Nikhila's, and "How
 * much did Nikhila spend in October 2026?" matched nothing at all
 * (the name poisoned the records search). These tests pin the
 * extraction (deterministic parser and planner plan alike), the
 * scoped computation for every shape, and the regression guard: a
 * person's name is never attached to another scope's figures.
 */

const TODAY = "2026-10-31";

function twoPersonDb() {
  const db = openStore(mkdtempSync(join(tmpdir(), "chitra-person-")));
  const insert = db.prepare(
    `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
      description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'GBP', 100000, 'spend', ?)`,
  );
  // fingerprint, person, account, date, merchant, amountMinor, category
  const rows: [string, string, string, string, string, number, string][] = [
    // Zonito's October.
    ["z1", "zonito", "Main", "2026-10-05", "Ocado", -30000, "Groceries"],
    ["z2", "zonito", "Main", "2026-10-09", "Penny Caulfield", -14800, "School"],
    ["z3", "zonito", "Pro", "2026-10-14", "Adyen N.v.", -47623, "Transport"],
    // Nikhila's October.
    ["n1", "nikhila", "Pro", "2026-10-26", "UNIQLO", -4990, "Shopping"],
    ["n2", "nikhila", "Pro", "2026-10-11", "The Kati Roll Company", -2435, "Eating out"],
    ["n3", "nikhila", "Pro", "2026-10-30", "Transport for London", -1245, "Transport"],
    // A joint October row: the household counts £100, each person £50.
    ["j1", "zonito", "Joint", "2026-10-02", "Joint Merchant", -10000, "Home"],
  ];
  for (const [fp, person, account, date, merchant, amount, category] of rows) {
    insert.run(fp, person, account, date, date.slice(0, 7), merchant, merchant, amount, category);
  }
  // The guard reads month_aggregates; build them as ingest would.
  recomputeAggregates(db, "zonito");
  recomputeAggregates(db, "nikhila");
  recomputeAggregates(db, "household");
  return db;
}

// Nikhila's October, shareOf semantics (own rows in full, joint half).
const NIK_TOP = [
  { merchant: "Joint Merchant", date: "2 Oct 2026", amount: 50 },
  { merchant: "UNIQLO", date: "26 Oct 2026", amount: 49.9 },
  { merchant: "The Kati Roll Company", date: "11 Oct 2026", amount: 24.35 },
  { merchant: "Transport for London", date: "30 Oct 2026", amount: 12.45 },
];
const NIK_TOTAL = 136.7; // 50 + 49.90 + 24.35 + 12.45

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

describe("personFromQuestion", () => {
  it("recognises the named forms for both people", () => {
    expect(personFromQuestion("Top 5 transactions from nikhila for this month")).toBe("nikhila");
    expect(personFromQuestion("Nikhila's biggest payments")).toBe("nikhila");
    expect(personFromQuestion("Nikhila’s biggest payments")).toBe("nikhila");
    expect(personFromQuestion("How much did Zonito spend?")).toBe("zonito");
    expect(personFromQuestion("spending for nikhila in October")).toBe("nikhila");
    expect(personFromQuestion("Show me Nikhila spending in October")).toBe("nikhila");
    expect(personFromQuestion("What did we buy for Zonito?")).toBe("zonito");
  });

  it("names nobody for first person or for both names together", () => {
    expect(personFromQuestion("How much did we spend in October?")).toBeUndefined();
    expect(personFromQuestion("What was my biggest payment?")).toBeUndefined();
    expect(personFromQuestion("What is our total spend?")).toBeUndefined();
    expect(personFromQuestion("Did Nikhila pay Zonito back?")).toBeUndefined();
    expect(personFromQuestion("Top 5 transactions for this month")).toBeUndefined();
  });
});

describe("parseAskQuery person extraction", () => {
  it("scopes the repro question and strips the name from the terms", () => {
    const plan = parseAskQuery("Top 5 transactions from nikhila for this month", "2026-10", TODAY);
    expect(plan.person).toBe("nikhila");
    expect(plan.top).toBe(5);
    expect(plan.month).toBe("2026-10");
    expect(plan.terms).not.toContain("nikhila");
  });

  it("strips a possessive name and its stray 's' from the terms", () => {
    const plan = parseAskQuery("Nikhila's spending in October 2026", "2026-10", TODAY);
    expect(plan.person).toBe("nikhila");
    expect(plan.month).toBe("2026-10");
    expect(plan.terms).toEqual([]);
  });

  it("leaves no-person questions without a person field", () => {
    const plan = parseAskQuery("How much did we spend in October 2026?", "2026-10", TODAY);
    expect(plan.person).toBeUndefined();
    expect(plan).not.toHaveProperty("person");
  });
});

describe("parseAskPlan person validation", () => {
  const base = { kind: "top", category: null, query: null, from: null, to: null, month: "2026-10", limit: 5 };

  it("accepts and canonicalises a known person", () => {
    expect(parseAskPlan(JSON.stringify({ ...base, person: "Nikhila" }))?.person).toBe("nikhila");
    expect(parseAskPlan(JSON.stringify({ ...base, person: "household" }))?.person).toBe("household");
    expect(parseAskPlan(JSON.stringify({ ...base, person: null }))).not.toHaveProperty("person");
  });

  it("rejects a person outside the known set, invalidating the plan", () => {
    expect(parseAskPlan(JSON.stringify({ ...base, person: "dhyani" }))).toBeNull();
    expect(parseAskPlan(JSON.stringify({ ...base, person: 42 }))).toBeNull();
    expect(parseAskPlan(JSON.stringify({ ...base, person: "" }))).toBeNull();
  });
});

describe("person-scoped answers", () => {
  it("answers the repro question with Nikhila's rows, not the household's", async () => {
    const db: Database.Database = twoPersonDb();
    const result = await answerAsk(db, {
      question: "Top 5 transactions from nikhila for this month",
      today: TODAY,
      env: {},
    });
    expect(result.ai).toBe(false);
    expect(result.figures.top).toEqual(NIK_TOP);
    expect(result.figures.total).toBe(NIK_TOTAL);
    expect(result.figures.count).toBe(4);
    // The regression guard for the reported bug: her name, her rows —
    // and none of Zonito's merchants under her name.
    expect(result.answer).toContain("Figures for Nikhila, as your question asked:");
    expect(result.answer).toContain("UNIQLO");
    expect(result.answer).not.toContain("Ocado");
    expect(result.answer).not.toContain("Penny Caulfield");
    expect(result.answer).not.toContain("Adyen");
    db.close();
  });

  it("totals a named person's month for that person", async () => {
    const db: Database.Database = twoPersonDb();
    const result = await answerAsk(db, {
      question: "How much did Nikhila spend in October 2026?",
      today: TODAY,
      env: {},
    });
    expect(result.ai).toBe(false);
    expect(result.figures.total).toBe(NIK_TOTAL);
    expect(result.figures.count).toBe(4);
    expect(result.answer).toContain("Figures for Nikhila, as your question asked:");
    expect(result.answer).toContain("£136.70 spent in October 2026 across 4 transactions.");
    db.close();
  });

  it("scopes a Zonito-named question asked from Nikhila's view to Zonito", async () => {
    const db: Database.Database = twoPersonDb();
    const result = await answerAsk(db, {
      question: "Top 3 transactions from Zonito for this month",
      person: "nikhila",
      today: TODAY,
      env: {},
    });
    expect(result.figures.top).toEqual([
      { merchant: "Adyen N.v.", date: "14 Oct 2026", amount: 476.23 },
      { merchant: "Ocado", date: "5 Oct 2026", amount: 300 },
      { merchant: "Penny Caulfield", date: "9 Oct 2026", amount: 148 },
    ]);
    expect(result.figures.total).toBe(924.23);
    expect(result.answer).toContain("Figures for Zonito, as your question asked:");
    db.close();
  });

  it("keeps no-person questions on the view, wording unchanged", async () => {
    const db: Database.Database = twoPersonDb();
    const top = await answerAsk(db, {
      question: "Top 5 transactions for this month",
      today: TODAY,
      env: {},
    });
    expect(top.figures.top).toEqual([
      { merchant: "Adyen N.v.", date: "14 Oct 2026", amount: 476.23 },
      { merchant: "Ocado", date: "5 Oct 2026", amount: 300 },
      { merchant: "Penny Caulfield", date: "9 Oct 2026", amount: 148 },
      { merchant: "Joint Merchant", date: "2 Oct 2026", amount: 100 },
      { merchant: "UNIQLO", date: "26 Oct 2026", amount: 49.9 },
    ]);
    expect(top.figures.total).toBe(1074.13);
    expect(top.answer).not.toContain("Figures for");

    const total = await answerAsk(db, {
      question: "How much did we spend in October 2026?",
      today: TODAY,
      env: {},
    });
    expect(total.figures.total).toBe(1110.93);
    expect(total.figures.count).toBe(7);
    expect(total.answer).toBe("£1,110.93 spent in October 2026 across 7 transactions.");
    db.close();
  });

  it("guards a person-scoped zero against THAT person's aggregates", async () => {
    const db: Database.Database = twoPersonDb();
    // Nikhila has no School rows (Penny is Zonito's), but her October
    // has spend — the guard must recompute HER unfiltered total, not
    // present £0.00 and not fall back to the household's figures.
    const result = await answerAsk(db, {
      question: "How much did Nikhila spend on school in October?",
      today: TODAY,
      env: {},
    });
    expect(result.ai).toBe(false);
    expect(result.figures.total).toBe(NIK_TOTAL);
    expect(result.figures.count).toBe(4);
    expect(result.answer).toContain("Figures for Nikhila, as your question asked:");
    expect(result.answer).toContain("Nothing matched that specific search in October 2026.");
    expect(result.answer).toContain("£136.70");
    expect(result.answer).not.toContain("£1,110.93");
    db.close();
  });

  it("honours the planner's person field on a question that names nobody", async () => {
    const db: Database.Database = twoPersonDb();
    const plan = JSON.stringify({
      kind: "top",
      person: "nikhila",
      category: null,
      query: null,
      from: null,
      to: null,
      month: "2026-10",
      limit: 2,
    });
    const result = await answerAsk(db, {
      question: "Top 2 transactions for this month",
      today: TODAY,
      env: { MUSE_API_KEY: "LLM_test" },
      fetchImpl: gatewayFetch(plan, "Nikhila's biggest was the joint merchant at £50.00."),
    });
    expect(result.ai).toBe(true);
    expect(result.figures.top).toEqual(NIK_TOP.slice(0, 2));
    expect(result.figures.total).toBe(99.9);
    db.close();
  });

  it("scopes a planner latest plan: another person's merchant is not her record", async () => {
    const db: Database.Database = twoPersonDb();
    const plan = JSON.stringify({
      kind: "latest",
      person: "nikhila",
      category: null,
      query: "Ocado",
      from: null,
      to: null,
      month: null,
    });
    const result = await answerAsk(db, {
      question: "When did Nikhila last order from Ocado?",
      today: TODAY,
      env: { MUSE_API_KEY: "LLM_test" },
      fetchImpl: gatewayFetch(plan, "No record of that."),
    });
    // Ocado is Zonito's merchant; scoped to Nikhila there is no record.
    expect(result.figures.latest).toBeNull();
    expect(result.figures.total).toBe(0);
    expect(result.figures.count).toBe(0);
    db.close();
  });

  it("discards a plan naming an unknown person wholesale", async () => {
    const db: Database.Database = twoPersonDb();
    const plan = JSON.stringify({
      kind: "top",
      person: "dhyani",
      category: null,
      query: null,
      from: null,
      to: null,
      month: "2026-10",
      limit: 5,
    });
    const result = await answerAsk(db, {
      question: "Top 5 transactions for this month",
      today: TODAY,
      env: { MUSE_API_KEY: "LLM_test" },
      fetchImpl: gatewayFetch(plan, "Household answer."),
    });
    // The invalid plan is gone; the deterministic household ranking stands.
    expect(result.figures.total).toBe(1074.13);
    expect(result.figures.count).toBe(5);
    db.close();
  });
});

const DATA_DIR = process.env["CHITRAGUPTA_DATA_DIR"]?.trim() || null;
const describeRepro = DATA_DIR ? describe : describe.skip;

describeRepro("person-scoped answers on the repro fixture", () => {
  let dir: string | null = null;
  let db: Database.Database;

  const dayFmt = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  const dayName = (ymd: string) =>
    dayFmt.format(new Date(`${ymd}T00:00:00Z`));

  /**
   * The expected ranking for one person, derived straight from the
   * store with plain SQL — never through the code under test. A
   * person's set is their own rows in full plus Joint-account rows at
   * half (shareOf); ties break newest-first, then merchant, then
   * fingerprint, the ranking's documented order.
   */
  function expectedTop(person: string, month: string, n: number) {
    const rows = db
      .prepare(
        `SELECT merchant, substr(effective_date, 1, 10) AS date,
                CASE WHEN account = 'Joint' THEN -amount_minor * 0.5 ELSE -amount_minor END AS share
         FROM transactions
         WHERE movement = 'spend' AND currency = 'GBP' AND amount_minor < 0
           AND year_month = ? AND (person = ? OR account = 'Joint')
         ORDER BY share DESC, substr(effective_date, 1, 10) DESC, merchant ASC, fingerprint ASC
         LIMIT ?`,
      )
      .all(month, person, n) as { merchant: string; date: string; share: number }[];
    return {
      top: rows.map((r) => ({
        merchant: r.merchant,
        date: dayName(r.date),
        amount: Math.round(r.share) / 100,
      })),
      total: Math.round(rows.reduce((s, r) => s + r.share, 0)) / 100,
    };
  }

  function aggregateTotal(person: string, month: string): number {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(spend_minor), 0) AS s FROM month_aggregates
         WHERE person = ? AND year_month = ? AND currency = 'GBP'`,
      )
      .get(person, month) as { s: number };
    return row.s / 100;
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "chitra-ask-person-"));
    db = openStore(dir);
    ingestAll(db, DATA_DIR!);
  }, 180_000);

  afterAll(() => {
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("answers the repro question with Nikhila's own October ranking", async () => {
    const expected = expectedTop("nikhila", "2026-10", 5);
    expect(expected.top.length).toBe(5);
    expect(expected.top[0]).toMatchObject({ merchant: "UNIQLO", date: "26 Oct 2026" });

    const result = await answerAsk(db, {
      question: "Top 5 transactions from nikhila for this month",
      today: TODAY,
      env: {},
    });
    expect(result.ai).toBe(false);
    expect(result.figures.top).toEqual(expected.top);
    expect(result.figures.total).toBe(expected.total);
    expect(result.figures.count).toBe(5);
    expect(result.answer).toContain("Figures for Nikhila, as your question asked:");
    expect(result.answer).toContain("UNIQLO");
    // The household ranking's merchants must not appear under her name.
    expect(result.answer).not.toContain("The London Eye");
    expect(result.answer).not.toContain("Ocado");
    expect(result.answer).not.toContain("Penny Caulfield");
  }, 60_000);

  it("totals Nikhila's October to her fixture aggregate", async () => {
    const expected = aggregateTotal("nikhila", "2026-10");
    expect(expected).toBeGreaterThan(0);

    const result = await answerAsk(db, {
      question: "How much did Nikhila spend in October 2026?",
      today: TODAY,
      env: {},
    });
    expect(result.ai).toBe(false);
    expect(result.figures.total).toBe(expected);
    expect(result.answer).toContain("Figures for Nikhila, as your question asked:");
  }, 60_000);

  it("scopes a Zonito-named question asked from Nikhila's view to Zonito", async () => {
    const expected = expectedTop("zonito", "2026-10", 5);
    expect(expected.top.length).toBe(5);

    const result = await answerAsk(db, {
      question: "Top 5 transactions from Zonito for this month",
      person: "nikhila",
      today: TODAY,
      env: {},
    });
    expect(result.ai).toBe(false);
    expect(result.figures.top).toEqual(expected.top);
    expect(result.figures.total).toBe(expected.total);
    expect(result.answer).toContain("Figures for Zonito, as your question asked:");
  }, 60_000);

  it("keeps the no-person October total on the household aggregate", async () => {
    const expected = aggregateTotal("household", "2026-10");
    expect(expected).toBeGreaterThan(0);

    const result = await answerAsk(db, {
      question: "How much did we spend in October 2026?",
      today: TODAY,
      env: {},
    });
    expect(result.ai).toBe(false);
    expect(result.figures.total).toBe(expected);
    expect(result.answer).not.toContain("Figures for");
  }, 60_000);
});
