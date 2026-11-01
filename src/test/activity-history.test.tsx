import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Activity } from "@/routes/activity";
import { PersonProvider } from "@/components/shell";
import { DocumentsProvider } from "@/components/documents";
import { hydrateData, type Txn } from "@/lib/data";
import { SAMPLE_SNAPSHOT, SAMPLE_TXNS } from "@/test/fixtures";
import type { ApiTxnRow } from "@/lib/txn-map";

/**
 * Activity's month picker lists every month in the store. Months inside
 * the snapshot window render from memory; an older month is fetched from
 * /api/transactions and rendered with the same list and subtotal.
 */

const sepTxn: Txn = {
  ...SAMPLE_TXNS[0]!,
  id: "sep-1",
  date: "2026-09-15",
  day: 15,
  monthKey: "2026-09",
  merchant: "September Shop",
};

const augRow = (over: Partial<ApiTxnRow>): ApiTxnRow => ({
  id: "fp-aug-1",
  person: "zonito",
  account: "Main",
  date: "2026-08-03",
  month: "2026-08",
  description: "Mahavir Sweet Mart",
  merchant: "Mahavir Sweet Mart",
  amountMinor: -2710,
  currency: "GBP",
  movement: "spend",
  category: "Groceries",
  ...over,
});

beforeEach(() => {
  hydrateData({
    ...SAMPLE_SNAPSHOT,
    months: [
      { key: "2026-10", label: "October 2026" },
      { key: "2026-09", label: "September 2026" },
      { key: "2026-08", label: "August 2026" },
    ],
    txns: [...SAMPLE_TXNS, sepTxn],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  hydrateData(SAMPLE_SNAPSHOT);
});

describe("Activity older months", () => {
  it("fetches and renders a month outside the snapshot window", async () => {
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      json: async () => ({
        ok: true,
        count: 2,
        transactions: [
          augRow({ id: "fp-aug-1" }),
          augRow({ id: "fp-aug-2", date: "2026-08-21", amountMinor: -1200 }),
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(
      <PersonProvider>
        <DocumentsProvider>
          <Activity />
        </DocumentsProvider>
      </PersonProvider>,
    );

    // Snapshot months render without any fetch.
    expect(screen.getAllByText("Ocado").length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();

    const monthSelect = screen.getByLabelText("Period");
    fireEvent.change(monthSelect, { target: { value: "2026-08" } });

    expect(await screen.findAllByText("Mahavir Sweet Mart")).toHaveLength(2);
    // Header total and the listed-total summary both carry the
    // fetched month's figure (the list is unfiltered).
    expect(await screen.findAllByText(/£39\.10 spent/)).toHaveLength(2);
    expect(fetchMock.mock.calls[0]![0]).toContain("month=2026-08");
  });

  it("orders rows newest-first within a day, the same for snapshot and fetched months", async () => {
    // Snapshot month: the builder now produces rows newest-first, and
    // Activity's stable date sort must preserve that within the day.
    hydrateData({
      ...SAMPLE_SNAPSHOT,
      months: [
        { key: "2026-10", label: "October 2026" },
        { key: "2026-09", label: "September 2026" },
        { key: "2026-08", label: "August 2026" },
      ],
      txns: [
        {
          ...sepTxn,
          id: "oct-late",
          date: "2026-10-10",
          day: 10,
          monthKey: "2026-10",
          merchant: "Later Shop",
        },
        {
          ...sepTxn,
          id: "oct-early",
          date: "2026-10-10",
          day: 10,
          monthKey: "2026-10",
          merchant: "Earlier Shop",
        },
        {
          ...sepTxn,
          id: "oct-prev",
          date: "2026-10-09",
          day: 9,
          monthKey: "2026-10",
          merchant: "Previous Day Shop",
        },
      ],
    });
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      json: async () => ({
        ok: true,
        count: 2,
        transactions: [
          augRow({
            id: "fp-aug-late",
            date: "2026-08-03",
            merchant: "Aug Later",
            description: "Aug Later",
          }),
          augRow({
            id: "fp-aug-early",
            date: "2026-08-03",
            merchant: "Aug Earlier",
            description: "Aug Earlier",
          }),
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(
      <PersonProvider>
        <DocumentsProvider>
          <Activity />
        </DocumentsProvider>
      </PersonProvider>,
    );
    const text = () => container.textContent ?? "";
    expect(text().indexOf("Later Shop")).toBeLessThan(
      text().indexOf("Earlier Shop"),
    );
    expect(text().indexOf("Earlier Shop")).toBeLessThan(
      text().indexOf("Previous Day Shop"),
    );

    const monthSelect = screen.getByLabelText("Period");
    fireEvent.change(monthSelect, { target: { value: "2026-08" } });
    expect(await screen.findByText("Aug Later")).toBeTruthy();
    expect(text().indexOf("Aug Later")).toBeLessThan(
      text().indexOf("Aug Earlier"),
    );
  });

  it("renders a snapshot-window month without fetching", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(
      <PersonProvider>
        <DocumentsProvider>
          <Activity />
        </DocumentsProvider>
      </PersonProvider>,
    );
    const monthSelect = screen.getByLabelText("Period");
    fireEvent.change(monthSelect, { target: { value: "2026-09" } });
    expect(screen.getByText("September Shop")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
