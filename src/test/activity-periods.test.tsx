import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type Database from "better-sqlite3";

// Activity's on-demand fetcher, spied: canned rows for a September
// month the snapshot does not carry, plus a duplicate of the snapshot
// October row (same fingerprint) to prove the merge dedupes.
const mocks = vi.hoisted(() => ({
  fetchTxns: vi.fn(
    async (_params: Record<string, string>): Promise<import("@/lib/data").Txn[]> => [],
  ),
}));
vi.mock("@/lib/txn-map", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/txn-map")>();
  return { ...actual, fetchApiTransactions: mocks.fetchTxns };
});

import { Activity } from "@/routes/activity";
import { PersonProvider } from "@/components/shell";
import { DocumentsProvider } from "@/components/documents";
import { hydrateData, shareOf, type DataSnapshot, type Txn } from "@/lib/data";
import { apiTxnToTxn, type ApiTxnRow } from "@/lib/txn-map";
import { monthsBetween, rangeForPreset } from "@/lib/periods";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";

/**
 * Follow-up 6: Activity period presets — This quarter / Year to date /
 * Last 12 months, anchored to the store's latest data month. A preset
 * lists the whole range (snapshot months merged with one from/to
 * fetch, fingerprint-keyed, no duplicates) and the header total sums
 * the whole range.
 */

describe("rangeForPreset", () => {
  it("anchors to the store's latest month (Oct 2026 fixture)", () => {
    expect(rangeForPreset("quarter", "2026-10")).toEqual({
      from: "2026-10",
      to: "2026-10",
      months: ["2026-10"],
    });
    const ytd = rangeForPreset("ytd", "2026-10");
    expect(ytd.from).toBe("2026-01");
    expect(ytd.months).toHaveLength(10);
    const last12 = rangeForPreset("last12", "2026-10");
    expect(last12.from).toBe("2025-11");
    expect(last12.months).toHaveLength(12);
    expect(last12.months[11]).toBe("2026-10");
  });

  it("handles a mid-year anchor: quarter boundaries and year crossing", () => {
    expect(rangeForPreset("quarter", "2026-05").months).toEqual(["2026-04", "2026-05"]);
    expect(rangeForPreset("quarter", "2026-03").months).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
    ]);
    expect(rangeForPreset("ytd", "2026-05").months).toHaveLength(5);
    expect(rangeForPreset("last12", "2026-05").from).toBe("2025-06");
    expect(monthsBetween("2026-11", "2027-02")).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
  });
});

const mkTxn = (over: Partial<Txn>): Txn => ({
  id: "x",
  date: "2026-10-20",
  day: 20,
  monthKey: "2026-10",
  merchant: "M",
  category: "Groceries",
  amount: 10,
  owner: "zonito",
  account: "Revolut Main · Zonito",
  accountId: "Main",
  kind: "spend",
  ...over,
});

const CANNED: Txn[] = [
  mkTxn({
    id: "sep-1",
    merchant: "September Shop",
    amount: 50,
    date: "2026-09-15",
    day: 15,
    monthKey: "2026-09",
  }),
  // The same fingerprint as the snapshot's October row: the range
  // fetch returns it too, and the merge must keep exactly one copy.
  mkTxn({ id: "oct-1", merchant: "October Shop", amount: 100 }),
];

beforeEach(() => {
  const snap = structuredClone(SAMPLE_SNAPSHOT) as DataSnapshot;
  snap.txns = [mkTxn({ id: "oct-1", merchant: "October Shop", amount: 100 })];
  hydrateData(snap);
  localStorage.clear();
  mocks.fetchTxns.mockClear();
  mocks.fetchTxns.mockImplementation(async (params: Record<string, string>) => {
    if (params["from"] && params["to"]) {
      return CANNED.filter(
        (t) => t.monthKey >= params["from"]! && t.monthKey <= params["to"]!,
      );
    }
    if (params["month"]) return CANNED.filter((t) => t.monthKey === params["month"]);
    return [];
  });
});

function renderActivity() {
  return render(
    <PersonProvider>
      <DocumentsProvider>
        <Activity />
      </DocumentsProvider>
    </PersonProvider>,
  );
}

