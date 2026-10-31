import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PersonProvider } from "@/components/shell";
import { Categories } from "@/routes/categories";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";
import {
  EMPTY_SNAPSHOT,
  gbp,
  hydrateData,
  monthlyHistoryFor,
} from "@/lib/data";
import {
  categoryTotals,
  CHART_EXCLUDED_CATEGORIES,
  comparisonText,
  cumulativeBuckets,
  dailyBuckets,
  monthlyBuckets,
  presetBuckets,
  presetComparison,
  quarterlyBuckets,
  ytdBuckets,
  type DailyData,
  type MonthlyRows,
} from "@/lib/timeline";

/**
 * Categories timeline chart: preset bucketing over the snapshot's
 * monthly history (the precomputed month_aggregates), the shared
 * chart's isolate/readout behaviour, and — on the real two-person
 * store — exact agreement with the aggregates and with direct SQL.
 */

const M = (months: string[], rows: Record<string, number[]>): MonthlyRows => ({
  months,
  rows: Object.entries(rows).map(([category, series]) => ({ category, series })),
});

const monthRange = (start: string, count: number): string[] => {
  const [y, m] = start.split("-").map(Number) as [number, number];
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
};

afterEach(() => {
  hydrateData(SAMPLE_SNAPSHOT);
  vi.unstubAllGlobals();
});

describe("timeline bucketing", () => {
  it("monthly shows the last 12 months with per-category values", () => {
    const months = monthRange("2025-01", 15);
    const data = M(months, { Groceries: months.map((_, i) => (i + 1) * 10) });
    const buckets = monthlyBuckets(data, 12);
    expect(buckets.map((b) => b.key)).toEqual(months.slice(3));
    expect(buckets[0]).toMatchObject({ label: "April 2025", short: "Apr" });
    expect(buckets[0]!.values["Groceries"]).toBe(40);
    expect(buckets[11]!.total).toBe(150);
  });

  it("a quarter bucket is exactly the sum of its three months", () => {
    const data = M(["2026-01", "2026-02", "2026-03"], {
      Groceries: [100, 200, 300],
      Home: [10, 20, 30],
    });
    const buckets = quarterlyBuckets(data, null);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ key: "2026-Q1", label: "Q1 2026", total: 660 });
    expect(buckets[0]!.values).toEqual({ Groceries: 600, Home: 60 });
    expect(buckets[0]!.partial).toBeUndefined();
  });

  it("a quarter that starts mid-history is marked partial", () => {
    const data = M(["2026-02", "2026-03", "2026-04", "2026-05", "2026-06"], {
      Groceries: [1, 2, 3, 4, 5],
    });
    const buckets = quarterlyBuckets(data, null);
    expect(buckets[0]).toMatchObject({ key: "2026-Q1", partial: true });
    expect(buckets[1]).toMatchObject({ key: "2026-Q2" });
    expect(buckets[1]!.partial).toBeUndefined();
  });

  it("YTD is anchored to the latest data month, not the wall clock", () => {
    const data = M(monthRange("2025-11", 5), { Groceries: [1, 2, 3, 4, 5] });
    // Data ends March 2026: YTD is Jan–Mar 2026 even though "now" in
    // the wall-clock sense is later in the year.
    expect(ytdBuckets(data).map((b) => b.key)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
    ]);
  });

  it("cumulative buckets carry running totals per category", () => {
    const data = M(["2026-01", "2026-02", "2026-03"], {
      Groceries: [10, 20, 30],
      Home: [5, 0, 5],
    });
    const cum = cumulativeBuckets(monthlyBuckets(data, 12));
    expect(cum.map((b) => b.total)).toEqual([15, 35, 70]);
    expect(cum[2]!.values).toEqual({ Groceries: 60, Home: 10 });
  });

  it("category totals order biggest first", () => {
    const data = M(["2026-01"], { Home: [50], Groceries: [200], Transport: [200] });
    expect(categoryTotals(monthlyBuckets(data))).toEqual([
      { name: "Groceries", total: 200 },
      { name: "Transport", total: 200 },
      { name: "Home", total: 50 },
    ]);
  });

  it("chart buckets exclude system categories even when their spend is non-zero", () => {
    // The Jul-2026 shape from live data: "Moved aside" carries £110
    // of spend_minor (incoming aside money). It must not stack as
    // spending in ANY preset's buckets, and totals drop by exactly it.
    const data = M(["2026-07", "2026-08", "2026-09"], {
      Groceries: [100, 100, 100],
      "Moved aside": [110, 0, 0],
      Transfer: [0, 50, 0],
      Interest: [0, 0, 5],
      Fees: [0, 0, 7],
    });
    for (const buckets of [
      monthlyBuckets(data),
      quarterlyBuckets(data, null),
      ytdBuckets(data),
      cumulativeBuckets(monthlyBuckets(data)),
    ]) {
      for (const b of buckets) {
        for (const name of Object.keys(b.values)) {
          expect(CHART_EXCLUDED_CATEGORIES.has(name)).toBe(false);
        }
      }
    }
    expect(monthlyBuckets(data).map((b) => b.total)).toEqual([100, 100, 100]);
    expect(quarterlyBuckets(data, null)[0]!.total).toBe(300);
    expect(categoryTotals(monthlyBuckets(data))).toEqual([
      { name: "Groceries", total: 300 },
    ]);
  });

  it("daily buckets drop system categories and recompute the day total", () => {
    const daily: DailyData = {
      start: "2026-10-30",
      end: "2026-10-31",
      dataStart: "2026-10-30",
      buckets: [
        { date: "2026-10-30", total: 25, categories: { Groceries: 20, Fees: 5 } },
        { date: "2026-10-31", total: 40, categories: { Groceries: 40 } },
      ],
    };
    const buckets = dailyBuckets(daily, 30);
    expect(buckets[0]).toMatchObject({ total: 20, values: { Groceries: 20 } });
    expect(buckets[1]).toMatchObject({ total: 40, values: { Groceries: 40 } });
  });
});

