import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createCategory, listCategories } from "@/lib/ingest/categories";
import { classifyUnknownMerchants } from "@/lib/ingest/classify";
import { ingestAll, recomputeAggregates } from "@/lib/ingest/ingest";
import { seedMerchantMemory, setMerchant } from "@/lib/ingest/merchants";
import { openStore, RULES_VERSION } from "@/lib/ingest/store";
import { buildSnapshot } from "@/lib/snapshot.server";
import {
  byCategory,
  categoryColor,
  categoryNames,
  hydrateData,
} from "@/lib/data";
import { SAMPLE_SNAPSHOT } from "./fixtures";

/**
 * Phase 2 acceptance: custom categories + single-lane classification.
 * - The categories API validates (duplicates, built-ins and system
 *   movement labels can never be created; used customs can't be
 *   deleted; unused ones can).
 * - Zonito's example, on the repro fixture: create "Tuition", correct
 *   Penny Caulfield into it through POST /api/merchants — all 13 rows
 *   re-file, October Tuition is £148.00 and School is back to £69.99.
 * - The classifier learns customs: the prompt names the custom
 *   category with its user-corrected example merchants, and a mocked
 *   gateway answer of "Tuition" is accepted and stored.
 * - POST /api/ingest/run includes the classify summary when a gateway
 *   is configured (a local stub stands in for the gateway).
 */

const DATA_DIR = process.env["CHITRAGUPTA_DATA_DIR"]?.trim() || null;
const describeRepro = DATA_DIR ? describe : describe.skip;

