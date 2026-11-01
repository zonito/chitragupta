import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { openStore } from "@/lib/ingest/store";
import { buildSnapshot } from "@/lib/snapshot.server";
import {
  currentMonthKey,
  flowWindowFor,
  hydrateData,
  type DataSnapshot,
  type Txn,
} from "@/lib/data";
import { forecastFor, paceFor } from "@/lib/forecast";
import { PersonProvider } from "@/components/shell";
import { DocumentsProvider } from "@/components/documents";
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
const { Activity } = await import("@/routes/activity");

/**
 * The display month: the app presents the Europe/London calendar
 * month once it has begun, even before any statement lands in it.
 * "Today" is pinned through CHITRAGUPTA_TODAY (the snapshot builder
 * and /api/accounts read it via calendar.server); data computations
 * stay anchored to the latest data month.
 *
 * The fixture store's data ends in October 2026 (latest date
 * 2026-10-30): a £3,000 salary landing monthly Jun–Oct (next due
 * 27 Nov), £100 of October groceries, one September spend, and a
 * £5,000 recorded balance. Scenario 1 pins today to 1 November;
 * scenario 2 pins it inside October, where every surface must
 * behave exactly as it did before the display month existed.
 */

const prevStore = process.env["CHITRAGUPTA_STORE_DIR"];
const prevToday = process.env["CHITRAGUPTA_TODAY"];
let dir: string | null = null;

function buildFixtureStore(): string {
  const d = mkdtempSync(join(tmpdir(), "chitra-display-"));
  const db = openStore(d);
  const insert = db.prepare(
    `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
       description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
     VALUES (?, 'zonito', 'Main', ?, ?, ?, ?, ?, 0, 'GBP', 0, ?, ?)`,
  );
  // Salary: £3,000 monthly, Jun–Oct 2026 (identical amounts, monthly
  // gaps — the cluster reading; next landing 27 Nov 2026).
  ["2026-06-29", "2026-07-29", "2026-08-28", "2026-09-28", "2026-10-28"].forEach(
    (day, i) =>
      insert.run(`sal${i}`, day, day.slice(0, 7), "ACME PAYROLL", "ACME PAYROLL", 300000, "income", "One-off"),
  );
  insert.run("sep1", "2026-09-15", "2026-09", "Ocado", "Ocado", -1000, "spend", "Groceries");
  insert.run("oct1", "2026-10-05", "2026-10", "Ocado", "Ocado", -6000, "spend", "Groceries");
  insert.run("oct2", "2026-10-20", "2026-10", "Ocado", "Ocado", -4000, "spend", "Groceries");
  // The store's latest row (30 Oct) is a moved-aside transfer, so the
  // October spend stays exactly £100 and the pace maths stays clean.
  insert.run("oct3", "2026-10-30", "2026-10", "Pocket", "Pocket", -2000, "aside", "Moved aside");
  const agg = db.prepare(
    `INSERT INTO month_aggregates (person, year_month, category, currency, spend_minor, income_minor, aside_minor, txn_count)
     VALUES ('zonito', ?, ?, 'GBP', ?, ?, ?, ?)`,
  );
  agg.run("2026-09", "Groceries", 1000, 0, 0, 1);
  agg.run("2026-09", "One-off", 0, 300000, 0, 1);
  agg.run("2026-10", "Groceries", 10000, 0, 0, 2);
  agg.run("2026-10", "One-off", 0, 300000, 0, 1);
  db.prepare(
    `INSERT INTO ingest_runs (person, account, started_at, rows_seen, rows_added, balance_minor, currency)
     VALUES ('zonito', 'Main', '2026-10-30T09:00:00.000Z', 9, 9, 500000, 'GBP')`,
  ).run();
  db.close();
  return d;
}

function snapshotAt(today: string): DataSnapshot {
  dir = buildFixtureStore();
  process.env["CHITRAGUPTA_STORE_DIR"] = dir;
  process.env["CHITRAGUPTA_TODAY"] = today;
  return buildSnapshot();
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  if (prevStore === undefined) delete process.env["CHITRAGUPTA_STORE_DIR"];
  else process.env["CHITRAGUPTA_STORE_DIR"] = prevStore;
  if (prevToday === undefined) delete process.env["CHITRAGUPTA_TODAY"];
  else process.env["CHITRAGUPTA_TODAY"] = prevToday;
  vi.unstubAllGlobals();
  hydrateData(SAMPLE_SNAPSHOT);
});

