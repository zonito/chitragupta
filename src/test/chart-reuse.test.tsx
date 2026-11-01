import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PersonProvider, usePerson } from "@/components/shell";
import { gbp, hydrateData, monthlyHistoryFor } from "@/lib/data";
import { monthlyBuckets, subscriptionMonthlyRows } from "@/lib/timeline";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-router")>(
    "@tanstack/react-router",
  );
  return {
    ...actual,
    useRouter: () => ({ invalidate: async () => {} }),
    Link: ({
      to,
      children,
      className,
    }: {
      to: string;
      children: React.ReactNode;
      className?: string;
    }) => (
      <a href={to} className={className}>
        {children}
      </a>
    ),
  };
});

// Imported after the router mock is registered.
const { Index } = await import("@/routes/index");
const { Subs } = await import("@/routes/subscriptions");

/**
 * The timeline chart is ONE shared component: the same section (same
 * presets, colours, isolate/readout interaction) appears on Home as a
 * compact spend trend and on Subscriptions as the recurring-cost trend
 * over the detector's charge history. These tests pin both placements
 * and one figure per placement.
 */

afterEach(() => {
  hydrateData(SAMPLE_SNAPSHOT);
});

function ViewSwitch() {
  const { setPerson } = usePerson();
  return (
    <>
      <button type="button" onClick={() => setPerson("zonito")}>
        View as Zonito
      </button>
      <button type="button" onClick={() => setPerson("nikhila")}>
        View as Nikhila
      </button>
    </>
  );
}