describe("comparison line", () => {
  const bucket = (values: Record<string, number>) => ({
    key: "k",
    label: "L",
    short: "S",
    total: Object.values(values).reduce((s, v) => s + v, 0),
    values,
  });

  it("names the biggest riser in plain language", () => {
    expect(
      comparisonText([bucket({ Groceries: 180, Home: 90 })], [bucket({ Groceries: 100, Home: 100 })], "previous 12 months"),
    ).toBe("Groceries up £80 vs previous 12 months");
  });

  it("falls back to the biggest faller when nothing rose", () => {
    expect(
      comparisonText([bucket({ Groceries: 40 })], [bucket({ Groceries: 100 })], "previous 30 days"),
    ).toBe("Groceries down £60 vs previous 30 days");
  });

  it("omits the line for sub-£1 moves and missing windows", () => {
    expect(comparisonText([bucket({ Groceries: 100.4 })], [bucket({ Groceries: 100 })], "x")).toBeNull();
    expect(comparisonText([bucket({ Groceries: 100 })], null, "x")).toBeNull();
    expect(comparisonText([bucket({ Groceries: 100 })], [], "x")).toBeNull();
  });

  it("monthly comparison needs a fully covered previous 12 months", () => {
    const months24 = monthRange("2024-11", 24);
    const riser = M(months24, {
      Groceries: [...Array(12).fill(100), ...Array(12).fill(150)],
    });
    expect(presetComparison("monthly", riser, null)).toBe(
      "Groceries up £600 vs previous 12 months",
    );
    const months20 = monthRange("2025-03", 20);
    const thin = M(months20, { Groceries: Array(20).fill(100) });
    expect(presetComparison("monthly", thin, null)).toBeNull();
  });

  it("YTD compares against the same months last year", () => {
    const months = monthRange("2025-01", 22); // Jan 2025 – Oct 2026
    const clean = M(months, {
      Groceries: [
        ...Array(12).fill(100), // all of 2025
        ...Array(7).fill(100), // Jan–Jul 2026
        130, 130, 130, // Aug–Oct 2026: +30 in each of the last 3 months
      ],
    });
    expect(presetComparison("ytd", clean, null)).toBe(
      "Groceries up £90 vs the same months last year",
    );
  });

  it("quarterly comparison needs 24 complete quarters", () => {
    const months = monthRange("2020-01", 72); // 24 quarters
    const data = M(months, {
      Groceries: [...Array(36).fill(100), ...Array(36).fill(150)],
    });
    expect(presetComparison("quarterly", data, null)).toBe(
      "Groceries up £1,800 vs previous 12 quarters",
    );
    const short = M(monthRange("2022-01", 60), { Groceries: Array(60).fill(100) });
    expect(presetComparison("quarterly", short, null)).toBeNull();
  });

  it("daily comparison needs 60 covered days", () => {
    const mkDaily = (days: number, dataStart: string): DailyData => ({
      start: "2026-09-02",
      end: "2026-10-31",
      dataStart,
      buckets: Array.from({ length: days }, (_, i) => ({
        date: new Date(Date.UTC(2026, 8, 2 + i)).toISOString().slice(0, 10),
        total: i < 30 ? 10 : 20,
        categories: { Groceries: i < 30 ? 10 : 20 },
      })),
    });
    expect(presetComparison("daily", M([], {}), mkDaily(60, "2026-09-02"))).toBe(
      "Groceries up £300 vs previous 30 days",
    );
    // History starts inside the previous window: not fully covered.
    expect(presetComparison("daily", M([], {}), mkDaily(60, "2026-09-15"))).toBeNull();
    expect(presetComparison("daily", M([], {}), mkDaily(45, "2026-09-02"))).toBeNull();
    expect(presetComparison("daily", M([], {}), null)).toBeNull();
  });
});

