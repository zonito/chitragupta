import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { ingestAll, recomputeAggregates } from "@/lib/ingest/ingest";
import { seedMerchantMemory } from "@/lib/ingest/merchants";
import { openStore } from "@/lib/ingest/store";
import { buildSnapshot } from "@/lib/snapshot.server";
import { byCategory, hydrateData, CATEGORIES } from "@/lib/data";
import { uiCategory } from "@/lib/txn-map";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";

const DATA_DIR = process.env["CHITRAGUPTA_DATA_DIR"]?.trim() || null;
const describeFixture = DATA_DIR ? describe : describe.skip;

/**
 * B9a agreement tests on the repro fixture (ingested into a throwaway
 * /tmp store, like the penny acceptance). The scoped aggregates API is
 * checked three ways: against the snapshot's byCategory for the current
 * month, against weighted SQL written independently here, and against
 * itself across scopes (year = sum of months, all = sum over the store).
 */

const CATEGORY_SQL = `COALESCE(t.category, m.category,
  CASE t.movement
    WHEN 'spend' THEN 'One-off' WHEN 'income' THEN 'One-off'
    WHEN 'aside' THEN 'Moved aside' WHEN 'fee' THEN 'Fees'
    WHEN 'interest' THEN 'Interest' ELSE 'Transfer' END)`;

const WEIGHT_SQL = `CASE WHEN ? = 'household' THEN 1.0
  WHEN t.account = 'Joint' THEN 0.5
  WHEN t.person = ? THEN 1.0 ELSE 0.0 END`;

interface ScopeRow {
  category: string;
  spend_minor: number;
  typical_minor: number | null;
  series: number[];
}
interface ScopeBody {
  ok: boolean;
  person: string;
  scope: string;
  month?: string;
  year?: string;
  total_minor: number;
  seriesPeriods: string[];
  seriesLabels: string[];
  rows: ScopeRow[];
  merchants?: { merchant: string; spend_minor: number }[];
}

type Api = typeof import("@/lib/api");

/** Half-minor values (halved odd Joint rows) are exact; normalise to them. */
const norm = (n: number) => Math.round(n * 2) / 2;

