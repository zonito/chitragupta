import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ingestAll } from "@/lib/ingest/ingest";
import { getSettings, updateSettings } from "@/lib/ingest/settings";
import { openStore } from "@/lib/ingest/store";
import { buildSnapshot } from "@/lib/snapshot.server";
import { appSettings, hydrateData } from "@/lib/data";
import { SAMPLE_SNAPSHOT } from "./fixtures";

/**
 * Floors & budgets, server side:
 * - GET /api/settings defaults to everything unset (no floor, no
 *   budgets); PUT applies partial updates, an explicit null clears,
 *   zero is a real value, and negative / fractional / non-numeric
 *   amounts are rejected with nothing written.
 * - Category budget entries naming a non-category are ignored while
 *   the valid entries apply.
 * - The settings table sits outside the ingest swap set: values set
 *   before a full rules-version rebuild are still there after it.
 * - The snapshot carries the settings, and appSettings() reads them.
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

/** A fresh api module bound to the given store dir (the module caches
 * its DB connection, so each binding needs a registry reset). */
async function freshApi(storeDir: string) {
  vi.resetModules();
  process.env["CHITRAGUPTA_STORE_DIR"] = storeDir;
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

type SettingsBody = {
  ok: boolean;
  error?: string;
  settings: {
    availableFloorMinor: number | null;
    overallMonthlyBudgetMinor: number | null;
    categoryBudgets: Record<string, number>;
    jevEnabled: boolean;
    jevLastOutcome: { status: "ok" | "unavailable"; at: string } | null;
  };
};

const UNSET = {
  availableFloorMinor: null,
  overallMonthlyBudgetMinor: null,
  categoryBudgets: {},
  jevEnabled: true,
  jevLastOutcome: null,
};

describe("settings API (scratch store)", () => {
  it("defaults to unset, then round-trips set / partial / clear", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chitra-settings-"));
    const api = await freshApi(dir);

    const initial = (await (await request(api, "GET", "/api/settings"))!.json()) as SettingsBody;
    expect(initial.ok).toBe(true);
    expect(initial.settings).toEqual(UNSET);

    const set = (await (await request(api, "PUT", "/api/settings", {
      availableFloorMinor: 1000000,
      overallMonthlyBudgetMinor: 600000,
      categoryBudgets: { Groceries: 50000, Transport: 20000 },
    }))!.json()) as SettingsBody;
    expect(set.ok).toBe(true);
    expect(set.settings).toEqual({
      availableFloorMinor: 1000000,
      overallMonthlyBudgetMinor: 600000,
      categoryBudgets: { Groceries: 50000, Transport: 20000 },
      jevEnabled: true,
      jevLastOutcome: null,
    });

    // Partial: only the floor moves; the rest is untouched.
    const partial = (await (await request(api, "PUT", "/api/settings", {
      availableFloorMinor: 1100000,
    }))!.json()) as SettingsBody;
    expect(partial.settings).toEqual({
      availableFloorMinor: 1100000,
      overallMonthlyBudgetMinor: 600000,
      categoryBudgets: { Groceries: 50000, Transport: 20000 },
      jevEnabled: true,
      jevLastOutcome: null,
    });

    // An empty patch changes nothing.
    const noop = (await (await request(api, "PUT", "/api/settings", {}))!.json()) as SettingsBody;
    expect(noop.settings).toEqual(partial.settings);

    // Explicit nulls clear, one key at a time and per category.
    const cleared = (await (await request(api, "PUT", "/api/settings", {
      availableFloorMinor: null,
      categoryBudgets: { Transport: null },
    }))!.json()) as SettingsBody;
    expect(cleared.settings).toEqual({
      availableFloorMinor: null,
      overallMonthlyBudgetMinor: 600000,
      categoryBudgets: { Groceries: 50000 },
      jevEnabled: true,
      jevLastOutcome: null,
    });

    const after = (await (await request(api, "GET", "/api/settings"))!.json()) as SettingsBody;
    expect(after.settings).toEqual(cleared.settings);
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts £0 as a real value, distinct from unset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chitra-settings-zero-"));
    const api = await freshApi(dir);
    const res = await request(api, "PUT", "/api/settings", {
      availableFloorMinor: 0,
      categoryBudgets: { Groceries: 0 },
    });
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as SettingsBody;
    expect(body.settings.availableFloorMinor).toBe(0);
    expect(body.settings.categoryBudgets).toEqual({ Groceries: 0 });
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects negative, fractional and non-numeric amounts, writing nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chitra-settings-bad-"));
    const api = await freshApi(dir);
    await request(api, "PUT", "/api/settings", { availableFloorMinor: 500000 });

    const badPatches: unknown[] = [
      { availableFloorMinor: -1 },
      { overallMonthlyBudgetMinor: -100 },
      { availableFloorMinor: 100.5 },
      { availableFloorMinor: "1000" },
      { categoryBudgets: { Groceries: -5 } },
      { categoryBudgets: { Groceries: 10.5 } },
      { categoryBudgets: [1, 2, 3] },
      { categoryBudgets: "Groceries" },
    ];
    for (const patch of badPatches) {
      const res = await request(api, "PUT", "/api/settings", patch);
      expect(res?.status, JSON.stringify(patch)).toBe(400);
      const body = (await res!.json()) as SettingsBody;
      expect(body.ok).toBe(false);
      expect(body.error!.length).toBeGreaterThan(0);
    }
    // The one good write from before the barrage is all that stands.
    const after = (await (await request(api, "GET", "/api/settings"))!.json()) as SettingsBody;
    expect(after.settings).toEqual({ ...UNSET, availableFloorMinor: 500000 });
    rmSync(dir, { recursive: true, force: true });
  });

  it("ignores category budgets for unknown names and applies the valid ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chitra-settings-unknown-"));
    const api = await freshApi(dir);
    const res = await request(api, "PUT", "/api/settings", {
      categoryBudgets: { "Not A Category": 99900, Groceries: 50000, "Moved aside": 100 },
    });
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as SettingsBody;
    expect(body.settings.categoryBudgets).toEqual({ Groceries: 50000 });
    rmSync(dir, { recursive: true, force: true });
  });
});

