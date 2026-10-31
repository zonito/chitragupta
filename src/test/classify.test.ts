import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyUnknownMerchants,
  claudeConfig,
} from "@/lib/ingest/classify";
import { reviewQueue, reviewQueueCount } from "@/lib/ingest/merchants";
import { openStore } from "@/lib/ingest/store";

function seededDb() {
  const db = openStore(mkdtempSync(join(tmpdir(), "chitra-classify-")));
  db.prepare(
    `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
      description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
     VALUES ('x1', 'zonito', 'Main', '2026-10-05', '2026-10', 'Mystery Shop', 'Mystery Shop',
      -2500, 0, 'GBP', 100000, 'spend', NULL)`,
  ).run();
  return db;
}

const TEST_KEY = ["test", "key"].join("-");

const okFetch =
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
            text: '{"category":"Shopping","icon":"shopping-bag","colour":"#3b82f6"}',
          },
        ],
      }),
    } as Response;
  };

describe("Muse classification client (Fix 5)", () => {
  it("is a strict no-op when MUSE_API_KEY is absent", async () => {
    const db = seededDb();
    const summary = await classifyUnknownMerchants(db, { env: {} });
    expect(summary.ran).toBe(false);
    expect(summary.classified).toBe(0);
    expect(reviewQueue(db)).toHaveLength(1);
    db.close();
  });

  it("classifies a queued merchant and remembers it as claude-api", async () => {
    const db = seededDb();
    const seen: { url?: string; init?: RequestInit | undefined } = {};
    const summary = await classifyUnknownMerchants(db, {
      env: { MUSE_API_KEY: TEST_KEY },
      fetchImpl: okFetch(seen) as typeof fetch,
    });
    expect(summary).toMatchObject({ ran: true, classified: 1, failed: 0, remaining: 0 });
    expect(seen.url).toBe("https://api.meta.ai/v1/messages");
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe(`Bearer ${TEST_KEY}`);
    expect(headers["x-api-key"]).toBeUndefined();
    const body = JSON.parse(String(seen.init?.body)) as {
      model: string;
      messages: { content: string }[];
    };
    expect(body.model).toBe("muse-spark-1.3-contributor");
    const prompt = body.messages[0]!.content;
    expect(prompt).toContain("Mystery Shop");
    // Privacy contract: no amounts, balances or account identifiers.
    expect(prompt).not.toMatch(/2500|100000|balance|account/i);
    const memory = db
      .prepare(
        "SELECT category, colour, icon, source FROM merchant_memory WHERE merchant = 'Mystery Shop'",
      )
      .get() as { category: string; colour: string; icon: string; source: string };
    expect(memory).toEqual({
      category: "Shopping",
      colour: "#3b82f6",
      icon: "shopping-bag",
      source: "claude-api",
    });
    expect(reviewQueue(db)).toHaveLength(0);
    db.close();
  });

  it("keeps the merchant queued when the call fails", async () => {
    const db = seededDb();
    const summary = await classifyUnknownMerchants(db, {
      env: { MUSE_API_KEY: TEST_KEY },
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as typeof fetch,
    });
    expect(summary).toMatchObject({ ran: true, classified: 0, failed: 1, remaining: 1 });
    expect(reviewQueue(db)).toHaveLength(1);
    db.close();
  });

  it("classifies through OpenCode Go when only OPENCODE_API_KEY is set", async () => {
    const db = seededDb();
    const seen: { url?: string; init?: RequestInit | undefined } = {};
    const goOkFetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      seen.url = String(url);
      seen.init = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content:
                  '{"category":"Shopping","icon":"shopping-bag","colour":"#3b82f6"}',
              },
              finish_reason: "stop",
            },
          ],
        }),
      } as Response;
    }) as typeof fetch;
    const summary = await classifyUnknownMerchants(db, {
      env: { OPENCODE_API_KEY: "oc_sk_test_dummy" },
      fetchImpl: goOkFetch,
    });
    expect(summary).toMatchObject({ ran: true, classified: 1, failed: 0 });
    expect(summary.gateway).toMatchObject({
      attempted: true,
      ok: true,
      provider: "opencode-go",
    });
    expect(seen.url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers["x-opencode-session"]).toBe("chitragupta");
    // Classification asks for ~200 tokens; the Go route floors it to 4000.
    const body = JSON.parse(String(seen.init?.body)) as { max_tokens: number };
    expect(body.max_tokens).toBe(4000);
    expect(reviewQueue(db)).toHaveLength(0);
    db.close();
  });

  it("reports no gateway attempt when no key is configured", async () => {
    const db = seededDb();
    const summary = await classifyUnknownMerchants(db, { env: {} });
    expect(summary.gateway).toEqual({ attempted: false, ok: false, provider: null });
    db.close();
  });

  it("surfaces the first gateway failure's status in the summary, never the key", async () => {
    const db = seededDb();
    const key = "LLM_classify_secret";
    const summary = await classifyUnknownMerchants(db, {
      env: { MUSE_API_KEY: key },
      fetchImpl: (async () =>
        ({
          ok: false,
          status: 401,
          text: async () => "unauthorised",
          json: async () => ({}),
        }) as unknown as Response) as typeof fetch,
    });
    expect(summary).toMatchObject({
      ran: true,
      classified: 0,
      failed: 1,
      remaining: 1,
    });
    expect(summary.gateway).toMatchObject({
      attempted: true,
      ok: false,
      status: 401,
    });
    expect(summary.gateway.error).toContain("unauthorised");
    expect(JSON.stringify(summary)).not.toContain(key);
    db.close();
  });

  it("honours a gateway base URL override", async () => {
    const config = claudeConfig({
      MUSE_API_KEY: "LLM_example",
      MUSE_API_BASE_URL: "https://gateway.example.com/",
    });
    expect(config?.baseUrl).toBe("https://gateway.example.com");
    expect(config?.model).toBe("muse-spark-1.3-contributor");
    expect(claudeConfig({})).toBeNull();
  });

  it("retries once at a larger budget when reasoning eats the whole budget (finish_reason: length)", async () => {
    const db = seededDb();
    let calls = 0;
    const budgets: number[] = [];
    const fetchImpl = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls++;
      budgets.push(
        (JSON.parse(String(init?.body)) as { max_tokens: number }).max_tokens,
      );
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: { role: "assistant", content: null },
                finish_reason: "length",
              },
            ],
          }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content:
                  '{"category":"Shopping","icon":"shopping-bag","colour":"#3b82f6"}',
              },
              finish_reason: "stop",
            },
          ],
        }),
      } as Response;
    }) as typeof fetch;
    const summary = await classifyUnknownMerchants(db, {
      env: { OPENCODE_API_KEY: "oc_sk_test_dummy" },
      fetchImpl,
    });
    // Exactly one retry, the second call at the larger 8000 budget
    // (the first is the Go floor: the ~200 request floored to 4000).
    expect(calls).toBe(2);
    expect(budgets).toEqual([4000, 8000]);
    // A successful retry counts as classified, not failed.
    expect(summary).toMatchObject({
      ran: true,
      classified: 1,
      failed: 0,
      remaining: 0,
    });
    expect(summary.gateway).toMatchObject({ attempted: true, ok: true });
    expect(reviewQueue(db)).toHaveLength(0);
    db.close();
  });

  it("does not retry a non-length failure (402): exactly one call, merchant counted failed", async () => {
    const db = seededDb();
    let calls = 0;
    const summary = await classifyUnknownMerchants(db, {
      env: { MUSE_API_KEY: TEST_KEY },
      fetchImpl: (async () => {
        calls++;
        return {
          ok: false,
          status: 402,
          text: async () => "billing verification failed",
          json: async () => ({}),
        } as unknown as Response;
      }) as typeof fetch,
    });
    expect(calls).toBe(1);
    expect(summary).toMatchObject({
      ran: true,
      classified: 0,
      failed: 1,
      remaining: 1,
    });
    expect(summary.gateway).toMatchObject({ ok: false, status: 402 });
    expect(reviewQueue(db)).toHaveLength(1);
    db.close();
  });

  it("reports the TRUE remaining count, never capped at the queue's 200", async () => {
    const db = openStore(mkdtempSync(join(tmpdir(), "chitra-classify-bulk-")));
    const insert = db.prepare(
      `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
        description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
       VALUES (?, 'zonito', 'Main', '2026-10-05', '2026-10', ?, ?, -100, 0, 'GBP', 100000, 'spend', NULL)`,
    );
    db.transaction(() => {
      for (let i = 0; i < 250; i++) {
        insert.run(`bulk-${i}`, `Unknown Merchant ${i}`, `Unknown Merchant ${i}`);
      }
    })();
    expect(reviewQueue(db)).toHaveLength(200);
    expect(reviewQueueCount(db)).toBe(250);
    // No-key path: remaining is the true count, not the capped 200.
    const idle = await classifyUnknownMerchants(db, { env: {} });
    expect(idle).toMatchObject({ ran: false, classified: 0, remaining: 250 });
    // A mocked run classifying 10 drops remaining by exactly 10, and
    // the result (240) is still truthfully above the 200 cap.
    const seen: { url?: string; init?: RequestInit | undefined } = {};
    const ran = await classifyUnknownMerchants(db, {
      env: { MUSE_API_KEY: TEST_KEY },
      fetchImpl: okFetch(seen) as typeof fetch,
      limit: 10,
    });
    expect(ran).toMatchObject({ ran: true, classified: 10, failed: 0, remaining: 240 });
    expect(reviewQueueCount(db)).toBe(240);
    db.close();
  });

  it("defaults to the Meta gateway and the contributor model", async () => {
    const config = claudeConfig({ MUSE_API_KEY: "LLM_example" });
    expect(config?.baseUrl).toBe("https://api.meta.ai");
    expect(config?.model).toBe("muse-spark-1.3-contributor");
    const custom = claudeConfig({
      MUSE_API_KEY: "LLM_example",
      MUSE_MODEL: "muse-spark-1.2-contributor",
    });
    expect(custom?.model).toBe("muse-spark-1.2-contributor");
  });
});
