import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Activity } from "@/routes/activity";
import { PersonProvider } from "@/components/shell";
import { DocumentsProvider } from "@/components/documents";
import { hydrateData, type DataSnapshot, type Txn } from "@/lib/data";
import { SAMPLE_SNAPSHOT, SAMPLE_TXNS } from "@/test/fixtures";
import { openStore } from "@/lib/ingest/store";
import { buildSnapshot } from "@/lib/snapshot.server";
import { apiTxnToTxn, timeOfDayFull, type ApiTxnRow } from "@/lib/txn-map";

/**
 * Exact time in Activity, list and sheet: the list shows the recorded
 * HH:MM, the sheet shows HH:MM:SS, and date-only rows (a midnight
 * stamp is the placeholder, e.g. every Barclays row) show no time
 * anywhere — for snapshot months and /api/transactions months alike.
 */

describe("timeOfDayFull", () => {
  it("extracts HH:MM:SS from space- and T-separated timestamps", () => {
    expect(timeOfDayFull("2026-11-01 07:43:28")).toBe("07:43:28");
    expect(timeOfDayFull("2026-10-23T14:32:05")).toBe("14:32:05");
  });

  it("a bare date, an HH:MM-only stamp and the 00:00:00 placeholder carry no full time", () => {
    expect(timeOfDayFull("2026-10-23")).toBeUndefined();
    expect(timeOfDayFull("2026-10-23 23:59")).toBeUndefined();
    expect(timeOfDayFull("2026-10-23 00:00:00")).toBeUndefined();
    expect(timeOfDayFull("2026-10-23T00:00:00")).toBeUndefined();
  });

  it("a genuine just-after-midnight stamp (00:00:29) is a real time", () => {
    expect(timeOfDayFull("2026-11-01 00:00:29")).toBe("00:00:29");
  });
});

const apiRow = (over: Partial<ApiTxnRow>): ApiTxnRow => ({
  id: "fp1",
  person: "zonito",
  account: "Main",
  date: "2026-11-01 07:43:28",
  month: "2026-11",
  description: "Timed Shop",
  merchant: "Timed Shop",
  amountMinor: -1000,
  currency: "GBP",
  movement: "spend",
  category: "Groceries",
  ...over,
});

describe("apiTxnToTxn full time", () => {
  it("a timestamped row maps HH:MM for the list and HH:MM:SS for the sheet", () => {
    const txn = apiTxnToTxn(apiRow({}));
    expect(txn?.time).toBe("07:43");
    expect(txn?.timeFull).toBe("07:43:28");
  });

  it("a midnight row maps neither", () => {
    const txn = apiTxnToTxn(apiRow({ date: "2026-11-01 00:00:00" }));
    expect(txn?.time).toBeUndefined();
    expect(txn?.timeFull).toBeUndefined();
  });
});

describe("snapshot builder full time", () => {
  let dir: string | null = null;
  const prevEnv = process.env["CHITRAGUPTA_STORE_DIR"];

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
    if (prevEnv === undefined) delete process.env["CHITRAGUPTA_STORE_DIR"];
    else process.env["CHITRAGUPTA_STORE_DIR"] = prevEnv;
  });

  it("snapshot txns carry the same time and timeFull the API mapper produces", () => {
    dir = mkdtempSync(join(tmpdir(), "chitragupta-timefull-"));
    const db = openStore(dir);
    const insert = db.prepare(
      `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
         description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
       VALUES (?, 'zonito', 'Main', ?, ?, ?, ?, ?, 0, 'GBP', 0, 'spend', NULL)`,
    );
    insert.run("timed", "2026-10-05 07:43:28", "2026-10", "Timed Shop", "Timed Shop", -1000);
    insert.run("midnight", "2026-10-06 00:00:00", "2026-10", "Midnight Shop", "Midnight Shop", -2000);
    insert.run("plain", "2026-10-07", "2026-10", "Plain Shop", "Plain Shop", -3000);
    db.prepare(
      `INSERT INTO ingest_runs (account, started_at, rows_seen, rows_added) VALUES ('Main', '2026-10-30T09:00:00.000Z', 3, 3)`,
    ).run();
    db.close();

    process.env["CHITRAGUPTA_STORE_DIR"] = dir;
    const snap = buildSnapshot();
    const timed = snap.txns.find((t) => t.id === "timed");
    expect(timed?.time).toBe("07:43");
    expect(timed?.timeFull).toBe("07:43:28");
    for (const id of ["midnight", "plain"]) {
      const txn = snap.txns.find((t) => t.id === id);
      expect(txn?.time).toBeUndefined();
      expect(txn?.timeFull).toBeUndefined();
    }
  });
});

