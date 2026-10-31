import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Categories } from "@/routes/categories";
import { PersonProvider } from "@/components/shell";

/**
 * B9a client behaviour: the default current month renders from the
 * snapshot with no fetch; choosing another period in the one selector
 * swaps the totals to the scoped API response, and the sheet's merchant
 * breakdown comes from the API's merchant mode.
 */

const seriesPeriods = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];
const seriesLabels = ["Apr", "May", "Jun", "Jul", "Aug", "Sep"];

function mockFetch() {
  return vi.fn(async (url: string) => {
    const parsed = new URL(url, "http://local");
    const scope = parsed.searchParams.get("scope");
    if (scope === "year") {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          person: "household",
          scope: "year",
          year: "2026",
          total_minor: 0,
          seriesPeriods: [],
          seriesLabels: [],
          rows: [],
        }),
      };
    }
    const base = {
      ok: true,
      person: "household",
      scope: "month",
      month: "2026-09",
      total_minor: 12345,
      seriesPeriods,
      seriesLabels,
      rows: [
        {
          category: "Groceries",
          spend_minor: 12345,
          typical_minor: 10000,
          series: [100, 200, 300, 400, 500, 12345],
        },
      ],
    };
    if (parsed.searchParams.has("category")) {
      return {
        ok: true,
        json: async () => ({
          ...base,
          category: "Groceries",
          merchants: [{ merchant: "September Merchant", spend_minor: 12345 }],
        }),
      };
    }
    return { ok: true, json: async () => base };
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Categories period selector", () => {
  it("renders the current month from the snapshot without fetching", () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <PersonProvider>
        <Categories />
      </PersonProvider>,
    );
    // Sample snapshot household Groceries for October 2026: £561.
    expect(screen.getByText("£561")).toBeTruthy();
    expect(screen.getByText(/in October/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("swaps totals to a fetched past month and the sheet breakdown comes from the API", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(
      <PersonProvider>
        <Categories />
      </PersonProvider>,
    );
    const select = container.querySelector("select")!;
    fireEvent.change(select, { target: { value: "month:2026-09" } });

    expect(await screen.findByText("£123")).toBeTruthy();
    expect(await screen.findByText(/£123\.45 in September 2026/)).toBeTruthy();
    const scopeCall = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes("scope=month"));
    expect(scopeCall).toContain("month=2026-09");
    expect(scopeCall).toContain("person=household");

    fireEvent.click(screen.getByText("Groceries"));
    expect(await screen.findByText("September Merchant")).toBeTruthy();
    expect(await screen.findByText("Usually £100")).toBeTruthy();
    const merchantCall = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes("category="));
    expect(merchantCall).toBeDefined();
    expect(merchantCall).toContain("category=Groceries");
  });

  it("shows an honest empty message for a scope with no spend", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(
      <PersonProvider>
        <Categories />
      </PersonProvider>,
    );
    const select = container.querySelector("select")!;
    fireEvent.change(select, { target: { value: "year:2026" } });
    expect(await screen.findByText("No spending in 2026.")).toBeTruthy();
    expect(screen.queryByText("£0")).toBeNull();
  });
});
