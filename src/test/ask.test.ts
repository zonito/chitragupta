import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { answerAsk } from "@/lib/ask.server";
import { openStore } from "@/lib/ingest/store";

/**
 * POST /api/ask's pipeline: code pulls and computes, the model only
 * writes prose. These tests pin the figures and the fallback contract:
 * no key or a gateway failure returns the deterministic answer with
 * ai: false, never an error.
 */

function seededDb() {
  const db = openStore(mkdtempSync(join(tmpdir(), "chitra-ask-")));
  const insert = db.prepare(
    `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
      description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
     VALUES (?, 'zonito', ?, ?, ?, ?, ?, ?, 0, 'GBP', 100000, 'spend', ?)`,
  );
  const rows: [string, string, string, string, string, number][] = [
    // fingerprint, account, date, merchant, category, amountMinor
    ["m1", "Pro", "2026-08-03", "Mahavir Sweet Mart", "Groceries", -2710],
    ["m2", "Pro", "2026-05-17", "Mahavir Sweet Mart", "Groceries", -2660],
    ["a1", "Main", "2026-08-12", "Air India", "Holidays", -51200],
    ["a2", "Main", "2026-08-20", "Air India", "Holidays", -8840],
    ["o1", "Main", "2026-10-05", "Ocado", "Groceries", -1000],
    ["o2", "Main", "2026-10-12", "Ocado", "Groceries", -2550],
    ["j1", "Joint", "2026-09-15", "Council Tax", "Home", -10000],
  ];
  for (const [fp, account, date, merchant, category, amount] of rows) {
    insert.run(fp, account, date, date.slice(0, 7), merchant, merchant, amount, category);
  }
  return db;
}

const proseFetch =
  (seen: { url?: string; init?: RequestInit | undefined }) =>
  async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.init = init;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [
          {
            type: "text",
            text: "You last paid Mahavir Sweet Mart on 3 Aug 2026 — £27.10.",
          },
        ],
      }),
    } as Response;
  };

describe("Ask server pipeline", () => {
  it("answers a records question deterministically with no key configured", async () => {
    const db: Database.Database = seededDb();
    const result = await answerAsk(db, {
      question: "When did we last pay Mahavir Sweet Mart?",
      env: {},
    });
    expect(result.ai).toBe(false);
    expect(result.answer).toContain(
      "The latest matching record is Mahavir Sweet Mart, dated 3 Aug 2026 — £27.10.",
    );
    expect(result.answer).toContain("Total across 2 matching transactions: £53.70.");
    expect(result.figures).toMatchObject({
      total: 53.7,
      count: 2,
      latest: { merchant: "Mahavir Sweet Mart", date: "3 Aug 2026", amount: 27.1 },
      month: null,
      truncated: false,
    });
    expect(result.figures.perMonth).toEqual([
      { month: "2026-05", total: 26.6, count: 1 },
      { month: "2026-08", total: 27.1, count: 1 },
    ]);
    db.close();
  });

  it("has the model write prose around the computed figures when a key exists", async () => {
    const db = seededDb();
    const seen: { url?: string; init?: RequestInit } = {};
    const result = await answerAsk(db, {
      question: "When did we last pay Mahavir Sweet Mart?",
      env: { MUSE_API_KEY: "LLM_test" },
      fetchImpl: proseFetch(seen) as typeof fetch,
    });
    expect(result.ai).toBe(true);
    expect(result.answer).toBe(
      "You last paid Mahavir Sweet Mart on 3 Aug 2026 — £27.10.",
    );
    expect(result.figures.total).toBe(53.7);
    expect(seen.url).toBe("https://api.meta.ai/v1/messages");
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer LLM_test");
    const body = JSON.parse(String(seen.init?.body)) as {
      model: string;
      system?: string;
      messages: { content: string }[];
    };
    expect(body.model).toBe("muse-spark-1.3-contributor");
    expect(body.system).toContain("Never invent");
    // The figures the model may use are computed by code and ride along.
    expect(body.messages[0]!.content).toContain("£53.70");
    expect(body.messages[0]!.content).toContain("Mahavir Sweet Mart");
    db.close();
  });

  it("falls back to the deterministic answer when the gateway fails", async () => {
    const db = seededDb();
    const result = await answerAsk(db, {
      question: "When did we last pay Mahavir Sweet Mart?",
      env: { MUSE_API_KEY: "LLM_test" },
      fetchImpl: (async () => {
        throw new Error("gateway down");
      }) as typeof fetch,
    });
    expect(result.ai).toBe(false);
    expect(result.answer).toContain("Mahavir Sweet Mart, dated 3 Aug 2026 — £27.10");
    db.close();
  });

  it("answers the India in August question with that month's total", async () => {
    const db = seededDb();
    const result = await answerAsk(db, {
      question: "What did we spend in India in August?",
      env: {},
    });
    expect(result.ai).toBe(false);
    expect(result.figures).toMatchObject({ total: 600.4, count: 2, month: "2026-08" });
    expect(result.answer).toContain("£600.40");
    db.close();
  });

  it("answers a month-only question with the whole month's spend", async () => {
    const db = seededDb();
    const result = await answerAsk(db, {
      question: "What did we spend in August?",
      env: {},
    });
    expect(result.ai).toBe(false);
    expect(result.answer).toBe("£627.50 spent in August 2026 across 3 transactions.");
    expect(result.figures).toMatchObject({ total: 627.5, count: 3, month: "2026-08" });
    db.close();
  });

  it("answers the Ocado worked example from the current month", async () => {
    const db = seededDb();
    const result = await answerAsk(db, {
      question: "How much on Ocado this month?",
      env: {},
    });
    expect(result.ai).toBe(false);
    expect(result.answer).toBe("Ocado this month: £35.50 across 2 orders.");
    expect(result.figures).toMatchObject({ total: 35.5, count: 2 });
    db.close();
  });

  it("scopes a joint bill to the person's share", async () => {
    const db = seededDb();
    const household = await answerAsk(db, {
      question: "When did we last pay Council Tax?",
      env: {},
    });
    expect(household.figures.latest?.amount).toBe(100);
    const zonito = await answerAsk(db, {
      question: "When did we last pay Council Tax?",
      person: "zonito",
      env: {},
    });
    expect(zonito.figures.latest?.amount).toBe(50);
    expect(zonito.figures.total).toBe(50);
    db.close();
  });

  it("says so when nothing matches", async () => {
    const db = seededDb();
    const result = await answerAsk(db, {
      question: "When did we last pay the plumber?",
      env: {},
    });
    expect(result.ai).toBe(false);
    expect(result.answer).toContain("No matching transactions or documents");
    expect(result.figures.count).toBe(0);
    db.close();
  });
});
