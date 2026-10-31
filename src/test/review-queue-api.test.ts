import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { openStore } from "@/lib/ingest/store";

const STORE_DIR = mkdtempSync(join(tmpdir(), "chitra-rq-api-"));
process.env["CHITRAGUPTA_STORE_DIR"] = STORE_DIR;

type Api = typeof import("@/lib/api");
let api: Api;

beforeAll(async () => {
  const db = openStore(STORE_DIR);
  const insert = db.prepare(
    `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
      description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
     VALUES (?, 'zonito', 'Main', '2026-10-05', '2026-10', ?, ?, -100, 0, 'GBP', 0, 'spend', NULL)`,
  );
  db.transaction(() => {
    for (let i = 0; i < 250; i++) {
      insert.run(`rq-${i}`, `Queue Merchant ${i}`, `Queue Merchant ${i}`);
    }
  })();
  db.close();
  api = await import("@/lib/api");
});

describe("GET /api/review-queue honesty", () => {
  it("returns the capped queue list alongside the TRUE total", async () => {
    const res = await api.handleChitraguptaApi(
      new Request("http://local/api/review-queue"),
    );
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as {
      ok: boolean;
      queue: unknown[];
      total: number;
    };
    expect(body.ok).toBe(true);
    expect(body.queue).toHaveLength(200);
    expect(body.total).toBe(250);
    expect(body.total).toBeGreaterThan(body.queue.length);
  });
});
