import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ingestAll } from "@/lib/ingest/ingest";
import { openStore } from "@/lib/ingest/store";
import { byCategory, hydrateData } from "@/lib/data";
import { buildCoachJevPayload, buildSubJevPayload } from "@/lib/jev.server";
import { SAMPLE_SNAPSHOT } from "./fixtures";

/**
 * Jev integration, server side. Jev's upstream is stubbed in every
 * test — the real service is NEVER called (it is intermittent by
 * design, and tests must not depend on it). The stub speaks the
 * verified contract: POST {tunnel}/v1/varuna/jev/ask with
 * {state, questions, model} → {ok, data:{answers}}.
 *
 * Seed facts (Zonito's Main account): Netflix £15 on the 5th of
 * Jun–Oct 2026 (a clean Monthly sub, 5 charges, £75 total), Ocado
 * £100 in Sep + £120 in Oct, three £7.50 Pret spends in Oct. Main
 * ends at £1,682.50; October spend £157.50. The other five accounts
 * exist so the ingest rebuild swaps (see seedStore) and end at round
 * balances: household Available is £2,082.50.
 */

const ENV_KEYS = ["CHITRAGUPTA_STORE_DIR", "CHITRAGUPTA_DATA_DIR"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  hydrateData(SAMPLE_SNAPSHOT);
});
afterEach(() => {
  vi.unstubAllGlobals();
  hydrateData(SAMPLE_SNAPSHOT);
});

const HEADER =
  "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n";
const ROWS = [
  "Card Payment,Current,2026-06-05 10:00:00,2026-06-05 10:00:01,Netflix,-15.00,0.00,GBP,COMPLETED,1985.00",
  "Card Payment,Current,2026-07-05 10:00:00,2026-07-05 10:00:01,Netflix,-15.00,0.00,GBP,COMPLETED,1970.00",
  "Card Payment,Current,2026-08-05 10:00:00,2026-08-05 10:00:01,Netflix,-15.00,0.00,GBP,COMPLETED,1955.00",
  "Card Payment,Current,2026-09-05 10:00:00,2026-09-05 10:00:01,Netflix,-15.00,0.00,GBP,COMPLETED,1940.00",
  "Card Payment,Current,2026-09-20 10:00:00,2026-09-20 10:00:01,Ocado,-100.00,0.00,GBP,COMPLETED,1840.00",
  "Card Payment,Current,2026-10-03 10:00:00,2026-10-03 10:00:01,Ocado,-120.00,0.00,GBP,COMPLETED,1720.00",
  "Card Payment,Current,2026-10-05 10:00:00,2026-10-05 10:00:01,Netflix,-15.00,0.00,GBP,COMPLETED,1705.00",
  "Card Payment,Current,2026-10-06 10:00:00,2026-10-06 10:00:01,Pret A Manger,-7.50,0.00,GBP,COMPLETED,1697.50",
  "Card Payment,Current,2026-10-07 10:00:00,2026-10-07 10:00:01,Pret A Manger,-7.50,0.00,GBP,COMPLETED,1690.00",
  "Card Payment,Current,2026-10-08 10:00:00,2026-10-08 10:00:01,Pret A Manger,-7.50,0.00,GBP,COMPLETED,1682.50",
];

function seedStore(): string {
  const dataDir = mkdtempSync(join(tmpdir(), "chitra-jev-data-"));
  const originals = join(dataDir, "Originals");
  mkdirSync(originals, { recursive: true });
  writeFileSync(
    join(originals, "account-statement_2022_f5660e.csv"),
    HEADER + ROWS.join("\n") + "\n",
  );
  // A rebuild only swaps into the live store when EVERY account
  // ingests cleanly, so the seed covers all of Zonito's accounts (the
  // settings-api fixture does the same). The extra accounts end at
  // round balances that the Available expectation below includes:
  // Pro £200, Joint £50, savings £100 + £50; USD-Invest is foreign and
  // never enters the GBP total.
  writeFileSync(
    join(originals, "account-statement_2022_01cac2.csv"),
    HEADER +
      "Transfer,Pro,2026-10-02 10:00:00,2026-10-02 10:00:01,Salary,200.00,0.00,GBP,COMPLETED,200.00\n",
  );
  writeFileSync(
    join(originals, "account-statement_2022_2151f7.csv"),
    HEADER +
      "Transfer,Invest,2026-10-02 10:00:00,2026-10-02 10:00:01,Deposit,85.00,0.00,USD,COMPLETED,85.00\n",
  );
  writeFileSync(
    join(originals, "account-statement_2022_bd9d00.csv"),
    HEADER +
      "Transfer,Joint,2026-10-02 10:00:00,2026-10-02 10:00:01,Housekeeping,50.00,0.00,GBP,COMPLETED,50.00\n",
  );
  writeFileSync(
    join(originals, "savings-9000000002.csv"),
    'Date,Description,Money Out,Money In,Balance\n"Oct 5, 2026",Deposit,,100.00,100.00\n',
  );
  writeFileSync(
    join(originals, "savings-9000000001.csv"),
    'Date,Description,Money Out,Money In,Balance\n"Oct 6, 2026",Deposit,,50.00,50.00\n',
  );
  const storeDir = mkdtempSync(join(tmpdir(), "chitra-jev-store-"));
  const db = openStore(storeDir);
  const results = ingestAll(db, dataDir);
  expect(results.every((r) => r.ok)).toBe(true);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  process.env["CHITRAGUPTA_STORE_DIR"] = storeDir;
  return storeDir;
}

