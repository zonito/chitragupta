import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { render, screen, within } from "@testing-library/react";
import type Database from "better-sqlite3";
import { PersonProvider } from "@/components/shell";
import {
  flowWindowFor,
  hydrateData,
  type DataSnapshot,
} from "@/lib/data";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-router")>(
    "@tanstack/react-router",
  );
  return {
    ...actual,
    useRouter: () => ({ invalidate: async () => {} }),
    Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => (
      <a href={to} className={className}>{children}</a>
    ),
  };
});

// Imported after the router mock is registered.
const { Index, IncomeSpendingCard } = await import("@/routes/index");

/**
 * Home "Income vs spending": the current month's in / out / gap
 * headline and the last six months as paired bars. The figures are
 * movement totals from the precomputed month_aggregates — income is
 * movement 'income', spend is movement 'spend', moved-aside and
 * internal transfers count as NEITHER — pinned three ways: the
 * window accessor against hand-built series (alignment, honest
 * empty months), the card against a synthetic snapshot (headline,
 * signed coloured gap, empty pair, bar heights), and — gated on
 * the repro2 fixture — the whole composition against the fixture
 * store's aggregates, summed exactly as /api/aggregates sums them.
 */

afterEach(() => {
  hydrateData(SAMPLE_SNAPSHOT);
});

/** A snapshot whose flow series is the given aligned arrays over
 * 2026-05..2026-10 (the sample's month range), household unless
 * overridden per person. */
const withFlow = (
  flow: Partial<Record<"household" | "zonito" | "nikhila", { income: number[]; spend: number[] }>>,
): DataSnapshot => ({
  ...SAMPLE_SNAPSHOT,
  flowMonthly: {
    months: ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"],
    income: Object.fromEntries(Object.entries(flow).map(([p, v]) => [p, v.income])),
    spend: Object.fromEntries(Object.entries(flow).map(([p, v]) => [p, v.spend])),
  },
});

describe("flowWindowFor", () => {
  it("aligns the six calendar months ending at the current month, gaps reading 0/0", () => {
    hydrateData({
      ...SAMPLE_SNAPSHOT,
      flowMonthly: {
        months: ["2026-08", "2026-09", "2026-10"],
        income: { household: [100, 200, 300] },
        spend: { household: [50, 250, 100] },
      },
    });
    expect(flowWindowFor("household")).toEqual([
      { month: "2026-05", income: 0, spend: 0, gap: 0 },
      { month: "2026-06", income: 0, spend: 0, gap: 0 },
      { month: "2026-07", income: 0, spend: 0, gap: 0 },
      { month: "2026-08", income: 100, spend: 50, gap: 50 },
      { month: "2026-09", income: 200, spend: 250, gap: -50 },
      { month: "2026-10", income: 300, spend: 100, gap: 200 },
    ]);
  });

  it("reads each person's own series, never another view's", () => {
    hydrateData(
      withFlow({
        household: { income: [1, 1, 1, 1, 1, 900], spend: [1, 1, 1, 1, 1, 100] },
        zonito: { income: [0, 0, 0, 0, 0, 600], spend: [0, 0, 0, 0, 0, 100] },
        nikhila: { income: [0, 0, 0, 0, 0, 300], spend: [0, 0, 0, 0, 0, 450] },
      }),
    );
    expect(flowWindowFor("zonito").at(-1)).toEqual({
      month: "2026-10", income: 600, spend: 100, gap: 500,
    });
    expect(flowWindowFor("nikhila").at(-1)).toEqual({
      month: "2026-10", income: 300, spend: 450, gap: -150,
    });
  });

  it("a snapshot without the field reads as six honest zero months", () => {
    const bare = { ...SAMPLE_SNAPSHOT } as DataSnapshot;
    delete (bare as Partial<DataSnapshot>).flowMonthly;
    hydrateData(bare);
    const rows = flowWindowFor("household");
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.income === 0 && r.spend === 0 && r.gap === 0)).toBe(true);
    expect(rows.at(-1)!.month).toBe("2026-10");
  });
});

