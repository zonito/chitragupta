import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AskButton, PersonProvider } from "@/components/shell";
import { DocumentsProvider } from "@/components/documents";
import { hydrateData } from "@/lib/data";
import { SAMPLE_SNAPSHOT, SAMPLE_TXNS } from "@/test/fixtures";
import type { ApiTxnRow } from "@/lib/txn-map";

/**
 * Ask's records search reads only the current month from the snapshot;
 * these tests exercise the full-history path: the component fetches
 * matching rows from /api/transactions and searches those instead.
 */

const apiRow = (over: Partial<ApiTxnRow>): ApiTxnRow => ({
  id: "fp-1",
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

// The component also POSTs every submit to /api/ask; these stubs make
// that endpoint fail so the tests exercise the deterministic path, which
// is the fallback the endpoint failure is designed to leave in place.
const ASK_DOWN = { ok: false, status: 503, json: async () => ({}) };

function stubTransactions(rows: ApiTxnRow[]) {
  const fetchMock = vi.fn(async (url: string) =>
    String(url).includes("/api/ask")
      ? ASK_DOWN
      : {
          ok: true,
          json: async () => ({ ok: true, count: rows.length, transactions: rows }),
        },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubTransactionsDeferred(rows: ApiTxnRow[]) {
  let release: ((value: unknown) => void) | undefined;
  const fetchMock = vi.fn((url: string) =>
    String(url).includes("/api/ask")
      ? Promise.resolve(ASK_DOWN)
      : new Promise((resolve) => {
          release = resolve;
        }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    resolve: () =>
      release?.({
        ok: true,
        json: async () => ({ ok: true, count: rows.length, transactions: rows }),
      }),
  };
}

function renderAsk() {
  render(
    <PersonProvider>
      <DocumentsProvider>
        <AskButton />
      </DocumentsProvider>
    </PersonProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /Ask/ }));
}

beforeEach(() => {
  hydrateData(SAMPLE_SNAPSHOT);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Ask full-history record search", () => {
  it("finds a merchant last paid before the snapshot months", async () => {
    const deferred = stubTransactionsDeferred([
      apiRow({ id: "fp-aug" }),
      apiRow({ id: "fp-may", date: "2026-05-11", month: "2026-05", amountMinor: -1800 }),
    ]);
    renderAsk();
    const input = screen.getByLabelText("Question about your records");
    fireEvent.change(input, { target: { value: "When did we last pay Mahavir Sweet Mart?" } });
    fireEvent.submit(input.closest("form")!);

    expect(await screen.findByText(/Searching your records…/)).toBeTruthy();
    deferred.resolve();
    expect(
      await screen.findByText(/The latest matching record is Mahavir Sweet Mart, dated 3 Aug 2026 — £27\.10/),
    ).toBeTruthy();
    expect(screen.queryByText(/No matching transactions/)).toBeNull();
    expect(deferred.fetchMock.mock.calls[0]![0]).toContain("q=mahavir");
  });

  it("answers a typed India in August question with that month's total", async () => {
    hydrateData({
      ...SAMPLE_SNAPSHOT,
      months: [...SAMPLE_SNAPSHOT.months, { key: "2026-08", label: "August 2026" }],
    });
    const fetchMock = stubTransactions([
      apiRow({ id: "fp-in1", date: "2026-08-12", description: "Air India", merchant: "Air India", amountMinor: -51200, category: "Holidays" }),
      apiRow({ id: "fp-in2", date: "2026-08-20", description: "Air India", merchant: "Air India", amountMinor: -8840, category: "Holidays" }),
    ]);
    renderAsk();
    // Typed, not clicked: this question is no longer an example chip
    // (G20d), but a user typing it must still get the month's total.
    const input = screen.getByLabelText("Question about your records");
    fireEvent.change(input, { target: { value: "What did we spend in India in August?" } });
    fireEvent.submit(input.closest("form")!);

    expect(await screen.findByText(/Total in August 2026: £600\.40 across 2 transactions\./)).toBeTruthy();
    const url = fetchMock.mock.calls[0]![0];
    expect(url).toContain("month=2026-08");
    expect(url).toContain("q=india");
  });

  it("states a zero total when the named month has no matching spend", async () => {
    hydrateData({
      ...SAMPLE_SNAPSHOT,
      months: [...SAMPLE_SNAPSHOT.months, { key: "2026-08", label: "August 2026" }],
    });
    stubTransactions([]);
    renderAsk();
    const input = screen.getByLabelText("Question about your records");
    fireEvent.change(input, { target: { value: "What did we spend in India in August?" } });
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByText(/Total in August 2026: £0\.00\./)).toBeTruthy();
  });

  it("answers the Air India example chip from the records search, with exactly three chips shown", async () => {
    const fetchMock = stubTransactions([
      apiRow({ id: "fp-ai1", date: "2026-09-05", month: "2026-09", description: "Air India", merchant: "Air India", amountMinor: -51200, category: "Holidays" }),
      apiRow({ id: "fp-ai2", date: "2026-09-12", month: "2026-09", description: "Air India", merchant: "Air India", amountMinor: -8840, category: "Holidays" }),
    ]);
    renderAsk();
    // Exactly three chips, and the old India-in-August chip is gone.
    expect(screen.getByRole("button", { name: "How much on Ocado this month?" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "When did we last get the boiler serviced?" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "What did we spend in India in August?" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "What did we spend with Air India?" }));
    expect(
      await screen.findByText(/The latest matching record is Air India, dated 12 Sept 2026 — £88\.40/),
    ).toBeTruthy();
    // No month is named, so the search is a merchant search, not a month pull.
    const url = fetchMock.mock.calls[0]![0];
    expect(url).toContain("q=air");
    expect(url).not.toContain("month=");
  });

  it("falls back to the snapshot search with an honest note when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    renderAsk();
    const input = screen.getByLabelText("Question about your records");
    fireEvent.change(input, { target: { value: "When did we last pay Ocado?" } });
    fireEvent.submit(input.closest("form")!);

    expect(await screen.findByText(/Full history could not be searched just now/)).toBeTruthy();
  });
});

describe("Ask trip caption", () => {
  it("says there were no Holidays charges when the month total is zero", () => {
    hydrateData({
      ...SAMPLE_SNAPSHOT,
      txns: SAMPLE_TXNS.filter((t) => t.category !== "Holidays"),
    });
    // The holidays question is no longer an example chip (only three
    // chips remain); typing and submitting it reaches the same panel.
    stubTransactions([]);
    renderAsk();
    const input = screen.getByLabelText("Question about your records");
    fireEvent.change(input, { target: { value: "What have holidays cost this month?" } });
    fireEvent.submit(input.closest("form")!);
    expect(screen.getByText("No Holidays charges this month.")).toBeTruthy();
    expect(screen.queryByText(/Nothing on your own accounts/)).toBeNull();
  });
});
