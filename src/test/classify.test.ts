import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyUnknownMerchants,
  claudeConfig,
} from "@/lib/ingest/classify";
import { reviewQueue } from "@/lib/ingest/merchants";
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
    const seen: { url?: string; init?: RequestInit } = {};
    const summary = await classifyUnknownMerchants(db, {
      env: { MUSE_API_KEY: TEST_KEY },
      fetchImpl: okFetch(seen) as typeof fetch,
    });
    expect(summary).toMatchObject({ ran: true, classified: 1, failed: 0, remaining: 0 });
    expect(seen.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(TEST_KEY);
    const body = JSON.parse(String(seen.init?.body)) as {
      messages: { content: string }[];
    };
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

  it("honours a gateway base URL override", async () => {
    const config = claudeConfig({
      MUSE_API_KEY: "LLM_example",
      MUSE_API_BASE_URL: "https://gateway.example.com/",
    });
    expect(config?.baseUrl).toBe("https://gateway.example.com");
    expect(claudeConfig({})).toBeNull();
  });
});
