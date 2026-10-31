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
import { render, screen } from "@testing-library/react";
import type Database from "better-sqlite3";
import { PersonProvider } from "@/components/shell";
import {
  hydrateData,
  type DataSnapshot,
  type Sub,
  type Txn,
} from "@/lib/data";
import {
  detectIncomeRegulars,
  forecastEvents,
  forecastFor,
  forecastIsStale,
  paceFor,
  type IncomeCharge,
} from "@/lib/forecast";
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
const { Index } = await import("@/routes/index");

/**
 * Home "Rest of <Month>": the deterministic month-end forecast. The
 * model is pinned three ways: the income detector against synthetic
 * charge histories, the pace and the walk against hand-computed
 * synthetic snapshots (breach naming its culprit, safe-to-spend
 * headroom, per-view scoping), and — gated on the repro2 fixture —
 * the whole composition against figures derived from the fixture
 * store by SQL.
 */

afterEach(() => {
  hydrateData(SAMPLE_SNAPSHOT);
});

// ---------------------------------------------------------------------------
// Income detection: the spend detector's mirror.
// ---------------------------------------------------------------------------

const charge = (
  merchant: string,
  date: string,
  amountMinor: number,
  over: Partial<IncomeCharge> = {},
): IncomeCharge => ({
  merchant,
  date,
  amountMinor,
  account: "Main",
  person: "zonito",
  ...over,
});

