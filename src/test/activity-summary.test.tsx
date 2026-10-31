import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Activity } from "@/routes/activity";
import { PersonProvider } from "@/components/shell";
import { DocumentsProvider } from "@/components/documents";
import { hydrateData, type DataSnapshot, type Txn } from "@/lib/data";
import { SAMPLE_SNAPSHOT, SAMPLE_TXNS } from "@/test/fixtures";

/**
 * Part 2 of the Activity pass: the listed-total summary line under
 * the filters. It sums the very rows the list renders (never a
 * separate aggregate) and names its scope — period, search, category,
 * account — so a narrowed list never wears the whole period's total.
 * Expected figures below are hand-summed from SAMPLE_TXNS:
 *   October (household): 48 rows listed, spend rows total £5,296.84
 *   search "ocado":       5 rows, £530.15 (112.40+98.75+124.10+105.60+89.30)
 *   Groceries:            7 rows, £561.40
 *   Main account scope:   16 rows, spend £3,470.59
 */

function renderActivity() {
  return render(
    <PersonProvider>
      <DocumentsProvider>
        <Activity />
      </DocumentsProvider>
    </PersonProvider>,
  );
}

const summaryText = () =>
  screen.getByTestId("listed-summary").textContent ?? "";

beforeEach(() => {
  hydrateData(SAMPLE_SNAPSHOT);
  window.history.pushState({}, "", "/");
  // Range presets and older months fetch on demand; an empty page is
  // a valid answer (the snapshot months inside the range still list).
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
});

afterEach(() => {
  vi.unstubAllGlobals();
  hydrateData(SAMPLE_SNAPSHOT);
});

describe("Activity listed-total summary", () => {
  it("plain month: the whole period, labelled by month", () => {
    renderActivity();
    expect(summaryText()).toContain("October 2026");
    expect(summaryText()).toContain("£5,296.84 spent");
    expect(summaryText()).toContain("48 transactions");
    expect(summaryText()).not.toContain(" in");
  });

  it("search narrows the total and the label says so", () => {
    renderActivity();
    fireEvent.change(screen.getByPlaceholderText(/Search/), {
      target: { value: "ocado" },
    });
    expect(summaryText()).toContain('Search "ocado"');
    expect(summaryText()).toContain("£530.15 spent");
    expect(summaryText()).toContain("5 transactions");
  });

  it("a category filter narrows the total and names the category", () => {
    renderActivity();
    const catSelect = screen
      .getByRole("option", { name: "Groceries" })
      .closest("select")!;
    fireEvent.change(catSelect, { target: { value: "Groceries" } });
    expect(summaryText()).toContain("Groceries");
    expect(summaryText()).toContain("£561.40 spent");
    expect(summaryText()).toContain("7 transactions");
  });

  it("the quarter preset labels its scope Q4 2026 with the range's rows", async () => {
    renderActivity();
    const periodSelect = screen.getByLabelText("Period");
    fireEvent.change(periodSelect, { target: { value: "preset:quarter" } });
    await waitFor(() => expect(summaryText()).toContain("Q4 2026"));
    expect(summaryText()).toContain("£5,296.84 spent");
    expect(summaryText()).toContain("48 transactions");
  });

  it("the last-12-months preset labels itself and keeps the same rows", async () => {
    renderActivity();
    const periodSelect = screen.getByLabelText("Period");
    fireEvent.change(periodSelect, { target: { value: "preset:last12" } });
    await waitFor(() => expect(summaryText()).toContain("Last 12 months"));
    expect(summaryText()).toContain("£5,296.84 spent");
    expect(summaryText()).toContain("48 transactions");
  });

  it("an account scope from Cards narrows the total and names the account", async () => {
    const snap = structuredClone(SAMPLE_SNAPSHOT) as DataSnapshot;
    snap.txns = SAMPLE_TXNS.map((t): Txn =>
      t.account === "Revolut Main · Zonito" ? { ...t, accountId: "Main" } : t,
    );
    hydrateData(snap);
    window.history.pushState({}, "", "/activity?account=Main&accountPerson=zonito");
    renderActivity();
    await waitFor(() => expect(summaryText()).toContain("Revolut Main"));
    expect(summaryText()).toContain("£3,470.59 spent");
    expect(summaryText()).toContain("16 transactions");
    // The removable scope chip rides along with the same label.
    expect(screen.getByLabelText("Clear account filter")).toBeTruthy();
  });

  it("money in appears as a secondary figure; aside money never counts as spent", () => {
    const snap = structuredClone(SAMPLE_SNAPSHOT) as DataSnapshot;
    const mk = (over: Partial<Txn>): Txn => ({
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
    snap.txns = [
      mk({ id: "s1", merchant: "Shop", amount: 100 }),
      mk({
        id: "t1",
        merchant: "Nikhila → Zonito",
        category: "Transfer",
        kind: "transfer",
        amount: 250,
        incoming: true,
      }),
      mk({
        id: "a1",
        merchant: "Trading 212",
        category: "Moved aside",
        kind: "aside",
        amount: 900,
        incoming: true,
      }),
    ];
    hydrateData(snap);
    renderActivity();
    // £100 spent; the £250 transfer in shows as "in"; the £900 aside
    // withdrawal is also money in — but neither touches the spent sum.
    expect(summaryText()).toContain("£100.00 spent");
    expect(summaryText()).toContain("3 transactions");
    expect(summaryText()).toContain("£1,150.00");
    expect(summaryText()).toContain(" in");
  });

  it("an empty result states £0.00 and 0 transactions rather than hiding", () => {
    renderActivity();
    fireEvent.change(screen.getByPlaceholderText(/Search/), {
      target: { value: "no-such-merchant" },
    });
    expect(summaryText()).toContain("£0.00 spent");
    expect(summaryText()).toContain("0 transactions");
    expect(screen.getByText("Nothing here.")).toBeTruthy();
  });
});