describe("Categories timeline section (sample data)", () => {
  const renderCategories = () =>
    render(
      <PersonProvider>
        <Categories />
      </PersonProvider>,
    );

  it("renders the chart with Monthly active and snapshot figures, no fetch for the monthly presets", () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("must not fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    renderCategories();
    expect(screen.getByText("Spending over time")).toBeTruthy();
    const monthlyBtn = screen.getByRole("button", { name: "Monthly" });
    expect(monthlyBtn.getAttribute("aria-pressed")).toBe("true");
    const monthly = monthlyHistoryFor("household");
    const octIdx = monthly.months.indexOf("2026-10");
    const octTotal = monthly.rows.reduce((s, r) => s + (r.series[octIdx] ?? 0), 0);
    expect(screen.getByText(new RegExp(`October 2026 — ${gbp(octTotal)}`))).toBeTruthy();
    const groceriesTotal = monthly.rows.find((r) => r.category === "Groceries")!
      .series.reduce((s, v) => s + v, 0);
    expect(
      screen.getByRole("button", { name: `Groceries · ${gbp(groceriesTotal)}` }),
    ).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tapping a legend category isolates it, tapping again restores the stack", () => {
    renderCategories();
    const legend = screen.getByRole("button", { name: /Groceries · £/ });
    fireEvent.click(legend);
    expect(legend.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/on Groceries/)).toBeTruthy();
    fireEvent.click(legend);
    expect(legend.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByText(/on Groceries/)).toBeNull();
  });

  it("preset switches re-bucket: Quarterly lands on Q4 2026, 1Y reads as a running total", () => {
    renderCategories();
    fireEvent.click(screen.getByRole("button", { name: "Quarterly" }));
    expect(screen.getByText(/Q4 2026 — /)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "1Y" }));
    expect(screen.getByText(/spent so far/)).toBeTruthy();
  });

  it("Daily fetches 60 days from the daily endpoint and renders day buckets", async () => {
    const buckets = Array.from({ length: 60 }, (_, i) => {
      const date = new Date(Date.UTC(2026, 8, 2 + i)).toISOString().slice(0, 10);
      return {
        date,
        total_minor: i >= 30 ? 2000 : 1000,
        categories: { Groceries: i >= 30 ? 2000 : 1000 },
      };
    });
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({
        ok: true,
        person: "household",
        days: 60,
        start: "2026-09-02",
        end: "2026-10-31",
        dataStart: "2022-08-25",
        buckets,
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    renderCategories();
    fireEvent.click(screen.getByRole("button", { name: "Daily" }));
    expect(await screen.findByText(/31 Oct 2026 — £20/)).toBeTruthy();
    const dailyCall = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes("/api/aggregates/daily"));
    expect(dailyCall).toContain("days=60");
    expect(await screen.findByText("Groceries up £300 vs previous 30 days")).toBeTruthy();
  });

  it("empty history renders the honest empty state", () => {
    hydrateData(EMPTY_SNAPSHOT);
    renderCategories();
    expect(screen.getByText(/Not enough history yet/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------
// repro2 consistency: snapshot monthly history vs the aggregates API
// and direct SQL; the daily endpoint vs direct SQL.

const DATA_DIR = process.env["CHITRAGUPTA_DATA_DIR"]?.trim() || null;
const HER_CURRENT = "account-statement_2023-02-01_2026-10-31_en-sg_f68986.csv";
const HAS_HER_FILES = Boolean(
  DATA_DIR && existsSync(join(DATA_DIR, "Originals", HER_CURRENT)),
);
const describeRepro2 = HAS_HER_FILES ? describe : describe.skip;

describeRepro2("Timeline figures on the real two-person store (repro2)", () => {
  const storeDir = mkdtempSync(join(tmpdir(), "chitra-timeline-store-"));
  const prevStoreEnv = process.env["CHITRAGUPTA_STORE_DIR"];
  let built: ReturnType<typeof import("@/lib/snapshot.server").buildSnapshot>;
  let api: typeof import("@/lib/api");
  let db: import("better-sqlite3").Database;

  const apiJson = async (path: string) => {
    const res = await api.handleChitraguptaApi(new Request(`http://test${path}`));
    return res!.json() as Promise<Record<string, unknown>>;
  };

  beforeAll(async () => {
    process.env["CHITRAGUPTA_STORE_DIR"] = storeDir;
    const { openStore } = await import("@/lib/ingest/store");
    const { ingestAll } = await import("@/lib/ingest/ingest");
    const seedDb = openStore(storeDir);
    ingestAll(seedDb, DATA_DIR!);
    seedDb.close();
    api = await import("@/lib/api");
    // A freshly ingested store has no classifications (no gateway in
    // tests), so nearly everything resolves to One-off. Correct three
    // well-known merchants through the real correction flow — the same
    // writes the Activity sheet makes — so the aggregates carry several
    // categories, as the live store does.
    for (const [merchant, category] of [
      ["Ocado", "Groceries"],
      ["Transport for London", "Transport"],
    ] as const) {
      const res = await api.handleChitraguptaApi(
        new Request("http://test/api/merchants", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ merchant, category, source: "user" }),
        }),
      );
      const body = (await res!.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    }
    const { buildSnapshot } = await import("@/lib/snapshot.server");
    built = buildSnapshot();
    db = openStore(storeDir);
  }, 240_000);

  afterAll(() => {
    db?.close();
    if (prevStoreEnv === undefined) delete process.env["CHITRAGUPTA_STORE_DIR"];
    else process.env["CHITRAGUPTA_STORE_DIR"] = prevStoreEnv;
    hydrateData(SAMPLE_SNAPSHOT);
  });

  it("monthly buckets equal the aggregates rows for the same month and person", async () => {
    const body = (await apiJson("/api/aggregates?person=household&month=2026-10")) as {
      rows: { category: string; spend_minor: number }[];
    };
    const idx = built.monthly.months.indexOf("2026-10");
    expect(idx).toBeGreaterThanOrEqual(0);
    const known = new Set(built.categories.map((c) => c.name));
    const folded = new Map<string, number>();
    for (const r of body.rows) {
      const name = known.has(r.category) ? r.category : "One-off";
      folded.set(name, (folded.get(name) ?? 0) + r.spend_minor);
    }
    expect(folded.size).toBeGreaterThanOrEqual(3);
    expect(folded.has("Groceries")).toBe(true);
    expect(folded.has("Transport")).toBe(true);
    for (const [category, minor] of folded) {
      const seriesValue = built.monthly.series[category]?.household?.[idx] ?? 0;
      expect(Math.round(seriesValue * 100)).toBe(minor);
    }
    // And the month total across every category matches the API total.
    const apiTotal = body.rows.reduce((s, r) => s + r.spend_minor, 0);
    const chartTotal = Object.values(built.monthly.series).reduce(
      (s, per) => s + (per.household?.[idx] ?? 0),
      0,
    );
    expect(Math.round(chartTotal * 100)).toBe(apiTotal);
  });

  it("a quarter bucket equals the sum of its three months' aggregates, chart exclusions aside", async () => {
    // The aggregates themselves are untouched (the monthly test above
    // pins series == aggregates exactly); the CHART model excludes
    // the system categories, so the bucket equals the aggregates sum
    // minus those rows (Q3 2026 carries a positive "Moved aside"
    // spend_minor in this fixture's lineage).
    const known = new Set(built.categories.map((c) => c.name));
    let q3Minor = 0;
    for (const month of ["2026-07", "2026-08", "2026-09"]) {
      const body = (await apiJson(`/api/aggregates?person=household&month=${month}`)) as {
        rows: { category: string; spend_minor: number }[];
      };
      for (const r of body.rows) {
        const name = known.has(r.category) ? r.category : "One-off";
        if (!CHART_EXCLUDED_CATEGORIES.has(name)) q3Minor += r.spend_minor;
      }
    }
    hydrateData(built);
    const monthly = monthlyHistoryFor("household");
    const q3 = quarterlyBuckets(monthly, null).find((b) => b.key === "2026-Q3")!;
    expect(Math.round(q3.total * 100)).toBe(q3Minor);
    expect(q3Minor).toBeGreaterThan(0);
    // And no bucket on any preset carries a system category.
    for (const preset of ["monthly", "quarterly", "ytd", "oneyear", "all"] as const) {
      for (const b of presetBuckets(preset, monthly, null)) {
        for (const name of Object.keys(b.values)) {
          expect(CHART_EXCLUDED_CATEGORIES.has(name)).toBe(false);
        }
      }
    }
  });

  it("household monthly series is exactly zonito + nikhila", () => {
    const idx = built.monthly.months.indexOf("2026-09");
    expect(idx).toBeGreaterThanOrEqual(0);
    for (const [category, per] of Object.entries(built.monthly.series)) {
      const sum =
        (per.zonito?.[idx] ?? 0) + (per.nikhila?.[idx] ?? 0);
      expect(per.household?.[idx] ?? 0, category).toBeCloseTo(sum, 6);
    }
  });

  it("daily endpoint totals equal a direct transactions computation", async () => {
    const body = (await apiJson("/api/aggregates/daily?person=household&days=31")) as {
      start: string;
      end: string;
      buckets: { date: string; total_minor: number }[];
    };
    expect(body.end).toBe("2026-10-31");
    expect(body.start).toBe("2026-10-01");
    expect(body.buckets).toHaveLength(31);
    const sqlTotal = (
      db
        .prepare(
          `SELECT COALESCE(SUM(-amount_minor), 0) AS total FROM transactions
           WHERE currency = 'GBP' AND movement = 'spend' AND amount_minor < 0
             AND substr(effective_date, 1, 10) BETWEEN ? AND ?`,
        )
        .get(body.start, body.end) as { total: number }
    ).total;
    const endpointTotal = body.buckets.reduce((s, b) => s + b.total_minor, 0);
    expect(endpointTotal).toBe(sqlTotal);
    // The 31-day window IS October 2026, so it also equals the month's
    // aggregates total.
    const agg = (await apiJson("/api/aggregates?person=household&month=2026-10")) as {
      rows: { spend_minor: number }[];
    };
    expect(endpointTotal).toBe(agg.rows.reduce((s, r) => s + r.spend_minor, 0));

    const hers = (await apiJson("/api/aggregates/daily?person=nikhila&days=31")) as {
      buckets: { total_minor: number }[];
    };
    const sqlHers = (
      db
        .prepare(
          `SELECT COALESCE(SUM(-amount_minor), 0) AS total FROM transactions
           WHERE currency = 'GBP' AND movement = 'spend' AND amount_minor < 0
             AND person = 'nikhila'
             AND substr(effective_date, 1, 10) BETWEEN '2026-10-01' AND '2026-10-31'`,
        )
        .get() as { total: number }
    ).total;
    expect(hers.buckets.reduce((s, b) => s + b.total_minor, 0)).toBe(sqlHers);
    expect(sqlHers).toBe(15001); // her October card spend, hand-verified earlier
  });

  it("daily buckets are continuous and zero-filled over 60 days", async () => {
    const body = (await apiJson("/api/aggregates/daily?person=zonito&days=60")) as {
      buckets: { date: string; total_minor: number }[];
    };
    expect(body.buckets).toHaveLength(60);
    for (let i = 1; i < body.buckets.length; i++) {
      const prev = new Date(`${body.buckets[i - 1]!.date}T00:00:00Z`);
      prev.setUTCDate(prev.getUTCDate() + 1);
      expect(body.buckets[i]!.date).toBe(prev.toISOString().slice(0, 10));
    }
    expect(body.buckets.some((b) => b.total_minor === 0)).toBe(true);
  });

  it("preset buckets on the real history: 1Y is the running total of the monthly window", () => {
    hydrateData(built);
    const monthly = monthlyHistoryFor("household");
    const monthlyWindow = presetBuckets("monthly", monthly, null);
    const oneYear = presetBuckets("oneyear", monthly, null);
    expect(oneYear).toHaveLength(monthlyWindow.length);
    expect(oneYear[oneYear.length - 1]!.total).toBeCloseTo(
      monthlyWindow.reduce((s, b) => s + b.total, 0),
      6,
    );
    // Running totals never decrease.
    for (let i = 1; i < oneYear.length; i++) {
      expect(oneYear[i]!.total).toBeGreaterThanOrEqual(oneYear[i - 1]!.total);
    }
  });
});
