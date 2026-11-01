import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { answerAsk, parseAskPlan } from "@/lib/ask.server";
import { openStore } from "@/lib/ingest/store";

/**
 * Ask v3: when a gateway key is configured, a model PLANNER turns the
 * question into a validated JSON plan and the plan drives the pull;
 * totals and latest records are then computed directly over the pulled
 * set. Any invalid plan falls back to the deterministic parser. These
 * tests pin the validation, the planner-driven totals, the
 * deterministic relative-period path, and the gateway diagnostics.
 */

// Friday 30 Oct 2026; its week is Mon 26 Oct – Sun 1 Nov 2026.
const TODAY = "2026-10-30";

function transportDb() {
  const db = openStore(mkdtempSync(join(tmpdir(), "chitra-plan-")));
  const insert = db.prepare(
    `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
      description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
     VALUES (?, 'zonito', 'Main', ?, ?, ?, ?, ?, 0, 'GBP', 100000, 'spend', ?)`,
  );
  const rows: [string, string, string, string, number][] = [
    // fingerprint, date, merchant, category, amountMinor
    ["t1", "2026-10-27", "Transport for London", "Transport", -720],
    ["t2", "2026-10-30", "Transport for London", "Transport", -1245],
    ["t3", "2026-10-20", "Transport for London", "Transport", -900],
    ["t4", "2026-10-05", "Transport for London", "Transport", -500],
    ["g1", "2026-10-28", "Ocado", "Groceries", -3000],
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
  return db;
}

function mahavirDb() {
  const db = openStore(mkdtempSync(join(tmpdir(), "chitra-plan-")));
  const insert = db.prepare(
    `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
      description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
     VALUES (?, 'zonito', 'Pro', ?, ?, ?, ?, ?, 0, 'GBP', 100000, 'spend', ?)`,
  );
  insert.run(
    "m1",
    "2026-08-03",
    "2026-08",
    "Mahavir Sweet Mart",
    "Mahavir Sweet Mart",
    -2710,
    "Groceries",
  );
  insert.run(
    "m2",
    "2026-05-17",
    "2026-05",
    "Mahavir Sweet Mart",
    "Mahavir Sweet Mart",
    -2660,
    "Groceries",
  );
  return db;
}

type FetchSeen = { systems: (string | undefined)[] };

/**
 * A gateway mock that answers the planner call (identified by its
 * system prompt) with `planText` and every other call with `prose`.
 */
function gatewayFetch(planText: string, prose: string, seen?: FetchSeen) {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { system?: string };
    seen?.systems.push(body.system);
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

const WEEK_PLAN = JSON.stringify({
  kind: "total",
  category: "Transport",
  query: null,
  from: "2026-10-26",
  to: "2026-11-01",
  month: null,
});

describe("parseAskPlan validation", () => {
  it("accepts a valid total plan", () => {
    expect(parseAskPlan(WEEK_PLAN)).toEqual({
      kind: "total",
      category: "Transport",
      query: null,
      from: "2026-10-26",
      to: "2026-11-01",
      month: null,
    });
  });

  it("canonicalises a category's case", () => {
    const plan = parseAskPlan(
      '{"kind":"total","category":"transport","query":null,"from":null,"to":null,"month":"2026-10"}',
    );
    expect(plan?.category).toBe("Transport");
    expect(plan?.month).toBe("2026-10");
  });

  it("rejects an unknown kind and an unknown category", () => {
    expect(
      parseAskPlan(
        '{"kind":"banana","category":null,"query":null,"from":null,"to":null,"month":null}',
      ),
    ).toBeNull();
    expect(
      parseAskPlan(
        '{"kind":"total","category":"Travel","query":null,"from":null,"to":null,"month":null}',
      ),
    ).toBeNull();
  });

  it("rejects malformed, impossible and backwards dates", () => {
    const base = { kind: "total", category: null, query: null, month: null };
    expect(
      parseAskPlan(
        JSON.stringify({ ...base, from: "26 Oct 2026", to: "2026-11-01" }),
      ),
    ).toBeNull();
    expect(
      parseAskPlan(
        JSON.stringify({ ...base, from: "2026-02-30", to: "2026-03-01" }),
      ),
    ).toBeNull();
    expect(
      parseAskPlan(
        JSON.stringify({ ...base, from: "2026-11-01", to: "2026-10-26" }),
      ),
    ).toBeNull();
    expect(
      parseAskPlan(JSON.stringify({ ...base, from: "2026-10-26", to: null })),
    ).toBeNull();
  });

  it("rejects a malformed month and non-JSON replies", () => {
    const base = {
      kind: "records",
      category: null,
      query: "x",
      from: null,
      to: null,
    };
    expect(
      parseAskPlan(JSON.stringify({ ...base, month: "2026-8" })),
    ).toBeNull();
    expect(
      parseAskPlan(JSON.stringify({ ...base, month: "2026-13" })),
    ).toBeNull();
    expect(parseAskPlan("The total is £19.65.")).toBeNull();
    expect(parseAskPlan("")).toBeNull();
  });
});

describe("planner-driven Ask", () => {
  it("plans and answers through OpenCode Go when only OPENCODE_API_KEY is set", async () => {
    const db: Database.Database = transportDb();
    // Go-shaped mock: the planner is the call whose system MESSAGE (the
    // first chat message) names the query planner.
    const goFetch = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: { role: string; content: string }[];
      };
      const system =
        body.messages.find((m) => m.role === "system")?.content ?? "";
      const isPlanner = system.includes("query planner");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content: isPlanner
                  ? WEEK_PLAN
                  : "Transport this week came to £19.65 across 2 transactions.",
              },
              finish_reason: "stop",
            },
          ],
        }),
      } as Response;
    }) as typeof fetch;
    const result = await answerAsk(db, {
      question: "Total transport expense this week",
      today: TODAY,
      env: { OPENCODE_API_KEY: "oc_sk_test_dummy" },
      fetchImpl: goFetch,
    });
    expect(result.ai).toBe(true);
    expect(result.figures).toMatchObject({ total: 19.65, count: 2 });
    expect(result.gateway).toMatchObject({
      attempted: true,
      ok: true,
      status: 200,
      provider: "opencode-go",
    });
    db.close();
  });

  it("totals a transport-this-week plan directly over the pulled set", async () => {
    const db: Database.Database = transportDb();
    const seen: FetchSeen = { systems: [] };
    const result = await answerAsk(db, {
      question: "Total transport expense this week",
      today: TODAY,
      env: { MUSE_API_KEY: "LLM_test" },
      fetchImpl: gatewayFetch(
        WEEK_PLAN,
        "Transport this week came to £19.65 across 2 transactions.",
        seen,
      ),
    });
    expect(result.ai).toBe(true);
    expect(result.answer).toBe(
      "Transport this week came to £19.65 across 2 transactions.",
    );
    expect(result.figures).toMatchObject({ total: 19.65, count: 2 });
    expect(result.gateway).toMatchObject({
      attempted: true,
      ok: true,
      status: 200,
    });
    // The planner ran first, with today's date in its prompt context.
    expect(seen.systems[0]).toContain("query planner");
    db.close();
  });

  it("drives a records plan to the matching merchant's rows", async () => {
    const db = mahavirDb();
    const plan = JSON.stringify({
      kind: "records",
      category: null,
      query: "Mahavir Sweet Mart",
      from: null,
      to: null,
      month: null,
    });
    const result = await answerAsk(db, {
      question: "When did we last pay Mahavir Sweet Mart?",
      today: TODAY,
      env: { MUSE_API_KEY: "LLM_test" },
      fetchImpl: gatewayFetch(
        plan,
        "You last paid Mahavir Sweet Mart on 3 Aug 2026 — £27.10.",
      ),
    });
    expect(result.ai).toBe(true);
    expect(result.figures).toMatchObject({
      total: 53.7,
      count: 2,
      latest: {
        merchant: "Mahavir Sweet Mart",
        date: "3 Aug 2026",
        amount: 27.1,
      },
    });
    db.close();
  });

  it("drives a latest plan's figures without record-search filtering", async () => {
    const db = mahavirDb();
    const plan = JSON.stringify({
      kind: "latest",
      category: null,
      query: "Mahavir Sweet Mart",
      from: null,
      to: null,
      month: null,
    });
    const result = await answerAsk(db, {
      question: "When did we last pay Mahavir Sweet Mart?",
      today: TODAY,
      env: { MUSE_API_KEY: "LLM_test" },
      fetchImpl: gatewayFetch(plan, "Latest: 3 Aug 2026."),
    });
    expect(result.figures.latest).toEqual({
      merchant: "Mahavir Sweet Mart",
      date: "3 Aug 2026",
      amount: 27.1,
    });
    expect(result.figures.total).toBe(53.7);
    db.close();
  });

  it("falls back to the deterministic plan when the planner reply is invalid", async () => {
    const db = transportDb();
    const badPlan = JSON.stringify({
      kind: "total",
      category: "Travel",
      query: null,
      from: "2026-10-26",
      to: "2026-11-01",
      month: null,
    });
    const result = await answerAsk(db, {
      question: "Total transport expense this week",
      today: TODAY,
      env: { MUSE_API_KEY: "LLM_test" },
      fetchImpl: gatewayFetch(badPlan, "Transport this week: £19.65."),
    });
    // The deterministic parser routed category+week to a direct total.
    expect(result.figures).toMatchObject({ total: 19.65, count: 2 });
    expect(result.answer).toBe("Transport this week: £19.65.");
    db.close();
  });

  it("falls back when the planner reply is not JSON at all", async () => {
    const db = transportDb();
    const result = await answerAsk(db, {
      question: "Total transport expense this week",
      today: TODAY,
      env: { MUSE_API_KEY: "LLM_test" },
      fetchImpl: gatewayFetch(
        "I cannot plan that.",
        "Transport this week: £19.65.",
      ),
    });
    expect(result.figures).toMatchObject({ total: 19.65, count: 2 });
    db.close();
  });
});