const ACCOUNT_HEADER =
  "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n";

/** The complete tiny PersonalFinance dir the rebuild test ingests. */
function fixtureDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chitra-settings-data-"));
  const originals = join(dir, "Originals");
  mkdirSync(originals, { recursive: true });
  writeFileSync(
    join(originals, "account-statement_2022_f5660e.csv"),
    ACCOUNT_HEADER +
      "Card Payment,Current,2026-10-03 10:00:00,2026-10-03 10:00:01,Ocado,-10.00,0.00,GBP,COMPLETED,990.00\n",
  );
  writeFileSync(
    join(originals, "account-statement_2022_01cac2.csv"),
    ACCOUNT_HEADER +
      "Card Payment,Pro,2026-10-02 10:00:00,2026-10-02 10:00:01,Tesco,-5.00,0.00,GBP,COMPLETED,100.00\n",
  );
  writeFileSync(
    join(originals, "account-statement_2022_2151f7.csv"),
    ACCOUNT_HEADER +
      "Card Payment,Invest,2026-10-02 10:00:00,2026-10-02 10:00:01,Netflix,-15.00,0.00,USD,COMPLETED,85.00\n",
  );
  writeFileSync(
    join(originals, "account-statement_2022_bd9d00.csv"),
    ACCOUNT_HEADER +
      "Card Payment,Joint,2026-10-02 10:00:00,2026-10-02 10:00:01,Waitrose,-7.50,0.00,GBP,COMPLETED,50.00\n",
  );
  writeFileSync(
    join(originals, "savings-9000000002.csv"),
    'Date,Description,Money Out,Money In,Balance\n"Oct 5, 2026",Deposit,,100.00,100.00\n',
  );
  writeFileSync(
    join(originals, "savings-9000000001.csv"),
    'Date,Description,Money Out,Money In,Balance\n"Oct 6, 2026",Deposit,,50.00,50.00\n',
  );
  return dir;
}

describe("settings storage", () => {
  it("survives a full rules-version store rebuild", () => {
    const dir = mkdtempSync(join(tmpdir(), "chitra-settings-store-"));
    const db = openStore(dir);
    const set = updateSettings(db, {
      availableFloorMinor: 1000000,
      overallMonthlyBudgetMinor: 600000,
      categoryBudgets: { Groceries: 50000 },
    });
    expect(set.ok).toBe(true);
    // Stamp an old rules version so the ingest takes the atomic
    // rebuild path (temp store + swap).
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('rules_version', '0') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    ).run();

    const results = ingestAll(db, fixtureDataDir());
    expect(results.every((r) => r.ok)).toBe(true);
    const markers = db
      .prepare("SELECT COUNT(*) AS n FROM ingest_runs WHERE account = '__rebuild__'")
      .get() as { n: number };
    expect(markers.n).toBe(1); // the rebuild really happened

    expect(getSettings(db)).toEqual({
      availableFloorMinor: 1000000,
      overallMonthlyBudgetMinor: 600000,
      categoryBudgets: { Groceries: 50000 },
      jevEnabled: true,
      jevLastOutcome: null,
    });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rides into the snapshot and the appSettings() accessor", () => {
    const dir = mkdtempSync(join(tmpdir(), "chitra-settings-snap-"));
    const db = openStore(dir);
    db.prepare(
      `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
         description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
       VALUES ('s1', 'zonito', 'Main', '2026-10-05', '2026-10', 'Ocado', 'Ocado', -1000, 0, 'GBP', 0, 'spend', NULL)`,
    ).run();
    expect(
      updateSettings(db, {
        availableFloorMinor: 250000,
        categoryBudgets: { Transport: 20000 },
      }).ok,
    ).toBe(true);
    db.close();

    process.env["CHITRAGUPTA_STORE_DIR"] = dir;
    const snap = buildSnapshot();
    expect(snap.settings).toEqual({
      availableFloorMinor: 250000,
      overallMonthlyBudgetMinor: null,
      categoryBudgets: { Transport: 20000 },
      jevEnabled: true,
      jevLastOutcome: null,
    });
    try {
      hydrateData(snap);
      expect(appSettings()).toEqual(snap.settings);
    } finally {
      hydrateData(SAMPLE_SNAPSHOT);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});