describe("Home spend trend (shared chart, compact)", () => {
  it("renders under the summary with the full preset set and snapshot figures", () => {
    render(
      <PersonProvider>
        <Index />
      </PersonProvider>,
    );
    expect(screen.getByText("Spending trend")).toBeTruthy();
    for (const label of ["Daily", "Monthly", "Quarterly", "YTD", "1Y", "All"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
    // Figure check: the active bucket readout is the snapshot monthly
    // history's October 2026 household total — the same figure the
    // Categories chart shows for the same bucket.
    const monthly = monthlyHistoryFor("household");
    const octIdx = monthly.months.indexOf("2026-10");
    const octTotal = monthly.rows.reduce(
      (s, r) => s + (r.series[octIdx] ?? 0),
      0,
    );
    expect(
      screen.getByText(new RegExp(`October 2026 — ${gbp(octTotal)}`)),
    ).toBeTruthy();
  });

  it("isolates a category exactly like the Categories chart", () => {
    render(
      <PersonProvider>
        <Index />
      </PersonProvider>,
    );
    const legend = screen.getByRole("button", { name: /Groceries · £/ });
    fireEvent.click(legend);
    expect(legend.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/on Groceries/)).toBeTruthy();
  });
});

describe("Subscriptions recurring-cost trend (shared chart)", () => {
  const renderSubs = () =>
    render(
      <PersonProvider>
        <ViewSwitch />
        <Subs />
      </PersonProvider>,
    );

  it("renders with the monthly-family presets (no Daily: charges have no day level in the snapshot)", () => {
    renderSubs();
    expect(screen.getByText("Recurring cost over time")).toBeTruthy();
    for (const label of ["Monthly", "Quarterly", "YTD", "1Y", "All"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
    expect(screen.queryByRole("button", { name: "Daily" })).toBeNull();
  });

  it("October 2026 household total is the active subs' charges that month", () => {
    renderSubs();
    // From the fixture itself: every active sub's chargeMonths summed
    // over 2026-10 (the six monthly subs; the yearly ones charge in
    // March/June).
    const expected = SAMPLE_SNAPSHOT.subs
      .filter((s) => s.status === "Active")
      .flatMap((s) => s.chargeMonths ?? [])
      .filter((cm) => cm.month === "2026-10")
      .reduce((sum, cm) => sum + cm.total, 0);
    expect(expected).toBeCloseTo(118.95, 2);
    expect(
      screen.getByText(new RegExp(`October 2026 — ${gbp(expected)}`)),
    ).toBeTruthy();
    // The builder the screen uses agrees, and the legend carries the
    // window total in text.
    const rows = subscriptionMonthlyRows("household");
    const windowTotal = monthlyBuckets(rows, 12).reduce(
      (s, b) => s + b.total,
      0,
    );
    expect(
      screen.getByRole("button", {
        name: `Subscriptions · ${gbp(windowTotal)}`,
      }),
    ).toBeTruthy();
  });

  it("follows the person switch: Nikhila's October is her three monthly subs", () => {
    renderSubs();
    fireEvent.click(screen.getByRole("button", { name: "View as Nikhila" }));
    // PureGym 34.99 + iCloud+ 8.99 + Disney+ 9.99.
    expect(screen.getByText(/October 2026 — £53\.97/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View as Zonito" }));
    // Netflix 18.99 + Spotify Family 19.99 + The Times 26.
    expect(screen.getByText(/October 2026 — £64\.98/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------
// repro2: chargeMonths on the real store come from the detector's own
// cluster charges (Tesla £9.99 monthly is the known pattern).

const DATA_DIR = process.env["CHITRAGUPTA_DATA_DIR"]?.trim() || null;
const HER_CURRENT = "account-statement_2023-02-01_2026-10-31_en-sg_f68986.csv";
const HAS_HER_FILES = Boolean(
  DATA_DIR && existsSync(join(DATA_DIR, "Originals", HER_CURRENT)),
);
const describeRepro2 = HAS_HER_FILES ? describe : describe.skip;

describeRepro2("Subscription chargeMonths on the real store (repro2)", () => {
  const storeDir = mkdtempSync(join(tmpdir(), "chitra-subs-store-"));
  const prevStoreEnv = process.env["CHITRAGUPTA_STORE_DIR"];
  let built: ReturnType<typeof import("@/lib/snapshot.server").buildSnapshot>;

  beforeAll(async () => {
    process.env["CHITRAGUPTA_STORE_DIR"] = storeDir;
    const { openStore } = await import("@/lib/ingest/store");
    const { ingestAll } = await import("@/lib/ingest/ingest");
    const db = openStore(storeDir);
    ingestAll(db, DATA_DIR!);
    db.close();
    const { buildSnapshot } = await import("@/lib/snapshot.server");
    built = buildSnapshot();
  }, 240_000);

  afterAll(() => {
    if (prevStoreEnv === undefined) delete process.env["CHITRAGUPTA_STORE_DIR"];
    else process.env["CHITRAGUPTA_STORE_DIR"] = prevStoreEnv;
    hydrateData(SAMPLE_SNAPSHOT);
  });

  it("Tesla's chargeMonths are its 19 cluster charges, Apr 2025 – Oct 2026", () => {
    const tesla = built.subs.find((s) => s.name === "Tesla");
    expect(tesla).toBeTruthy();
    const months = tesla!.chargeMonths ?? [];
    expect(months).toHaveLength(19);
    expect(months[0]!.month).toBe("2025-04");
    expect(months[months.length - 1]).toEqual({
      month: "2026-10",
      total: 9.99,
    });
    // 18 charges at £9.99 and one at £9.84 (verified from the raw CSVs).
    const total = months.reduce((s, cm) => s + cm.total, 0);
    expect(total).toBeCloseTo(18 * 9.99 + 9.84, 2);
    expect(months.every((cm) => cm.total === 9.99 || cm.total === 9.84)).toBe(
      true,
    );
    // And the count still matches the sub's own charge count.
    expect(months.reduce((s, cm) => s + cm.total, 0)).toBeGreaterThan(0);
    expect(tesla!.charges).toBe(19);
  });

  it("the trend builder's October 2026 household total equals the sum over active subs", () => {
    hydrateData(built);
    const rows = subscriptionMonthlyRows("household");
    const octIdx = rows.months.indexOf("2026-10");
    expect(octIdx).toBeGreaterThanOrEqual(0);
    const fromBuilder = rows.rows[0]!.series[octIdx]!;
    const direct = built.subs
      .filter((s) => s.status === "Active")
      .flatMap((s) => s.chargeMonths ?? [])
      .filter((cm) => cm.month === "2026-10")
      .reduce((sum, cm) => sum + cm.total, 0);
    expect(fromBuilder).toBeCloseTo(direct, 6);
    expect(direct).toBeGreaterThan(0);
  });
});