const ENV_KEYS = [
  "CHITRAGUPTA_STORE_DIR",
  "CHITRAGUPTA_DATA_DIR",
  "MUSE_API_KEY",
  "MUSE_API_BASE_URL",
  "OPENCODE_API_KEY",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** A fresh api module bound to the given store dir (the module caches
 * its DB connection, so each binding needs a registry reset). */
async function freshApi(storeDir: string) {
  vi.resetModules();
  process.env["CHITRAGUPTA_STORE_DIR"] = storeDir;
  return import("@/lib/api");
}

function postJson(api: Awaited<ReturnType<typeof freshApi>>, path: string, body: unknown, method = "POST") {
  return api.handleChitraguptaApi(
    new Request(`http://local${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("categories API (scratch store)", () => {
  it("seeds the 9 built-ins and validates create/delete", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chitra-cats-"));
    const api = await freshApi(dir);

    const list = await api.handleChitraguptaApi(
      new Request("http://local/api/categories"),
    );
    const listBody = (await list!.json()) as {
      ok: boolean;
      categories: { name: string; builtin: boolean }[];
    };
    expect(listBody.ok).toBe(true);
    expect(listBody.categories.map((c) => c.name)).toEqual([
      "Groceries",
      "Eating out",
      "Transport",
      "School",
      "Home",
      "Subscriptions",
      "Holidays",
      "Shopping",
      "One-off",
    ]);
    expect(listBody.categories.every((c) => c.builtin)).toBe(true);

    // Create with defaults: palette colour + tag icon.
    const created = await postJson(api, "/api/categories", { name: "Tuition" });
    expect(created?.status).toBe(200);
    const createdBody = (await created!.json()) as {
      ok: boolean;
      category: { name: string; colour: string; icon: string; builtin: boolean };
    };
    expect(createdBody.category).toMatchObject({
      name: "Tuition",
      icon: "tag",
      builtin: false,
    });
    expect(createdBody.category.colour).toMatch(/^oklch\(/);

    // Duplicates (any case), built-ins and system labels are refused.
    for (const name of ["tuition", "TUITION", "School", "Transfer", "Fees", "Moved aside", "Interest"]) {
      const res = await postJson(api, "/api/categories", { name });
      expect(res?.status, name).toBe(400);
      const body = (await res!.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error.length).toBeGreaterThan(0);
    }
    // Shape validation: empty and over-long names.
    for (const name of ["", "   ", "x".repeat(41)]) {
      const res = await postJson(api, "/api/categories", { name });
      expect(res?.status, JSON.stringify(name)).toBe(400);
    }

    // An unused custom can be deleted; a built-in cannot.
    const spare = await postJson(api, "/api/categories", { name: "Spare" });
    expect(spare?.status).toBe(200);
    const del = await postJson(api, "/api/categories", { name: "Spare" }, "DELETE");
    expect(del?.status).toBe(200);
    const after = await api.handleChitraguptaApi(
      new Request("http://local/api/categories"),
    );
    const afterBody = (await after!.json()) as {
      categories: { name: string }[];
    };
    expect(afterBody.categories.map((c) => c.name)).not.toContain("Spare");
    expect(afterBody.categories.map((c) => c.name)).toContain("Tuition");

    const delBuiltin = await postJson(api, "/api/categories", { name: "School" }, "DELETE");
    expect(delBuiltin?.status).toBe(400);
    const delMissing = await postJson(api, "/api/categories", { name: "Nope" }, "DELETE");
    expect(delMissing?.status).toBe(400);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses to delete a category a merchant still uses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chitra-cats-used-"));
    const db = openStore(dir);
    expect(createCategory(db, { name: "Tuition" }).ok).toBe(true);
    setMerchant(db, "Penny Caulfield", "Tuition", { source: "user" });
    db.close();
    const api = await freshApi(dir);
    const res = await postJson(api, "/api/categories", { name: "Tuition" }, "DELETE");
    expect(res?.status).toBe(400);
    const body = (await res!.json()) as { ok: boolean; error: string };
    expect(body.error).toMatch(/still used/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("classifier learns custom categories", () => {
  function seededDb() {
    const db = openStore(mkdtempSync(join(tmpdir(), "chitra-classify-custom-")));
    db.prepare(
      `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
        description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
       VALUES ('y1', 'zonito', 'Main', '2026-10-05', '2026-10', 'New Piano Teacher', 'New Piano Teacher',
        -6000, 0, 'GBP', 100000, 'spend', NULL)`,
    ).run();
    expect(createCategory(db, { name: "Tuition" }).ok).toBe(true);
    setMerchant(db, "Penny Caulfield", "Tuition", { source: "user" });
    return db;
  }

  const metaFetch =
    (reply: string, seen: { prompt?: string }) =>
    async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: { content: string }[];
      };
      seen.prompt = body.messages[0]!.content;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: "text", text: reply }],
        }),
      } as Response;
    };

  it("prompts with the custom category and its examples, and accepts a Tuition answer", async () => {
    const db = seededDb();
    const seen: { prompt?: string } = {};
    const summary = await classifyUnknownMerchants(db, {
      env: { MUSE_API_KEY: "test-key" },
      fetchImpl: metaFetch(
        '{"category":"Tuition","icon":"graduation-cap","colour":"#7c3aed"}',
        seen,
      ) as typeof fetch,
    });
    expect(seen.prompt).toContain("Tuition");
    expect(seen.prompt).toContain("Penny Caulfield");
    // The allowed list in the reply instruction carries the custom too.
    expect(seen.prompt).toContain('"Tuition"');
    expect(summary).toMatchObject({ ran: true, classified: 1, failed: 0 });
    const memory = db
      .prepare(
        "SELECT category, source FROM merchant_memory WHERE merchant = 'New Piano Teacher'",
      )
      .get() as { category: string; source: string };
    expect(memory).toEqual({ category: "Tuition", source: "claude-api" });
    db.close();
  });

  it("still rejects a category outside the allowed list", async () => {
    const db = seededDb();
    const seen: { prompt?: string } = {};
    const summary = await classifyUnknownMerchants(db, {
      env: { MUSE_API_KEY: "test-key" },
      fetchImpl: metaFetch('{"category":"Banana"}', seen) as typeof fetch,
    });
    expect(summary).toMatchObject({ ran: true, classified: 0, failed: 1 });
    const memory = db
      .prepare(
        "SELECT COUNT(*) AS n FROM merchant_memory WHERE merchant = 'New Piano Teacher'",
      )
      .get() as { n: number };
    expect(memory.n).toBe(0);
    db.close();
  });
});

describe("ingest-run classifies behind ingest when a gateway is configured", () => {
  it("includes the classify summary and stores the stub's Tuition verdict", async () => {
    // A stub gateway (Meta-shaped) on an ephemeral local port.
    const stub = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            content: [
              {
                type: "text",
                text: '{"category":"Tuition","icon":"graduation-cap","colour":"#7c3aed"}',
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const address = stub.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const dataDir = mkdtempSync(join(tmpdir(), "chitra-ingest-run-data-"));
    const originals = join(dataDir, "Originals");
    mkdirSync(originals, { recursive: true });
    writeFileSync(
      join(originals, "account-statement_2022_f5660e.csv"),
      "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n" +
        "Card Payment,Current,2026-10-03 10:00:00,2026-10-03 10:00:01,Mystery Piano Teacher,-60.00,0.00,GBP,COMPLETED,940.00\n",
    );
    const storeDir = mkdtempSync(join(tmpdir(), "chitra-ingest-run-store-"));
    const seed = openStore(storeDir);
    // Stamp the current rules version: a store that has already
    // ingested under the current rules takes the direct ingest path.
    // (A fresh store would route through the atomic rebuild, which is
    // all-or-nothing and would veto the swap over the five zonito
    // accounts this tiny fixture deliberately omits.)
    seed
      .prepare(
        `INSERT INTO meta (key, value) VALUES ('rules_version', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(String(RULES_VERSION));
    expect(createCategory(seed, { name: "Tuition" }).ok).toBe(true);
    seed.close();

    process.env["CHITRAGUPTA_DATA_DIR"] = dataDir;
    process.env["MUSE_API_KEY"] = "test-key";
    process.env["MUSE_API_BASE_URL"] = `http://127.0.0.1:${port}`;
    delete process.env["OPENCODE_API_KEY"];
    try {
      const api = await freshApi(storeDir);
      const res = await api.handleChitraguptaApi(
        new Request("http://local/api/ingest/run", { method: "POST" }),
      );
      const body = (await res!.json()) as {
        ok: boolean;
        classification: { ran: boolean; classified: number; failed: number } | null;
      };
      expect(body.classification).not.toBeNull();
      expect(body.classification!.ran).toBe(true);
      expect(body.classification!.classified).toBe(1);
      expect(body.classification!.failed).toBe(0);
      const check = openStore(storeDir);
      const memory = check
        .prepare(
          "SELECT category, source FROM merchant_memory WHERE merchant = 'Mystery Piano Teacher'",
        )
        .get() as { category: string; source: string };
      expect(memory).toEqual({ category: "Tuition", source: "claude-api" });
      check.close();
    } finally {
      stub.close();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(storeDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describeRepro("Penny Caulfield → Tuition (repro fixture)", () => {
  it("re-files all 13 rows under Tuition; October Tuition £148.00, School back to £69.99", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chitra-tuition-"));
    const seed = openStore(dir);
    ingestAll(seed, DATA_DIR!);
    seedMerchantMemory(seed);
    recomputeAggregates(seed, "zonito");
    seed.close();

    const api = await freshApi(dir);
    const created = await postJson(api, "/api/categories", { name: "Tuition" });
    expect(created?.status).toBe(200);

    const post = await postJson(api, "/api/merchants", {
      merchant: "Penny Caulfield",
      category: "Tuition",
      source: "user",
    });
    expect(post?.status).toBe(200);
    expect(await post!.json()).toMatchObject({ ok: true });

    const check = openStore(dir);
    const rows = check
      .prepare(
        "SELECT movement, category FROM transactions WHERE merchant = 'Penny Caulfield'",
      )
      .all() as { movement: string; category: string | null }[];
    expect(rows).toHaveLength(13);
    expect(rows.every((r) => r.category === "Tuition")).toBe(true);
    expect(rows.every((r) => r.movement === "spend")).toBe(true);

    const agg = (category: string) =>
      (
        check
          .prepare(
            `SELECT COALESCE(SUM(spend_minor), 0) AS s FROM month_aggregates
             WHERE person = 'zonito' AND year_month = '2026-10' AND currency = 'GBP' AND category = ?`,
          )
          .get(category) as { s: number }
      ).s;
    expect(agg("Tuition")).toBe(14800);
    expect(agg("School")).toBe(6999);
    check.close();

    // The snapshot carries Tuition, and the client helpers resolve it.
    process.env["CHITRAGUPTA_STORE_DIR"] = dir;
    const snapshot = buildSnapshot();
    expect(snapshot.categories.map((c) => c.name)).toContain("Tuition");
    try {
      hydrateData(snapshot);
      expect(categoryNames()).toContain("Tuition");
      const tuitionDef = snapshot.categories.find((c) => c.name === "Tuition")!;
      expect(categoryColor("Tuition")).toBe(tuitionDef.colour);
      const october = byCategory("household").find((c) => (c.category as string) === "Tuition");
      expect(october?.amount).toBe(148);
    } finally {
      hydrateData(SAMPLE_SNAPSHOT);
    }
    rmSync(dir, { recursive: true, force: true });
  }, 180_000);
});

// The store-level list always carries the built-ins in canonical order.
describe("categories module", () => {
  it("listCategories seeds built-ins first, customs after", () => {
    const db = openStore(mkdtempSync(join(tmpdir(), "chitra-cats-list-")));
    expect(createCategory(db, { name: "Tuition" }).ok).toBe(true);
    const names = listCategories(db).map((c) => c.name);
    expect(names.slice(0, 9)).toEqual([
      "Groceries",
      "Eating out",
      "Transport",
      "School",
      "Home",
      "Subscriptions",
      "Holidays",
      "Shopping",
      "One-off",
    ]);
    expect(names[9]).toBe("Tuition");
    db.close();
  });
});
