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

    const monthSelect = container.querySelectorAll("select")[2]!;
    fireEvent.change(monthSelect, { target: { value: "2026-08" } });

    expect(await screen.findAllByText("Mahavir Sweet Mart")).toHaveLength(2);
    expect(await screen.findByText(/£39\.10 spent/)).toBeTruthy();
    expect(fetchMock.mock.calls[0]![0]).toContain("month=2026-08");
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
    const monthSelect = container.querySelectorAll("select")[2]!;
    fireEvent.change(monthSelect, { target: { value: "2026-09" } });
    expect(screen.getByText("September Shop")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
