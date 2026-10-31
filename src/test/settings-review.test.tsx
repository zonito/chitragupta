import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Settings } from "@/routes/settings";
import { ThemeProvider } from "@/components/shell";
import { hydrateData } from "@/lib/data";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";
import type { ReviewQueueItem } from "@/lib/data";

/**
 * Phase B / B4, Settings merchant review sheet (component level):
 * the sheet fetches /api/review-queue on open, Keep is gated on a
 * category actually being chosen, a suggestion pre-fills the picker,
 * Keep posts the CHOSEN category as a "user" correction, and Dismiss
 * posts to the persistent dismiss endpoint.
 */

const item = (over: Partial<ReviewQueueItem>): ReviewQueueItem => ({
  merchant: "Fallback Shop",
  count: 1,
  examples: ["Fallback Shop"],
  detail: "£12.34 · 1 charge · last 5 Oct",
  suggestion: null,
  ...over,
});

let queueItems: ReviewQueueItem[] = [];
let queueTotal = 0;
let fetchMock: ReturnType<typeof vi.fn>;

function installFetch() {
  fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    void init;
    if (url === "/api/review-queue") {
      return {
        ok: true,
        json: async () => ({ ok: true, queue: queueItems, total: queueTotal }),
      };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  });
  vi.stubGlobal("fetch", fetchMock);
}

type FetchCall = [string, { method?: string; body?: string } | undefined];
function callsTo(path: string): FetchCall[] {
  return fetchMock.mock.calls.filter((c) => c[0] === path) as FetchCall[];
}

async function openSheet() {
  render(
    <ThemeProvider>
      <Settings />
    </ThemeProvider>,
  );
  fireEvent.click(screen.getByText("Merchant review"));
}

beforeEach(() => {
  hydrateData(SAMPLE_SNAPSHOT);
  queueItems = [
    item({}),
    item({
      merchant: "Tagged Shop",
      detail: "£42.00 · 1 charge · last 5 Oct",
      suggestion: "Groceries",
    }),
  ];
  queueTotal = 2;
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  hydrateData(SAMPLE_SNAPSHOT);
});

describe("Settings merchant review sheet", () => {
  it("shows the true review total on the header chip", () => {
    render(
      <ThemeProvider>
        <Settings />
      </ThemeProvider>,
    );
    // SAMPLE_SNAPSHOT.reviewTotal is 3.
    expect(screen.getByText("3 merchants waiting for review")).toBeTruthy();
  });

  it("gates Keep on choosing a category, defaults to the suggestion, and posts the chosen category", async () => {
    await openSheet();

    expect(await screen.findByText("Fallback Shop")).toBeTruthy();
    expect(screen.getByText("Tagged Shop")).toBeTruthy();
    expect(screen.getByText("£12.34 · 1 charge · last 5 Oct")).toBeTruthy();
    expect(screen.getByText("2 merchants waiting for review.")).toBeTruthy();

    const fallbackSelect = screen.getByLabelText(
      "Category for Fallback Shop",
    ) as HTMLSelectElement;
    const taggedSelect = screen.getByLabelText(
      "Category for Tagged Shop",
    ) as HTMLSelectElement;
    // No suggestion: neutral placeholder, nothing chosen.
    expect(fallbackSelect.value).toBe("");
    expect(
      [...fallbackSelect.options].map((o) => o.text),
    ).toContain("Choose a category");
    // Suggestion pre-fills the picker.
    expect(taggedSelect.value).toBe("Groceries");

    const keepButtons = screen.getAllByRole("button", { name: "Keep" });
    expect((keepButtons[0] as HTMLButtonElement).disabled).toBe(true);
    expect((keepButtons[1] as HTMLButtonElement).disabled).toBe(false);

    fireEvent.change(fallbackSelect, { target: { value: "Shopping" } });
    expect((keepButtons[0] as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(keepButtons[0]!);

    await waitFor(() => expect(callsTo("/api/merchants")).toHaveLength(1));
    const [, init] = callsTo("/api/merchants")[0]!;
    expect(JSON.parse(init!.body!)).toEqual({
      merchant: "Fallback Shop",
      category: "Shopping",
      source: "user",
    });
    expect(await screen.findByText("Kept")).toBeTruthy();
    expect(screen.getByText("1 merchant waiting for review.")).toBeTruthy();
  });

  it("dismiss posts to the persistent dismiss endpoint and marks the item handled", async () => {
    await openSheet();
    expect(await screen.findByText("Tagged Shop")).toBeTruthy();

    const dismissButtons = screen.getAllByRole("button", { name: "Dismiss" });
    fireEvent.click(dismissButtons[1]!);

    await waitFor(() =>
      expect(callsTo("/api/review-queue/dismiss")).toHaveLength(1),
    );
    const [, init] = callsTo("/api/review-queue/dismiss")[0]!;
    expect(JSON.parse(init!.body!)).toEqual({ merchant: "Tagged Shop" });
    expect(await screen.findByText("Dismissed")).toBeTruthy();
    // Dismiss never writes merchant memory.
    expect(callsTo("/api/merchants")).toHaveLength(0);
  });

  it("pages the fetched queue 20 at a time with Show more", async () => {
    queueItems = Array.from({ length: 25 }, (_, i) =>
      item({ merchant: `Shop ${i + 1}`, suggestion: "Shopping" }),
    );
    queueTotal = 25;
    await openSheet();

    expect(await screen.findByText("Shop 1")).toBeTruthy();
    expect(screen.getByText("Shop 20")).toBeTruthy();
    expect(screen.queryByText("Shop 21")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByText("Shop 21")).toBeTruthy();
    expect(screen.getByText("Shop 25")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("notes how many remain beyond the fetched cap only when total exceeds it", async () => {
    queueItems = Array.from({ length: 3 }, (_, i) =>
      item({ merchant: `Capped ${i + 1}`, suggestion: "Shopping" }),
    );
    queueTotal = 575;
    await openSheet();
    expect(await screen.findByText("Capped 1")).toBeTruthy();
    expect(
      screen.getByText("572 more merchants are waiting beyond the 3 shown here."),
    ).toBeTruthy();
  });
});