describe("scenario 1: today is 1 November, data ends in October", () => {
  it("the snapshot anchors presentation to November; the data stays in October", () => {
    const snap = snapshotAt("2026-11-01");
    expect(snap.monthKey).toBe("2026-11");
    expect(snap.months.map((m) => m.key)).toEqual([
      "2026-11", "2026-10", "2026-09", "2026-08", "2026-07", "2026-06",
    ]);
    expect(snap.months[0]!.label).toBe("November 2026");
    // Ingest stamps stay data-anchored.
    expect(snap.latestDate).toBe("2026-10-30");
    // The window is November + October: October's rows ride (spends,
    // the aside row, the salary as kind "income"); September's do not.
    expect(snap.txns.map((t) => t.id).sort()).toEqual(
      ["oct1", "oct2", "oct3", "sal4"].sort(),
    );
    expect(snap.txns.find((t) => t.id === "sal4")?.kind).toBe("income");
    // The Money-in feed summarises the display month: nothing yet.
    expect(snap.income).toEqual([]);
    // The monthly history extends to November as an honest zero month.
    expect(snap.monthly.months).toEqual(["2026-09", "2026-10", "2026-11"]);
    // Detection is data-anchored: the salary stream is found, and its
    // next landing falls inside November.
    expect(snap.incomeRegulars).toHaveLength(1);
    expect(snap.incomeRegulars[0]).toMatchObject({
      amount: 3000,
      nextExpected: "2026-11-27",
    });
  });

  it("Home shows November: £0 hero, the live forecast form, November's flow headline", () => {
    const snap = snapshotAt("2026-11-01");
    hydrateData(snap);
    expect(currentMonthKey()).toBe("2026-11");

    const forecast = forecastFor("household");
    expect(forecast).not.toBeNull();
    expect(forecast!.monthKey).toBe("2026-11");
    expect(forecast!.monthEnd).toBe("2026-11-30");
    expect(forecast!.asOf).toBe("2026-10-30");
    expect(forecast!.elapsedDays).toBe(0);
    expect(forecast!.remainingDays).toBe(30);
    // No November pace of its own: the rate is October's, steadied.
    expect(forecast!.paceBlended).toBe(true);
    // The walk spans the whole month and lands the salary in it:
    // £5,000 start + £3,000 salary − 31 days at (100/31)/2 ≈ £50.
    expect(forecast!.hasIncome).toBe(true);
    expect(forecast!.regularsInTotal).toBe(3000);
    expect(forecast!.series[forecast!.series.length - 1]!.date).toBe("2026-11-30");
    expect(forecast!.projectedEnd).toBeCloseTo(7950, 0);

    const flow = flowWindowFor("household");
    expect(flow[flow.length - 1]).toEqual({ month: "2026-11", income: 0, spend: 0, gap: 0 });
    // October remains fully itself behind it.
    expect(flow[flow.length - 2]).toEqual({ month: "2026-10", income: 3000, spend: 100, gap: 2900 });

    render(
      <PersonProvider>
        <Index />
      </PersonProvider>,
    );
    expect(screen.getByText("Spent in November")).toBeTruthy();
    expect(screen.getByText("Rest of November")).toBeTruthy();
    expect(screen.getByText(/On course to end November at/)).toBeTruthy();
    expect(screen.queryByText(/No regular income detected/)).toBeNull();
    const headline = screen.getByText(/In £0\.00/);
    expect(headline.textContent).toContain("In £0.00 · Out £0.00 · Gap +£0.00");
    // Both window bars carry their full figures: November empty,
    // October exactly as it was.
    expect(screen.getByText("November 2026: in £0.00, out £0.00, gap +£0.00")).toBeTruthy();
    expect(screen.getByText("October 2026: in £3,000.00, out £100.00, gap +£2,900.00")).toBeTruthy();
  });

  it("Activity defaults to November (empty, honest £0) with October still offered", async () => {
    const snap = snapshotAt("2026-11-01");
    hydrateData(snap);
    window.history.pushState({}, "", "/");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, transactions: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    render(
      <PersonProvider>
        <DocumentsProvider>
          <Activity />
        </DocumentsProvider>
      </PersonProvider>,
    );
    const period = screen.getByLabelText("Period") as HTMLSelectElement;
    expect(period.value).toBe("2026-11");
    expect([...period.options].map((o) => o.value)).toContain("2026-10");
    await waitFor(() =>
      expect(screen.getByTestId("listed-summary").textContent).toContain("November 2026"),
    );
    const summary = screen.getByTestId("listed-summary").textContent ?? "";
    expect(summary).toContain("£0.00 spent");
    expect(summary).toContain("0 transactions");
  });
});

describe("scenario 2: today pinned inside the latest data month", () => {
  it("the snapshot is exactly the pre-change one", () => {
    const snap = snapshotAt("2026-10-15");
    expect(snap.monthKey).toBe("2026-10");
    expect(snap.months.map((m) => m.key)).toEqual([
      "2026-10", "2026-09", "2026-08", "2026-07", "2026-06",
    ]);
    // Window = October + September, as before the display month.
    expect(snap.txns.map((t) => t.id).sort()).toEqual(
      ["oct1", "oct2", "oct3", "sal3", "sal4", "sep1"].sort(),
    );
    // The Money-in feed is October's, as before.
    expect(snap.income).toHaveLength(1);
    expect(snap.income[0]).toMatchObject({ day: 28, amount: 3000, type: "Salary" });
    expect(snap.monthly.months).toEqual(["2026-09", "2026-10"]);

    hydrateData(snap);
    const forecast = forecastFor("household");
    expect(forecast!.monthKey).toBe("2026-10");
    // The data ends 30 Oct: 30 elapsed days, 1 remaining — exactly
    // what the pre-change forecast computed for this store.
    expect(forecast!.elapsedDays).toBe(30);
    expect(forecast!.remainingDays).toBe(1);
  });
});

describe("paceFor with a month the data has not reached", () => {
  const spendRow = (
    id: string,
    monthKey: string,
    day: number,
    amount: number,
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
  });
  const october = [spendRow("a", "2026-10", 5, 60), spendRow("b", "2026-10", 20, 40)];

  it("zero elapsed days fall back to the previous complete month's pace, blended", () => {
    const pace = paceFor("household", "2026-11", "2026-10-30", october, new Set());
    expect(pace.elapsedDays).toBe(0);
    expect(pace.remainingDays).toBe(30);
    expect(pace.blended).toBe(true);
    expect(pace.dailyRate).toBeCloseTo(100 / 31 / 2, 6);
  });

  it("a mid-month asOf behaves exactly as before", () => {
    const pace = paceFor("household", "2026-10", "2026-10-30", october, new Set());
    expect(pace.elapsedDays).toBe(30);
    expect(pace.remainingDays).toBe(1);
    expect(pace.blended).toBe(false);
    expect(pace.dailyRate).toBeCloseTo(100 / 30, 6);
  });
});