async function freshApi() {
  vi.resetModules();
  return import("@/lib/api");
}

function request(
  api: Awaited<ReturnType<typeof freshApi>>,
  method: string,
  path: string,
  body?: unknown,
) {
  return api.handleChitraguptaApi(
    new Request(`http://local${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

interface CapturedCall {
  url: string;
  body: {
    state: Record<string, unknown>;
    questions: Record<string, { question: string; choices: string[] }>;
    model?: string;
  };
}

type JevMode = "ok" | "down" | "rogue";

function stubJev(mode: JevMode, captured: CapturedCall[]) {
  const stub = vi.fn(async (url: unknown, init?: { body?: string }) => {
    const u = String(url);
    if (!u.includes("/v1/varuna/jev/ask")) {
      throw new Error(`unexpected fetch in jev test: ${u}`);
    }
    const body = JSON.parse(init?.body ?? "{}") as CapturedCall["body"];
    captured.push({ url: u, body });
    if (mode === "down") {
      return new Response(JSON.stringify({ ok: false }), { status: 502 });
    }
    if (mode === "rogue") {
      // Answers that are not among the offered choices: off-contract.
      return new Response(
        JSON.stringify({
          ok: true,
          data: { answers: { posture: "Banana", lever: "Banana", value: "Banana" } },
        }),
        { status: 200 },
      );
    }
    const answers: Record<string, string> = {};
    for (const [key, q] of Object.entries(body.questions)) {
      answers[key] = q.choices[0]!;
    }
    return new Response(
      JSON.stringify({ ok: true, data: { answers, usage: {}, latency_ms: 5 } }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

describe("jev payload builders", () => {
  it("coach payload carries computed facts and the real lever choices", () => {
    const snap = {
      ...SAMPLE_SNAPSHOT,
      settings: {
        ...SAMPLE_SNAPSHOT.settings,
        categoryBudgets: { Groceries: 10000 }, // £100 vs £112.40 spent
      },
    };
    const payload = buildCoachJevPayload(snap, "household");
    expect(payload).not.toBeNull();
    const { state, questions } = payload!;
    // Household Available for the fixture is £10,306.75 (see
    // floors-budgets.test); Groceries is the fixture's biggest
    // category at £561.40, so a £100 budget is £461.40 over — pinned
    // as a literal and cross-checked against the data helper.
    expect(state["available_gbp"]).toBe(10306.75);
    expect(state["spent_this_month_gbp"]).toBeGreaterThan(0);
    const groceries = byCategory("household").find(
      (c) => c.category === "Groceries",
    );
    expect(groceries?.amount).toBe(561.4);
    expect(state["over_budget_categories"]).toEqual([
      { category: "Groceries", over_by_gbp: 461.4 },
    ]);
    // No floor / overall budget set: those facts are absent, not zero.
    expect("floor_gbp" in state).toBe(false);
    expect("overall_budget_gbp" in state).toBe(false);
    // Privacy: facts and names only — nothing account-shaped leaves.
    const stateJson = JSON.stringify(state);
    expect(stateJson).not.toMatch(/account|balance_minor|fingerprint/i);
    expect(questions["posture"]!.choices).toEqual([
      "Grow the buffer",
      "Hold steady",
      "Ease off",
    ]);
    expect(questions["lever"]!.choices).toContain("Groceries");
    expect(questions["lever"]!.choices).toContain("Review subscriptions");
  });

  it("subscription payload asks posture and value about the sub's own facts", () => {
    const payload = buildSubJevPayload({
      merchant: "Netflix",
      amount_gbp: 15,
      cadence: "Monthly",
      charges: 5,
      first_charge: "2026-06-05",
      last_charge: "2026-10-05",
      total_paid_gbp: 75,
      category: "Subscriptions",
      status: "Active",
    });
    expect(payload.state).toEqual({
      merchant: "Netflix",
      amount_gbp: 15,
      cadence: "Monthly",
      charges: 5,
      first_charge: "2026-06-05",
      last_charge: "2026-10-05",
      total_paid_gbp: 75,
      category: "Subscriptions",
      status: "Active",
    });
    expect(payload.questions["posture"]!.choices).toEqual([
      "Keep",
      "Watch",
      "Cancel candidate",
    ]);
    expect(payload.questions["value"]!.choices).toEqual([
      "Good value",
      "Unclear",
      "Poor value",
    ]);
  });
});

describe("jev coach endpoint", () => {
  it("sends the contract payload, returns answers, caches for the day, records the outcome", async () => {
    const storeDir = seedStore();
    const api = await freshApi();
    const captured: CapturedCall[] = [];
    const stub = stubJev("ok", captured);

    const first = (await (await request(api, "GET", "/api/jev/coach?person=household"))!.json()) as {
      ok: boolean;
      jev: { answers: Record<string, string>; cached: boolean } | null;
    };
    expect(first.ok).toBe(true);
    expect(first.jev?.answers["posture"]).toBe("Grow the buffer");
    expect(first.jev?.cached).toBe(false);
    expect(stub).toHaveBeenCalledTimes(1);

    // Contract shape, exactly one call, to Varuna's jev route.
    const call = captured[0]!;
    expect(call.url).toMatch(/\/v1\/varuna\/jev\/ask$/);
    expect(call.body.model).toBe("jev-latest");
    expect(Object.keys(call.body).sort()).toEqual(["model", "questions", "state"]);
    // £1,682.50 (Main) + £200 (Pro) + £50 (Joint) + £100 + £50 (savings).
    expect(call.body.state["available_gbp"]).toBe(2082.5);
    expect(call.body.state["spent_this_month_gbp"]).toBe(157.5);
    expect(call.body.state["small_spends_count"]).toBe(3);
    expect(call.body.state["small_spends_total_gbp"]).toBe(22.5);
    expect(call.body.questions["posture"]!.choices).toEqual([
      "Grow the buffer",
      "Hold steady",
      "Ease off",
    ]);

    // Same facts, same day: served from cache, no second live call.
    const second = (await (await request(api, "GET", "/api/jev/coach?person=household"))!.json()) as {
      jev: { answers: Record<string, string>; cached: boolean } | null;
    };
    expect(second.jev?.answers).toEqual(first.jev?.answers);
    expect(second.jev?.cached).toBe(true);
    expect(stub).toHaveBeenCalledTimes(1);

    // The live call recorded its outcome for the Settings status line.
    const settings = (await (await request(api, "GET", "/api/settings"))!.json()) as {
      settings: { jevEnabled: boolean; jevLastOutcome: { status: string } | null };
    };
    expect(settings.settings.jevEnabled).toBe(true);
    expect(settings.settings.jevLastOutcome?.status).toBe("ok");
    rmSync(storeDir, { recursive: true, force: true });
  });

  it("serves the stale cached answer when Jev goes down, and records unavailable", async () => {
    const storeDir = seedStore();
    const api = await freshApi();
    const captured: CapturedCall[] = [];
    stubJev("ok", captured);
    const first = (await (await request(api, "GET", "/api/jev/coach?person=household"))!.json()) as {
      jev: { answers: Record<string, string> } | null;
    };
    expect(first.jev).not.toBeNull();

    // Age the cache entry beyond today, then take Jev down.
    const db = openStore(storeDir);
    db.prepare("UPDATE jev_cache SET fetched_at = '2020-01-01T00:00:00.000Z'").run();
    db.close();
    stubJev("down", captured);

    const res = (await (await request(api, "GET", "/api/jev/coach?person=household"))!.json()) as {
      jev: { answers: Record<string, string>; cached: boolean; at: string } | null;
    };
    expect(res.jev?.answers).toEqual(first.jev?.answers);
    expect(res.jev?.cached).toBe(true);
    expect(res.jev?.at).toBe("2020-01-01T00:00:00.000Z");

    const settings = (await (await request(api, "GET", "/api/settings"))!.json()) as {
      settings: { jevLastOutcome: { status: string } | null };
    };
    expect(settings.settings.jevLastOutcome?.status).toBe("unavailable");
    rmSync(storeDir, { recursive: true, force: true });
  });

  it("renders nothing when Jev is down with no cache, and rejects off-contract answers", async () => {
    const storeDir = seedStore();
    const api = await freshApi();
    const captured: CapturedCall[] = [];
    stubJev("down", captured);
    const down = (await (await request(api, "GET", "/api/jev/coach?person=household"))!.json()) as {
      ok: boolean;
      jev: unknown;
    };
    expect(down.ok).toBe(true);
    expect(down.jev).toBeNull();

    stubJev("rogue", captured);
    const rogue = (await (await request(api, "GET", "/api/jev/coach?person=household"))!.json()) as {
      jev: unknown;
    };
    expect(rogue.jev).toBeNull();
    rmSync(storeDir, { recursive: true, force: true });
  });

  it("toggle off means no call and no opinion; the setting round-trips", async () => {
    const storeDir = seedStore();
    const api = await freshApi();
    const captured: CapturedCall[] = [];
    const stub = stubJev("ok", captured);

    const bad = await request(api, "PUT", "/api/settings", { jevEnabled: "yes" });
    expect(bad?.status).toBe(400);

    const off = (await (await request(api, "PUT", "/api/settings", { jevEnabled: false }))!.json()) as {
      settings: { jevEnabled: boolean };
    };
    expect(off.settings.jevEnabled).toBe(false);

    const res = (await (await request(api, "GET", "/api/jev/coach?person=household"))!.json()) as {
      jev: unknown;
    };
    expect(res.jev).toBeNull();
    expect(stub).not.toHaveBeenCalled();

    const on = (await (await request(api, "PUT", "/api/settings", { jevEnabled: true }))!.json()) as {
      settings: { jevEnabled: boolean };
    };
    expect(on.settings.jevEnabled).toBe(true);
    rmSync(storeDir, { recursive: true, force: true });
  });
});

describe("jev subscription endpoint", () => {
  it("asks about the sub's own facts, caches per merchant, and fails quietly", async () => {
    const storeDir = seedStore();
    const api = await freshApi();
    const captured: CapturedCall[] = [];
    const stub = stubJev("ok", captured);

    // Nothing cached before the first ask.
    const empty = (await (await request(api, "GET", "/api/jev/subscription?merchant=Netflix"))!.json()) as {
      jev: unknown;
    };
    expect(empty.jev).toBeNull();
    expect(stub).not.toHaveBeenCalled();

    const asked = (await (await request(api, "POST", "/api/jev/subscription", { merchant: "Netflix" }))!.json()) as {
      ok: boolean;
      jev: { answers: Record<string, string> } | null;
    };
    expect(asked.ok).toBe(true);
    expect(asked.jev?.answers).toEqual({ posture: "Keep", value: "Good value" });
    expect(stub).toHaveBeenCalledTimes(1);

    // The state Jev was offered: the sub's computed facts, nothing else.
    expect(captured[0]!.body.state).toEqual({
      merchant: "Netflix",
      amount_gbp: 15,
      cadence: "Monthly",
      charges: 5,
      first_charge: "2026-06-05",
      last_charge: "2026-10-05",
      total_paid_gbp: 75,
      category: "Subscriptions",
      status: "Active",
    });

    // The cached read renders the same opinion without a new call.
    const cached = (await (await request(api, "GET", "/api/jev/subscription?merchant=Netflix"))!.json()) as {
      jev: { answers: Record<string, string> } | null;
    };
    expect(cached.jev?.answers).toEqual({ posture: "Keep", value: "Good value" });
    expect(stub).toHaveBeenCalledTimes(1);

    // A fresh ask while Jev is down: 502 + the unavailable marker,
    // and the earlier opinion stays cached.
    stubJev("down", captured);
    const downRes = await request(api, "POST", "/api/jev/subscription", { merchant: "Netflix" });
    expect(downRes?.status).toBe(502);
    expect(((await downRes!.json()) as { jev?: string }).jev).toBe("unavailable");
    const stillThere = (await (await request(api, "GET", "/api/jev/subscription?merchant=Netflix"))!.json()) as {
      jev: { answers: Record<string, string> } | null;
    };
    expect(stillThere.jev?.answers).toEqual({ posture: "Keep", value: "Good value" });

    // Unknown merchant is a plain 404, not a Jev call.
    const missing = await request(api, "POST", "/api/jev/subscription", { merchant: "Nope" });
    expect(missing?.status).toBe(404);
    rmSync(storeDir, { recursive: true, force: true });
  });
});