describeFixture("Categories scoped aggregates (repro copy in /tmp)", () => {
  const prevEnv = process.env["CHITRAGUPTA_STORE_DIR"];
  let dir: string | null = null;
  let db: Database.Database;
  let api: Api;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "chitra-b9a-"));
    db = openStore(dir);
    ingestAll(db, DATA_DIR!, "zonito");
    seedMerchantMemory(db);
    recomputeAggregates(db, "zonito");
    process.env["CHITRAGUPTA_STORE_DIR"] = dir;
    api = await import("@/lib/api");
  }, 180_000);

  afterAll(() => {
    db?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env["CHITRAGUPTA_STORE_DIR"];
    else process.env["CHITRAGUPTA_STORE_DIR"] = prevEnv;
    hydrateData(SAMPLE_SNAPSHOT);
  });

  async function getScope(qs: string): Promise<ScopeBody> {
    const res = await api.handleChitraguptaApi(
      new Request(`http://local/api/aggregates?${qs}`),
    );
    expect(res?.status).toBe(200);
    return (await res!.json()) as ScopeBody;
  }

  /** Independent weighted per-category spend, straight from transactions. */
  function weightedByCategory(
    person: string,
    where: string,
    params: unknown[] = [],
  ): Map<string, number> {
    const rows = db
      .prepare(
        `SELECT ${CATEGORY_SQL} AS raw,
                SUM(-t.amount_minor * (${WEIGHT_SQL})) AS spend
         FROM transactions t LEFT JOIN merchant_memory m ON m.merchant = t.merchant
         WHERE t.currency = 'GBP' AND t.movement = 'spend' AND t.amount_minor < 0
           AND ${where}
         GROUP BY raw`,
      )
      .all(person, person, ...(params as never[])) as {
      raw: string;
      spend: number;
    }[];
    const map = new Map<string, number>();
    for (const r of rows) {
      const category = uiCategory(r.raw);
      if (!(CATEGORIES as readonly string[]).includes(category)) continue;
      map.set(category, (map.get(category) ?? 0) + r.spend);
    }
    // A person with no share in a category groups to a zero sum in SQL;
    // the API (like byCategory) omits zero categories entirely.
    for (const [k, v] of map) if (v <= 0) map.delete(k);
    return map;
  }

  function rowsMap(body: ScopeBody): Map<string, number> {
    return new Map(body.rows.map((r) => [r.category, r.spend_minor]));
  }

  function expectMapsEqual(a: Map<string, number>, b: Map<string, number>) {
    expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
    for (const [k, v] of a) expect(norm(b.get(k)!), k).toBe(norm(v));
  }

  it("keeps the legacy no-scope response byte-compatible in shape and values", async () => {
    const res = await api.handleChitraguptaApi(
      new Request("http://local/api/aggregates?month=2026-10&person=zonito"),
    );
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "month",
      "ok",
      "otherCurrencies",
      "person",
      "rows",
    ]);
    const rows = body["rows"] as { spend_minor: number }[];
    const table = db
      .prepare(
        `SELECT SUM(spend_minor) AS s FROM month_aggregates
         WHERE person = 'zonito' AND year_month = '2026-10' AND currency = 'GBP'`,
      )
      .get() as { s: number };
    expect(rows.reduce((s, r) => s + r.spend_minor, 0)).toBe(table.s);
  });

  it("October 2026 month scope equals the snapshot byCategory to the penny (household and zonito)", async () => {
    const snapshot = buildSnapshot();
    expect(snapshot.monthKey).toBe("2026-10");
    hydrateData(snapshot);
    try {
      for (const person of ["household", "zonito"] as const) {
        const body = await getScope(
          `scope=month&month=2026-10&person=${person}`,
        );
        const fromClient = new Map(
          byCategory(person).map((c) => [
            c.category,
            norm(c.amount * 100),
          ]),
        );
        expectMapsEqual(rowsMap(body), fromClient);
        expect(norm(body.total_minor)).toBe(
          norm([...fromClient.values()].reduce((s, v) => s + v, 0)),
        );
      }
    } finally {
      hydrateData(SAMPLE_SNAPSHOT);
    }
  });

  it("March 2026 month scope equals direct weighted SQL", async () => {
    for (const person of ["household", "zonito", "nikhila"]) {
      const body = await getScope(`scope=month&month=2026-03&person=${person}`);
      expectMapsEqual(
        rowsMap(body),
        weightedByCategory(person, "t.year_month = ?", ["2026-03"]),
      );
    }
  });

  it("year scope 2025 equals the sum of its twelve month scopes", async () => {
    const year = await getScope("scope=year&year=2025&person=household");
    const summed = new Map<string, number>();
    let summedTotal = 0;
    for (let m = 1; m <= 12; m++) {
      const month = await getScope(
        `scope=month&month=2025-${String(m).padStart(2, "0")}&person=household`,
      );
      summedTotal += month.total_minor;
      for (const r of month.rows) {
        summed.set(r.category, (summed.get(r.category) ?? 0) + r.spend_minor);
      }
    }
    expectMapsEqual(rowsMap(year), summed);
    expect(norm(year.total_minor)).toBe(norm(summedTotal));
    expect(year.seriesPeriods).toHaveLength(12);
    expect(year.seriesPeriods[0]).toBe("2025-01");
    expect(year.seriesPeriods[11]).toBe("2025-12");
    for (const row of year.rows) {
      expect(row.series).toHaveLength(12);
      expect(norm(row.series.reduce((s, v) => s + v, 0))).toBe(
        norm(row.spend_minor),
      );
    }
  });

  it("all-time scope equals direct weighted SQL over the whole store, typical null", async () => {
    const body = await getScope("scope=all&person=zonito");
    expectMapsEqual(
      rowsMap(body),
      weightedByCategory("zonito", "1 = 1"),
    );
    expect(body.seriesPeriods).toEqual(["2022", "2023", "2024", "2025", "2026"]);
    for (const row of body.rows) {
      expect(row.typical_minor).toBeNull();
      expect(row.series).toHaveLength(5);
      expect(norm(row.series.reduce((s, v) => s + v, 0))).toBe(
        norm(row.spend_minor),
      );
    }
  });

  it("merchant breakdown for a category in a past month sums to the category total", async () => {
    const scope = await getScope("scope=month&month=2026-03&person=household");
    const top = scope.rows[0]!;
    const body = await getScope(
      `scope=month&month=2026-03&person=household&category=${encodeURIComponent(top.category)}`,
    );
    expect(body.merchants).toBeDefined();
    expect(body.merchants!.length).toBeGreaterThan(0);
    const sum = body.merchants!.reduce((s, m) => s + m.spend_minor, 0);
    expect(norm(sum)).toBe(norm(top.spend_minor));
    const spends = body.merchants!.map((m) => m.spend_minor);
    expect(spends).toEqual([...spends].sort((a, b) => b - a));
  });

  it("counts the April 2025 Joint £9.45 row at half for zonito and full for household", async () => {
    // Pin the fixture fact: exactly one Joint GBP spend row that month.
    const joint = db
      .prepare(
        `SELECT merchant, amount_minor FROM transactions
         WHERE account = 'Joint' AND currency = 'GBP' AND movement = 'spend'
           AND amount_minor < 0 AND year_month = '2025-04'`,
      )
      .all() as { merchant: string; amount_minor: number }[];
    expect(joint).toEqual([{ merchant: "Ikea", amount_minor: -945 }]);
    const resolved = db
      .prepare(
        `SELECT ${CATEGORY_SQL} AS raw FROM transactions t
         LEFT JOIN merchant_memory m ON m.merchant = t.merchant
         WHERE t.account = 'Joint' AND t.merchant = 'Ikea' AND t.year_month = '2025-04'`,
      )
      .get() as { raw: string };
    const category = uiCategory(resolved.raw);

    const household = await getScope("scope=month&month=2025-04&person=household");
    const zonito = await getScope("scope=month&month=2025-04&person=zonito");
    const hRow = household.rows.find((r) => r.category === category)!;
    const zRow = zonito.rows.find((r) => r.category === category)!;
    expect(hRow).toBeDefined();
    expect(zRow).toBeDefined();
    // Every other row that month belongs to zonito, so the two views
    // differ only by the halved Joint row: exactly £4.725.
    expect(norm(hRow.spend_minor - zRow.spend_minor)).toBe(472.5);
    expectMapsEqual(
      rowsMap(zonito),
      weightedByCategory("zonito", "t.year_month = ?", ["2025-04"]),
    );
    expectMapsEqual(
      rowsMap(household),
      weightedByCategory("household", "t.year_month = ?", ["2025-04"]),
    );
  });

  it("month-scope typical is the median of the prior 6 months, computed independently", async () => {
    const body = await getScope("scope=month&month=2026-10&person=household");
    const prior6 = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];
    for (const category of ["Groceries", "Transport"]) {
      const monthly = prior6.map(
        (ym) => weightedByCategory("household", "t.year_month = ?", [ym]).get(category) ?? 0,
      );
      const sorted = [...monthly].sort((a, b) => a - b);
      const expected = (sorted[2]! + sorted[3]!) / 2;
      const row = body.rows.find((r) => r.category === category)!;
      expect(row, category).toBeDefined();
      expect(norm(row.typical_minor!)).toBe(norm(expected));
    }
    // Series: the 6 months ending at the scope month, last point = total.
    expect(body.seriesPeriods).toEqual([
      "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10",
    ]);
    for (const row of body.rows) {
      expect(row.series).toHaveLength(6);
      expect(norm(row.series[5]!)).toBe(norm(row.spend_minor));
    }
  });

  it("year-scope typical is the median of the other years' annual totals", async () => {
    const body = await getScope("scope=year&year=2025&person=household");
    const category = "Groceries";
    const annual = ["2022", "2023", "2024", "2026"].map((y) => {
      const perMonth = weightedByCategory(
        "household",
        "substr(t.year_month, 1, 4) = ?",
        [y],
      );
      return perMonth.get(category) ?? 0;
    });
    const sorted = [...annual].sort((a, b) => a - b);
    const expected = (sorted[1]! + sorted[2]!) / 2;
    const row = body.rows.find((r) => r.category === category)!;
    expect(row).toBeDefined();
    expect(norm(row.typical_minor!)).toBe(norm(expected));
  });

  it("rejects a bad person and a bad scope with 400", async () => {
    const badPerson = await api.handleChitraguptaApi(
      new Request("http://local/api/aggregates?scope=month&month=2026-10&person=nobody"),
    );
    expect(badPerson?.status).toBe(400);
    const badScope = await api.handleChitraguptaApi(
      new Request("http://local/api/aggregates?scope=decade&person=household"),
    );
    expect(badScope?.status).toBe(400);
  });
});