describe("IncomeSpendingCard", () => {
  // Window max is August's £1,000 income, so heights are round:
  // October in £500 → 50%, out £250 → 25%; May is an empty month.
  const snap = () =>
    withFlow({
      household: {
        income: [0, 200, 0, 1000, 400, 500],
        spend: [0, 100, 300, 500, 600, 250],
      },
      nikhila: {
        income: [0, 0, 0, 0, 0, 100],
        spend: [0, 0, 0, 0, 0, 260],
      },
    });

  it("headlines the current month: In, Out and the signed gap, green when ahead", () => {
    hydrateData(snap());
    render(
      <PersonProvider>
        <IncomeSpendingCard person="household" />
      </PersonProvider>,
    );
    const headline = screen.getByText(/In £500\.00/);
    expect(headline.textContent).toContain("In £500.00 · Out £250.00 · Gap +£250.00");
    const gap = within(headline).getByText("+£250.00");
    expect(gap.className).toContain("text-good");
    expect(gap.className).not.toContain("text-destructive");
  });

  it("renders the gap red when the month is behind, per person", () => {
    hydrateData(snap());
    render(
      <PersonProvider>
        <IncomeSpendingCard person="nikhila" />
      </PersonProvider>,
    );
    const headline = screen.getByText(/In £100\.00/);
    expect(headline.textContent).toContain("In £100.00 · Out £260.00 · Gap −£160.00");
    expect(within(headline).getByText("−£160.00").className).toContain("text-destructive");
  });

  it("draws six month groups; an empty month is an honest empty pair, never skipped", () => {
    hydrateData(snap());
    const { container } = render(
      <PersonProvider>
        <IncomeSpendingCard person="household" />
      </PersonProvider>,
    );
    // Every month in the window carries its full figures (sr-only
    // text + the group title), including the empty May.
    for (const figures of [
      "May 2026: in £0.00, out £0.00, gap +£0.00",
      "June 2026: in £200.00, out £100.00, gap +£100.00",
      "July 2026: in £0.00, out £300.00, gap −£300.00",
      "August 2026: in £1,000.00, out £500.00, gap +£500.00",
      "September 2026: in £400.00, out £600.00, gap −£200.00",
      "October 2026: in £500.00, out £250.00, gap +£250.00",
    ]) {
      expect(screen.getByTitle(figures)).toBeTruthy();
    }
    // The empty pair: both of May's fills are 0% inside their tracks.
    const may = screen.getByTitle("May 2026: in £0.00, out £0.00, gap +£0.00");
    expect(may.querySelectorAll('[style*="height: 0%"]')).toHaveLength(2);
    // Bar heights scale to the window max (August's £1,000 income).
    const october = screen.getByTitle("October 2026: in £500.00, out £250.00, gap +£250.00");
    expect(october.querySelectorAll('[style*="height: 50%"]')).toHaveLength(1);
    expect(october.querySelectorAll('[style*="height: 25%"]')).toHaveLength(1);
    const august = screen.getByTitle("August 2026: in £1,000.00, out £500.00, gap +£500.00");
    expect(august.querySelectorAll('[style*="height: 100%"]')).toHaveLength(1);
    // The visible net figure sits under each pair, signed and coloured.
    expect(container.textContent).toContain("−£300.00");
  });
});

// ---------------------------------------------------------------------------
// Gated repro2: the card's figures against the fixture store's
// aggregates, summed exactly as /api/aggregates sums them (its rows
// for the person + month, totalled). The expected figures below were
// computed by hand from those aggregates.
// ---------------------------------------------------------------------------

const DATA_DIR = process.env["CHITRAGUPTA_DATA_DIR"];
const BOTH_PEOPLE =
  !!DATA_DIR &&
  existsSync(
    join(DATA_DIR, "Originals", "account-statement_2023-02-01_2026-10-31_en-sg_f68986.csv"),
  );

/** Hand-computed from the fixture's month_aggregates (GBP): the last
 * six months ending at the fixture's current month, 2026-10. */
const EXPECTED: Record<string, Record<string, { income: number; spend: number; gap: number }>> = {
  household: {
    "2026-05": { income: 2448.98, spend: 5000.06, gap: -2551.08 },
    "2026-06": { income: 5160.19, spend: 5631.79, gap: -471.6 },
    "2026-07": { income: 5861.11, spend: 9649.15, gap: -3788.04 },
    "2026-08": { income: 4090.96, spend: 3230.63, gap: 860.33 },
    "2026-09": { income: 18775.2, spend: 3999.71, gap: 14775.49 },
    "2026-10": { income: 311.82, spend: 2102.39, gap: -1790.57 },
  },
  zonito: {
    "2026-09": { income: 18771.2, spend: 3241.78, gap: 15529.42 },
    "2026-10": { income: 309.22, spend: 1952.38, gap: -1643.16 },
  },
  nikhila: {
    "2026-09": { income: 4.0, spend: 757.93, gap: -753.93 },
    "2026-10": { income: 2.6, spend: 150.01, gap: -147.41 },
  },
};