describe("deterministic relative periods", () => {
  it("totals transport for this week with no key configured", async () => {
    const db = transportDb();
    const result = await answerAsk(db, {
      question: "Total transport expense this week",
      today: TODAY,
      env: {},
    });
    expect(result.ai).toBe(false);
    expect(result.gateway).toEqual({
      attempted: false,
      ok: false,
      provider: null,
    });
    expect(result.figures).toMatchObject({ total: 19.65, count: 2 });
    expect(result.answer).toContain("Transport");
    expect(result.answer).toContain("£19.65");
    expect(result.answer).toContain("across 2 transactions");
    db.close();
  });

  it("keeps Mahavir-style records questions working with no key", async () => {
    const db = mahavirDb();
    const result = await answerAsk(db, {
      question: "When did we last pay Mahavir Sweet Mart?",
      today: TODAY,
      env: {},
    });
    expect(result.ai).toBe(false);
    expect(result.answer).toContain(
      "The latest matching record is Mahavir Sweet Mart, dated 3 Aug 2026 — £27.10.",
    );
    expect(result.figures.total).toBe(53.7);
    db.close();
  });
});

describe("Ask gateway diagnostics", () => {
  it("surfaces the gateway status and never leaks the key", async () => {
    const db = mahavirDb();
    const key = "LLM_ask_secret_key";
    const result = await answerAsk(db, {
      question: "When did we last pay Mahavir Sweet Mart?",
      today: TODAY,
      env: { MUSE_API_KEY: key },
      fetchImpl: (async () =>
        ({
          ok: false,
          status: 401,
          text: async () => "invalid api key",
          json: async () => ({}),
        }) as unknown as Response) as typeof fetch,
    });
    expect(result.ai).toBe(false);
    expect(result.answer).toContain(
      "Mahavir Sweet Mart, dated 3 Aug 2026 — £27.10",
    );
    expect(result.gateway).toMatchObject({
      attempted: true,
      ok: false,
      status: 401,
    });
    expect(result.gateway.error).toContain("invalid api key");
    expect(JSON.stringify(result)).not.toContain(key);
    db.close();
  });
});