describe("Activity period presets", () => {
  it("Last 12 months merges snapshot + fetched months without duplicates and sums the range", async () => {
    renderActivity();
    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "preset:last12" } });
    await waitFor(() =>
      expect(mocks.fetchTxns).toHaveBeenCalledWith({
        from: "2025-11",
        to: "2026-10",
        limit: "10000",
      }),
    );
    expect(await screen.findByText("September Shop")).toBeTruthy();
    // The duplicated October row renders once, and the header total
    // is the whole range: £100 (Oct) + £50 (Sep), not £250.
    expect(screen.getAllByText("October Shop")).toHaveLength(1);
    expect(screen.getByText(/£150\.00 spent/)).toBeTruthy();
  });

  it("This quarter for an October anchor covers October only", async () => {
    renderActivity();
    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "preset:quarter" } });
    await waitFor(() =>
      expect(mocks.fetchTxns).toHaveBeenCalledWith({
        from: "2026-10",
        to: "2026-10",
        limit: "10000",
      }),
    );
    expect(await screen.findByText("October Shop")).toBeTruthy();
    expect(screen.queryByText("September Shop")).toBeNull();
    expect(screen.getByText(/£100\.00 spent/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Gated repro2: a preset's listed total (shareOf-weighted spend over
// the mapped rows, exactly the component's maths) computed from the
// range response equals the sum of the per-month responses, for the
// household view and for Zonito's view; the range has no duplicates.
// ---------------------------------------------------------------------------

const DATA_DIR = process.env["CHITRAGUPTA_DATA_DIR"];
const BOTH_PEOPLE =
  !!DATA_DIR &&
  existsSync(
    join(DATA_DIR, "Originals", "account-statement_2023-02-01_2026-10-31_en-sg_f68986.csv"),
  );

describe.runIf(BOTH_PEOPLE)("Activity presets (repro2, API totals)", () => {
  let db: Database.Database;
  let storeDir: string;
  let api: (req: Request) => Promise<Response | null>;

  const fetchRows = async (qs: string): Promise<Txn[]> => {
    const res = await api(new Request(`http://test/api/transactions?${qs}`));
    const body = (await res!.json()) as { transactions: ApiTxnRow[] };
    return body.transactions
      .map(apiTxnToTxn)
      .filter((t): t is Txn => t !== null);
  };
  const listedTotal = (rows: Txn[], person: "household" | "zonito"): number =>
    rows
      .filter((t) => t.kind === "spend")
      .reduce((s, t) => s + shareOf(t, person), 0);

  beforeAll(async () => {
    const { openStore } = await import("@/lib/ingest/store");
    const { ingestAll } = await import("@/lib/ingest/ingest");
    const { handleChitraguptaApi } = await import("@/lib/api");
    api = handleChitraguptaApi as typeof api;
    storeDir = mkdtempSync(join(tmpdir(), "chitra-periods-"));
    db = openStore(storeDir);
    ingestAll(db, DATA_DIR!);
    process.env["CHITRAGUPTA_STORE_DIR"] = storeDir;
  }, 180_000);

  afterAll(() => {
    db.close();
    rmSync(storeDir, { recursive: true, force: true });
  });

  it("Last 12 months total equals the sum of the per-month totals (household and Zonito)", async () => {
    const { from, to, months } = rangeForPreset("last12", "2026-10");
    const rangeRows = await fetchRows(`from=${from}&to=${to}&limit=10000`);
    expect(new Set(rangeRows.map((t) => t.id)).size).toBe(rangeRows.length);
    expect(new Set(rangeRows.map((t) => t.monthKey))).toEqual(new Set(months));

    for (const person of ["household", "zonito"] as const) {
      let monthlySum = 0;
      for (const m of months) {
        monthlySum += listedTotal(await fetchRows(`month=${m}&limit=1000`), person);
      }
      const rangeTotal = listedTotal(rangeRows, person);
      expect(rangeTotal).toBeGreaterThan(0);
      expect(rangeTotal).toBeCloseTo(monthlySum, 6);
    }
  });

  it("This quarter (Oct 2026) covers October only and matches the month total", async () => {
    const { from, to, months } = rangeForPreset("quarter", "2026-10");
    expect(months).toEqual(["2026-10"]);
    const rangeRows = await fetchRows(`from=${from}&to=${to}&limit=10000`);
    const monthRows = await fetchRows("month=2026-10&limit=1000");
    expect(listedTotal(rangeRows, "household")).toBeCloseTo(
      listedTotal(monthRows, "household"),
      6,
    );
    // The known household October figure for this fixture.
    expect(listedTotal(rangeRows, "household")).toBeCloseTo(2102.39, 6);
  });
});