const mkTxn = (over: Partial<Txn>): Txn => ({
  id: "x",
  date: "2026-10-23",
  day: 23,
  monthKey: "2026-10",
  merchant: "Timed Shop",
  category: "Groceries",
  amount: 10,
  owner: "zonito",
  account: "Revolut Main · Zonito",
  accountId: "Main",
  kind: "spend",
  ...over,
});

function renderWith(txns: Txn[]) {
  const snap = structuredClone(SAMPLE_SNAPSHOT) as DataSnapshot;
  snap.txns = txns;
  hydrateData(snap);
  return render(
    <PersonProvider>
      <DocumentsProvider>
        <Activity />
      </DocumentsProvider>
    </PersonProvider>,
  );
}

beforeEach(() => {
  hydrateData(SAMPLE_SNAPSHOT);
  window.history.pushState({}, "", "/");
});

afterEach(() => {
  vi.unstubAllGlobals();
  hydrateData(SAMPLE_SNAPSHOT);
});

describe("Activity list + sheet time (snapshot month)", () => {
  it("a timed row shows HH:MM in the list and HH:MM:SS in the sheet", async () => {
    renderWith([mkTxn({ id: "timed", time: "07:43", timeFull: "07:43:28" })]);
    const row = screen.getByText("Timed Shop").closest("button")!;
    expect(within(row).getByText("07:43")).toBeTruthy();
    expect(row.textContent).not.toContain("07:43:28");
    fireEvent.click(row);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Friday 23 October · 07:43:28/)).toBeTruthy();
  });

  it("a date-only row shows no time in the list or the sheet", async () => {
    renderWith([mkTxn({ id: "plain", merchant: "Plain Shop" })]);
    const row = screen.getByText("Plain Shop").closest("button")!;
    expect(row.textContent).not.toMatch(/\d{2}:\d{2}/);
    fireEvent.click(row);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Friday 23 October/)).toBeTruthy();
    expect(dialog.textContent).not.toContain("00:00");
    expect(dialog.textContent).not.toMatch(/October ·/);
  });
});

describe("Activity list + sheet time (fetched month)", () => {
  const augRow = (over: Partial<ApiTxnRow>): ApiTxnRow => ({
    id: "fp-aug-1",
    person: "zonito",
    account: "Main",
    date: "2026-08-03 07:43:28",
    month: "2026-08",
    description: "Fetched Timed Shop",
    merchant: "Fetched Timed Shop",
    amountMinor: -1000,
    currency: "GBP",
    movement: "spend",
    category: "Groceries",
    ...over,
  });

  const renderFetched = (rows: ApiTxnRow[]) => {
    hydrateData({
      ...SAMPLE_SNAPSHOT,
      months: [
        { key: "2026-10", label: "October 2026" },
        { key: "2026-08", label: "August 2026" },
      ],
      txns: [...SAMPLE_TXNS],
    });
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      json: async () => ({ ok: true, count: rows.length, transactions: rows }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <PersonProvider>
        <DocumentsProvider>
          <Activity />
        </DocumentsProvider>
      </PersonProvider>,
    );
    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "2026-08" } });
  };

  it("a fetched timed row shows HH:MM in the list and HH:MM:SS in the sheet", async () => {
    renderFetched([augRow({})]);
    const timedRow = (await screen.findByText("Fetched Timed Shop")).closest("button")!;
    expect(within(timedRow).getByText("07:43")).toBeTruthy();
    expect(timedRow.textContent).not.toContain("07:43:28");
    fireEvent.click(timedRow);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/3 August · 07:43:28/)).toBeTruthy();
  });

  it("a fetched midnight row shows no time in the list or the sheet", async () => {
    renderFetched([
      augRow({
        id: "fp-aug-2",
        date: "2026-08-04 00:00:00",
        description: "Fetched Midnight Shop",
        merchant: "Fetched Midnight Shop",
      }),
    ]);
    const midnightRow = (await screen.findByText("Fetched Midnight Shop")).closest("button")!;
    expect(midnightRow.textContent).not.toMatch(/\d{2}:\d{2}/);
    fireEvent.click(midnightRow);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/4 August/)).toBeTruthy();
    expect(dialog.textContent).not.toContain("00:00");
    expect(dialog.textContent).not.toMatch(/August ·/);
  });
});