describe("detectIncomeRegulars", () => {
  it("detects a monthly salary and projects its next landing", () => {
    const charges = [
      charge("Employer Ltd", "2026-06-28", 250000),
      charge("Employer Ltd", "2026-07-28", 250000),
      charge("Employer Ltd", "2026-08-28", 250000),
      charge("Employer Ltd", "2026-09-28", 250000),
    ];
    // Gaps are 30, 31, 31 days (the 28th to the 28th), so the median
    // cadence is 31 and the next landing is 29 Oct.
    expect(detectIncomeRegulars(charges, "2026-10-15")).toEqual([
      {
        name: "Employer Ltd",
        amount: 2500,
        owner: "zonito",
        nextExpected: "2026-10-29",
        periodDays: 31,
      },
    ]);
  });

  it("tolerates pay drift inside the 7% window and takes the latest amount", () => {
    const charges = [
      charge("Employer Ltd", "2026-07-28", 250000),
      charge("Employer Ltd", "2026-08-28", 256000),
      charge("Employer Ltd", "2026-09-28", 262000),
    ];
    const found = detectIncomeRegulars(charges, "2026-10-15");
    expect(found).toHaveLength(1);
    expect(found[0]!.amount).toBe(2620);
  });

  it("rejects varying-amount transfers, one-offs, weekly streams and stale streams", () => {
    const varying = [
      charge("SHARMA L", "2026-06-30", 200000),
      charge("SHARMA L", "2026-08-31", 400000),
      charge("SHARMA L", "2026-09-30", 700000),
    ];
    expect(detectIncomeRegulars(varying, "2026-10-31")).toEqual([]);
    expect(
      detectIncomeRegulars([charge("Bonus", "2026-09-15", 900000)], "2026-10-15"),
    ).toEqual([]);
    const weekly = [
      charge("Side Gig", "2026-09-07", 30000),
      charge("Side Gig", "2026-09-14", 30000),
      charge("Side Gig", "2026-09-21", 30000),
      charge("Side Gig", "2026-09-28", 30000),
    ];
    expect(detectIncomeRegulars(weekly, "2026-10-15")).toEqual([]);
    const stale = [
      charge("Old Job", "2026-03-28", 250000),
      charge("Old Job", "2026-04-28", 250000),
      charge("Old Job", "2026-05-28", 250000),
    ];
    expect(detectIncomeRegulars(stale, "2026-10-15")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pace: exclusions and the young-month blend.
// ---------------------------------------------------------------------------

const spendRow = (
  id: string,
  monthKey: string,
  day: number,
  amount: number,
  over: Partial<Txn> = {},
): Txn => ({
  id,
  date: `${monthKey}-${String(day).padStart(2, "0")}`,
  day,
  monthKey,
  merchant: `M-${id}`,
  category: "Groceries",
  amount,
  owner: "zonito",
  account: "Revolut Main · Zonito",
  kind: "spend",
  ...over,
});

describe("paceFor", () => {
  it("excludes one-offs and subscription-cluster charges", () => {
    const txns = [
      spendRow("a", "2026-10", 2, 100),
      spendRow("b", "2026-10", 3, 500, { category: "One-off" }),
      spendRow("c", "2026-10", 4, 60), // a cluster charge
      spendRow("d", "2026-10", 5, 40, { kind: "aside", category: "Moved aside" }),
    ];
    const pace = paceFor("household", "2026-10", "2026-10-10", txns, new Set(["c"]));
    expect(pace.elapsedDays).toBe(10);
    expect(pace.remainingDays).toBe(21);
    expect(pace.dailyRate).toBeCloseTo(10, 6); // £100 of variable spend / 10 days
    expect(pace.blended).toBe(false);
  });

  it("blends 50/50 with the previous complete month under 5 elapsed days", () => {
    const txns = [
      spendRow("a", "2026-10", 2, 90), // £90 over 3 elapsed days = £30/day
      spendRow("b", "2026-09", 10, 310),
      spendRow("c", "2026-09", 20, 310), // £620 over 30 days = £20.67/day
    ];
    const pace = paceFor("household", "2026-10", "2026-10-03", txns, new Set());
    expect(pace.blended).toBe(true);
    expect(pace.dailyRate).toBeCloseTo((30 + 620 / 30) / 2, 6);
  });
});

// ---------------------------------------------------------------------------
// Events: occurrence stepping and per-view scoping of the raw materials.
// ---------------------------------------------------------------------------

const sub = (over: Partial<Sub>): Sub => ({
  name: "Sub",
  amount: 10,
  freq: "Monthly",
  last: "1 Oct 2026",
  card: "Virtual ending 0000",
  owner: "zonito",
  status: "Active",
  charges: 3,
  chargeIds: [],
  nextExpected: "2026-11-01",
  variants: ["Sub"],
  ...over,
});

describe("forecastEvents", () => {
  it("steps a weekly regular through the remaining days", () => {
    const weekly = sub({
      name: "Cleaner",
      amount: 25,
      freq: "Weekly",
      nextExpected: "2026-10-12",
      periodDays: 7,
    });
    const { events, outTotal } = forecastEvents(
      "household",
      [weekly],
      [],
      "2026-10-10",
      "2026-10-31",
    );
    expect(events.map((e) => e.date)).toEqual(["2026-10-12", "2026-10-19", "2026-10-26"]);
    expect(outTotal).toBe(75);
  });

  it("halves Joint regulars for a person view and drops the other person's", () => {
    const joint = sub({ name: "Council Tax", amount: 200, owner: "joint", nextExpected: "2026-10-20", periodDays: 30 });
    const hers = sub({ name: "PureGym", amount: 35, owner: "nikhila", nextExpected: "2026-10-21", periodDays: 30 });
    expect(forecastEvents("zonito", [joint, hers], [], "2026-10-10", "2026-10-31").outTotal).toBe(100);
    expect(forecastEvents("nikhila", [joint, hers], [], "2026-10-10", "2026-10-31").outTotal).toBe(135);
    expect(forecastEvents("household", [joint, hers], [], "2026-10-10", "2026-10-31").outTotal).toBe(235);
  });
});

// ---------------------------------------------------------------------------
// The composed forecast over synthetic snapshots, and the card's copy.
// ---------------------------------------------------------------------------

/** A mid-October snapshot: data to the 10th, £1,000 available for the
 * household (Zonito's Main), £100 of variable spend in the first ten
 * days (£10/day), no one-offs. Overrides shape each scenario. */
function midOctober(over: Partial<DataSnapshot>): DataSnapshot {
  return {
    ...SAMPLE_SNAPSHOT,
    monthKey: "2026-10",
    latestDate: "2026-10-10",
    accounts: [
      {
        name: "Revolut Main", owner: "zonito", last: "10 Oct", lastDate: "2026-10-10",
        added: 3, stale: false, balanceMinor: 100000, currency: "GBP",
        accountId: "Main", person: "zonito",
      },
    ],
    txns: [
      spendRow("p1", "2026-10", 3, 60),
      spendRow("p2", "2026-10", 7, 40),
    ],
    income: [],
    incomeRegulars: [],
    subs: [],
    upcoming: [],
    settings: { ...SAMPLE_SNAPSHOT.settings },
    ...over,
  };
}

describe("forecastFor over synthetic snapshots", () => {
  it("a large late regular breaches the floor and is named as the culprit", () => {
    hydrateData(
      midOctober({
        subs: [sub({ name: "Mortgage Co", amount: 400, nextExpected: "2026-10-31", periodDays: 30 })],
        settings: {
          ...SAMPLE_SNAPSHOT.settings,
          availableFloorMinor: 90000, // £900 floor
        },
      }),
    );
    const f = forecastFor("household")!;
    // Walk: 21 remaining days × £10 pace = £210, plus the £400 regular
    // on the 31st: £1,000 − £210 − £400 = £390, the low point, reached
    // on the day the regular lands (that day's drop is £410, of which
    // the regular is £400 — it dominates).
    expect(f.paceDaily).toBeCloseTo(10, 6);
    expect(f.regularsOutTotal).toBe(400);
    expect(f.projectedEnd).toBeCloseTo(390, 6);
    expect(f.lowPoint).toEqual({ date: "2026-10-31", amount: 390 });
    expect(f.breach).toEqual({
      shortfall: 510,
      date: "2026-10-31",
      culprit: { name: "Mortgage Co", amount: 400 },
    });
    expect(f.headroom).toBeNull();
  });

  it("renders the breach copy, the no-income label and the stamp", () => {
    hydrateData(
      midOctober({
        subs: [sub({ name: "Mortgage Co", amount: 400, nextExpected: "2026-10-31", periodDays: 30 })],
        settings: {
          ...SAMPLE_SNAPSHOT.settings,
          availableFloorMinor: 90000,
        },
      }),
    );
    render(
      <PersonProvider>
        <Index />
      </PersonProvider>,
    );
    const card = screen.getByText(/Rest of October/).closest("section")!;
    expect(card.textContent).toMatch(/On course to end October at £390\.00/);
    expect(card.textContent).toMatch(
      /Dips £510 below your £900 floor on 31 Oct 2026, the day Mortgage Co £400\.00 lands\./,
    );
    expect(card.textContent).toMatch(/No regular income detected — outgoings and pace only\./);
    expect(card.textContent).toMatch(/Projected from statements to 10 Oct 2026/);
  });

  it("above the floor: headroom and the per-week safe-to-spend figure", () => {
    hydrateData(
      midOctober({
        subs: [sub({ name: "Netflix", amount: 20, nextExpected: "2026-10-20", periodDays: 30 })],
        settings: {
          ...SAMPLE_SNAPSHOT.settings,
          availableFloorMinor: 10000, // £100 floor
        },
      }),
    );
    const f = forecastFor("household")!;
    // £1,000 − 21 × £10 pace − £20 regular = £770, the low point
    // (the balance falls all month). Headroom £770 − £100 = £670 over
    // 3 remaining weeks → £223 a week, rounded down.
    expect(f.projectedEnd).toBeCloseTo(770, 6);
    expect(f.lowPoint.amount).toBeCloseTo(770, 6);
    expect(f.breach).toBeNull();
    expect(f.headroom).toBeCloseTo(670, 6);
    expect(f.perWeek).toBe(223);

    render(
      <PersonProvider>
        <Index />
      </PersonProvider>,
    );
    const card = screen.getByText(/Rest of October/).closest("section")!;
    expect(card.textContent).toMatch(
      /£670\.00 of headroom above your £100 floor at the tightest point — about £223 a week safe to spend/,
    );
  });

  it("scopes regulars and income to the view", () => {
    hydrateData(
      midOctober({
        accounts: [
          {
            name: "Revolut Main", owner: "zonito", last: "10 Oct", lastDate: "2026-10-10",
            added: 3, stale: false, balanceMinor: 100000, currency: "GBP",
            accountId: "Main", person: "zonito",
          },
          {
            name: "Monzo Current", owner: "nikhila", last: "10 Oct", lastDate: "2026-10-10",
            added: 2, stale: false, balanceMinor: 50000, currency: "GBP",
            accountId: "Current", person: "nikhila",
          },
        ],
        subs: [
          sub({ name: "His Sub", amount: 100, owner: "zonito", nextExpected: "2026-10-21", periodDays: 30 }),
          sub({ name: "Her Sub", amount: 300, owner: "nikhila", nextExpected: "2026-10-20", periodDays: 30 }),
        ],
        incomeRegulars: [
          { name: "Her Employer", amount: 2000, owner: "nikhila", nextExpected: "2026-10-28", periodDays: 30 },
        ],
      }),
    );
    expect(forecastFor("zonito")!.regularsOutTotal).toBe(100);
    expect(forecastFor("zonito")!.hasIncome).toBe(false);
    expect(forecastFor("nikhila")!.regularsOutTotal).toBe(300);
    expect(forecastFor("nikhila")!.regularsInTotal).toBe(2000);
    expect(forecastFor("household")!.regularsOutTotal).toBe(400);
    expect(forecastFor("household")!.regularsInTotal).toBe(2000);
  });

  it("no floor set: projection and low point, no safe-to-spend framing", () => {
    hydrateData(midOctober({}));
    const f = forecastFor("household")!;
    expect(f.floor).toBeNull();
    expect(f.headroom).toBeNull();
    expect(f.perWeek).toBeNull();
    expect(f.breach).toBeNull();
    expect(f.projectedEnd).toBeCloseTo(1000 - 21 * 10, 6);
  });

  it("a complete month reads as ended, at the Available figure", () => {
    hydrateData(midOctober({ latestDate: "2026-10-31" }));
    const f = forecastFor("household")!;
    expect(f.remainingDays).toBe(0);
    expect(f.projectedEnd).toBe(1000);
    expect(f.lowPoint).toEqual({ date: "2026-10-31", amount: 1000 });
    render(
      <PersonProvider>
        <Index />
      </PersonProvider>,
    );
    expect(screen.getByText(/is complete in your statements/)).toBeTruthy();
  });
});

describe("forecastIsStale", () => {
  it("turns stale only past seven days", () => {
    expect(forecastIsStale("2026-10-31", "2026-11-07")).toBe(false);
    expect(forecastIsStale("2026-10-31", "2026-11-08")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gated repro2: the composed forecast against SQL-derived figures.
// The fixture's latest month is complete (statements to 31 Oct), so
// the walk is the ended-month shape; the strength here is the pace
// and the start, re-derived from the store with plain SQL — category
// resolution and the one-off exclusion replicated in SQL, the cluster
// fingerprints taken from the snapshot's subs (the detector's output
// is an app fact; the detector itself is pinned by its own suite).
// ---------------------------------------------------------------------------

const DATA_DIR = process.env["CHITRAGUPTA_DATA_DIR"];
const BOTH_PEOPLE =
  !!DATA_DIR &&
  existsSync(
    join(DATA_DIR, "Originals", "account-statement_2023-02-01_2026-10-31_en-sg_f68986.csv"),
  );

describe.runIf(BOTH_PEOPLE)("forecast on the repro fixture (SQL-derived)", () => {
  let db: Database.Database;
  let storeDir: string;
  let fixtureSnap: DataSnapshot;

  beforeAll(async () => {
    const { openStore } = await import("@/lib/ingest/store");
    const { ingestAll, recomputeAggregates } = await import("@/lib/ingest/ingest");
    const { seedMerchantMemory } = await import("@/lib/ingest/merchants");
    const { buildSnapshot } = await import("@/lib/snapshot.server");
    storeDir = mkdtempSync(join(tmpdir(), "chitra-forecast-"));
    db = openStore(storeDir);
    ingestAll(db, DATA_DIR!);
    seedMerchantMemory(db);
    recomputeAggregates(db, "zonito");
    recomputeAggregates(db, "nikhila");
    recomputeAggregates(db, "household");
    process.env["CHITRAGUPTA_STORE_DIR"] = storeDir;
    fixtureSnap = buildSnapshot();
  }, 180_000);

  // The file-level afterEach re-hydrates the sample snapshot, so each
  // fixture test re-hydrates the real one first.
  beforeEach(() => {
    hydrateData(fixtureSnap);
  });

  afterAll(() => {
    db.close();
    rmSync(storeDir, { recursive: true, force: true });
  });

  /** Available per view from ingest_runs alone: each (person,
   * account)'s latest content-bearing run's GBP balance; a person's
   * view is their own accounts only (Joint is the household's). */
  function sqlAvailable(person: "household" | "zonito" | "nikhila"): number {
    const row = db
      .prepare(
        `SELECT SUM(balance_minor) AS total FROM ingest_runs
         WHERE id IN (SELECT MAX(id) FROM ingest_runs WHERE rows_seen > 0 GROUP BY person, account)
           AND currency = 'GBP' AND balance_minor IS NOT NULL
           AND substr(account, 1, 2) <> '__'
           ${person === "household" ? "" : person === "zonito" ? "AND person = 'zonito' AND account <> 'Joint'" : "AND person = 'nikhila'"}`,
      )
      .get() as { total: number };
    return row.total / 100;
  }

  it("the pace equals the SQL non-regular, non-one-off October rate", () => {
    const clusterIds = fixtureSnap.subs.flatMap((s) => s.chargeIds);
    const marks = clusterIds.map(() => "?").join(",");
    const row = db
      .prepare(
        `SELECT SUM(ABS(t.amount_minor)) AS total
         FROM transactions t LEFT JOIN merchant_memory m ON m.merchant = t.merchant
         WHERE t.movement = 'spend' AND t.currency = 'GBP'
           AND t.year_month = '2026-10'
           AND (CASE WHEN COALESCE(t.category, m.category) IN (SELECT name FROM categories)
                          OR COALESCE(t.category, m.category) IN ('Transfer', 'Moved aside')
                     THEN COALESCE(t.category, m.category) ELSE 'One-off' END) <> 'One-off'
           ${clusterIds.length ? `AND t.fingerprint NOT IN (${marks})` : ""}`,
      )
      .get(...clusterIds) as { total: number };
    const f = forecastFor("household")!;
    expect(f.paceDaily).toBeCloseTo(row.total / 100 / 31, 4);
  });

  it("start, projection and low point are the ended month's figures", () => {
    for (const person of ["household", "zonito", "nikhila"] as const) {
      const f = forecastFor(person)!;
      expect(f.start).toBeCloseTo(sqlAvailable(person), 6);
      expect(f.remainingDays).toBe(0);
      expect(f.projectedEnd).toBeCloseTo(f.start, 6);
      expect(f.lowPoint).toEqual({ date: "2026-10-31", amount: f.start });
      expect(f.regularsOutTotal).toBe(0);
      expect(f.regularsInTotal).toBe(0);
    }
  });

  it("detects no income stream: the fixture's frequent income amounts vary far beyond any monthly cluster", () => {
    // SHARMA L alone spans £100–£15,000 across 104 landings and Pro
    // Cashback £0.52–£69.17 across 55; no merchant holds a 7%-window
    // amount cluster on a monthly cadence, so the honest answer is
    // no detected stream (the detector is pinned synthetically above).
    expect(fixtureSnap.incomeRegulars).toEqual([]);
    expect(forecastFor("household")!.hasIncome).toBe(false);
  });
});
