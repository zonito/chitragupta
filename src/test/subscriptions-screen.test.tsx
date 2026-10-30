import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Subs } from "@/routes/subscriptions";
import { PersonProvider } from "@/components/shell";
import { hydrateData, type Sub } from "@/lib/data";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";
import type { ApiTxnRow } from "@/lib/txn-map";

/**
 * The subscriptions screen groups Active subs under their cadence with an
 * Ended section after, and a card opens a detail sheet listing that
 * subscription's transactions, paginated 10 per page in the UI.
 */

const sub = (over: Partial<Sub>): Sub => ({
  name: "Streamly",
  amount: 9.99,
  freq: "Monthly",
  last: "5 Oct",
  card: "Revolut Main · Zonito",
  owner: "zonito",
  status: "Active",
  charges: 14,
  nextExpected: "2026-11-05",
  variants: ["Streamly"],
  ...over,
});

const row = (n: number): ApiTxnRow => ({
  id: `streamly-${n}`,
  person: "zonito",
  account: "Main",
  // Newest first: charge 1 is the most recent.
  date: `2026-${String(11 - Math.ceil(n / 3)).padStart(2, "0")}-${String(28 - ((n - 1) % 3) * 7).padStart(2, "0")}`,
  month: "2026-10",
  description: `Streamly charge ${n}`,
  merchant: "Streamly",
  amountMinor: -999,
  currency: "GBP",
  movement: "spend",
  category: "Subscriptions",
});

beforeEach(() => {
  hydrateData({
    ...SAMPLE_SNAPSHOT,
    subs: [
      sub({}),
      sub({
        name: "Prime Yearly",
        amount: 95,
        freq: "Yearly",
        charges: 3,
        nextExpected: "2027-03-14",
        variants: ["Prime Yearly"],
      }),
      sub({
        name: "Old Gym",
        amount: 39,
        status: "Ended",
        charges: 9,
        nextExpected: null,
        variants: ["Old Gym"],
      }),
    ],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const merchant = new URLSearchParams(url.split("?")[1]).get("merchant");
      const transactions =
        merchant === "Streamly"
          ? Array.from({ length: 14 }, (_, i) => row(i + 1))
          : [];
      return { ok: true, json: async () => ({ ok: true, transactions }) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  hydrateData(SAMPLE_SNAPSHOT);
});

describe("Subscriptions screen", () => {
  it("renders Monthly, Yearly and Ended sections", () => {
    render(
      <PersonProvider>
        <Subs />
      </PersonProvider>,
    );
    expect(screen.getByRole("heading", { name: "Monthly" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Yearly" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Ended" })).toBeTruthy();
    expect(screen.getByText("Streamly")).toBeTruthy();
    expect(screen.getByText("Prime Yearly")).toBeTruthy();
    expect(screen.getByText("Old Gym")).toBeTruthy();
  });

  it("opens a card's transactions paginated 10 per page", async () => {
    render(
      <PersonProvider>
        <Subs />
      </PersonProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Streamly transactions/ }));
    expect(await screen.findByText("Streamly charge 1")).toBeTruthy();
    expect(screen.getByText("Streamly charge 10")).toBeTruthy();
    expect(screen.queryByText("Streamly charge 11")).toBeNull();
    expect(screen.getByText("Page 1 of 2")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Streamly charge 11")).toBeTruthy();
    expect(screen.getByText("Streamly charge 14")).toBeTruthy();
    expect(screen.queryByText("Streamly charge 1")).toBeNull();
    expect(screen.getByText("Page 2 of 2")).toBeTruthy();
  });
});