describe.runIf(BOTH_PEOPLE)("Income vs spending on the repro fixture (aggregates-derived)", () => {
  let db: Database.Database;
  let storeDir: string;
  let fixtureSnap: DataSnapshot;

  beforeAll(async () => {
    const { openStore } = await import("@/lib/ingest/store");
    const { ingestAll, recomputeAggregates } = await import("@/lib/ingest/ingest");
    const { seedMerchantMemory } = await import("@/lib/ingest/merchants");
    const { buildSnapshot } = await import("@/lib/snapshot.server");
    storeDir = mkdtempSync(join(tmpdir(), "chitra-flow-"));
    db = openStore(storeDir);
    ingestAll(db, DATA_DIR!);
    seedMerchantMemory(db);
    recomputeAggregates(db, "zonito");
    recomputeAggregates(db, "nikhila");
    recomputeAggregates(db, "household");
    process.env["CHITRAGUPTA_STORE_DIR"] = storeDir;
    fixtureSnap = buildSnapshot();
  }, 180_000);

  beforeEach(() => {
    hydrateData(fixtureSnap);
  });

  afterAll(() => {
    db.close();
    rmSync(storeDir, { recursive: true, force: true });
  });

  /** /api/aggregates' own computation for one view + month: its
   * per-category GBP rows for the stored person, totalled. */
  function apiAggregates(person: string, month: string): { income: number; spend: number } {
    const rows = db
      .prepare(
        `SELECT spend_minor, income_minor FROM month_aggregates
         WHERE person = ? AND year_month = ? AND currency = 'GBP'`,
      )
      .all(person, month) as { spend_minor: number; income_minor: number }[];
    return {
      spend: rows.reduce((s, r) => s + r.spend_minor, 0) / 100,
      income: rows.reduce((s, r) => s + r.income_minor, 0) / 100,
    };
  }

  it("the snapshot flow series equals the aggregates sums for the last six months", () => {
    for (const person of ["household", "zonito", "nikhila"] as const) {
      const rows = flowWindowFor(person);
      expect(rows.map((r) => r.month)).toEqual([
        "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10",
      ]);
      for (const row of rows) {
        const api = apiAggregates(person, row.month);
        expect(row.income, `${person} ${row.month} income`).toBeCloseTo(api.income, 6);
        expect(row.spend, `${person} ${row.month} spend`).toBeCloseTo(api.spend, 6);
        expect(row.gap).toBeCloseTo(api.income - api.spend, 6);
        const expected = EXPECTED[person]![row.month];
        if (expected) {
          expect(row.income, `${person} ${row.month} income (hand)`).toBeCloseTo(expected.income, 6);
          expect(row.spend, `${person} ${row.month} spend (hand)`).toBeCloseTo(expected.spend, 6);
          expect(row.gap, `${person} ${row.month} gap (hand)`).toBeCloseTo(expected.gap, 6);
        }
      }
    }
  });

  it("moved-aside money is in neither figure (September household aside is £36,310.56)", () => {
    // September's aggregates carry £36,310.56 of moved-aside for the
    // household; the flow figures for that month (in £18,775.20 /
    // out £3,999.71, asserted above) are the movement totals with
    // aside nowhere in them — the SQL comparison in the previous
    // test is over income_minor/spend_minor only, which by
    // construction exclude the aside movement.
    const aside = db
      .prepare(
        `SELECT SUM(aside_minor) AS a FROM month_aggregates
         WHERE person = 'household' AND year_month = '2026-09' AND currency = 'GBP'`,
      )
      .get() as { a: number };
    expect(aside.a / 100).toBeCloseTo(36310.56, 6);
  });

  it("Home renders the fixture's current-month headline and September's figures", () => {
    render(
      <PersonProvider>
        <Index />
      </PersonProvider>,
    );
    const headline = screen.getByText(/In £311\.82/);
    expect(headline.textContent).toContain(
      "In £311.82 · Out £2,102.39 · Gap −£1,790.57",
    );
    expect(screen.getByTitle(
      "September 2026: in £18,775.20, out £3,999.71, gap +£14,775.49",
    )).toBeTruthy();
    expect(screen.getByTitle(
      "October 2026: in £311.82, out £2,102.39, gap −£1,790.57",
    )).toBeTruthy();
  });
});
