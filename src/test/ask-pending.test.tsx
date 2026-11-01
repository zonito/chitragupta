import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { AskButton, ASK_TIMEOUT_MS, PersonProvider } from "@/components/shell";
import { DocumentsProvider } from "@/components/documents";
import { hydrateData } from "@/lib/data";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";

/**
 * Regression for the false "no results" bug (31 Oct): a records
 * question's deterministic search settles in well under a second and
 * used to render its zero-match verdict while the AI answer — which
 * legitimately takes ~20s — was still in flight. Zonito asked about
 * Penny, saw "No matching transactions…", and the correct answer
 * (£4,428, 13 payments) was only there when he reopened the sheet.
 * Now: while the AI ask is in flight the sheet shows an honest
 * working state; result cards render only from completed responses;
 * a genuine timeout gets its own copy, never the no-matching one.
 * Plus the addendum: chips live only in the fresh state, and the
 * "You asked" echo is gone.
 */

const PENNY_QUESTION = "how much have i paid to penny last 2 years?";
const PENNY_ANSWER = {
  ok: true,
  answer: "You paid Penny Caulfield £4,428.00 in total.",
  figures: {
    total: 4428,
    count: 13,
    latest: null,
    perMonth: null,
    month: null,
    truncated: false,
  },
  ai: true,
};

function stubFetch(askImpl: (init?: RequestInit) => Promise<unknown>) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) =>
    String(url).includes("/api/ask")
      ? askImpl(init)
      : Promise.resolve({
          ok: true,
          json: async () => ({ ok: true, count: 0, transactions: [] }),
        }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const delayed = (ms: number, value: unknown) =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

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

function submit(question: string) {
  const input = screen.getByLabelText("Question about your records");
  fireEvent.change(input, { target: { value: question } });
  fireEvent.submit(input.closest("form")!);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  hydrateData(SAMPLE_SNAPSHOT);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Ask pending behaviour", () => {
  it("slow AI answer: working state throughout, no false no-result, answer on completion", async () => {
    stubFetch(() =>
      delayed(3000, { ok: true, json: async () => PENNY_ANSWER }),
    );
    renderAsk();
    submit(PENNY_QUESTION);

    // The working state is up for the whole wait…
    expect(
      await screen.findByText(/Looking through your records…/),
    ).toBeTruthy();
    expect(screen.queryByText(/No matching transactions/)).toBeNull();
    // …including midway through it (the deterministic search has
    // long settled by now — that was the false-verdict moment).
    await sleep(1200);
    expect(screen.getByText(/Looking through your records…/)).toBeTruthy();
    expect(screen.queryByText(/No matching transactions/)).toBeNull();

    // …and closing/reopening mid-flight keeps the thread: working
    // state again, then the answer when it lands.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: /Ask/ }));
    expect(screen.getByText(/Looking through your records…/)).toBeTruthy();

    expect(
      await screen.findByText(
        /You paid Penny Caulfield £4,428\.00 in total\./,
        undefined,
        { timeout: 5000 },
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Across 13 matching transactions/)).toBeTruthy();
    expect(screen.queryByText(/No matching transactions/)).toBeNull();
    expect(screen.queryByText(/Looking through your records…/)).toBeNull();
  }, 15000);

  it("zero matches: the no-result copy appears only after every search has completed", async () => {
    // The AI endpoint fails (its designed fallback situation) after a
    // delay, and the history search finds nothing.
    stubFetch(() =>
      delayed(1500, { ok: false, status: 503, json: async () => ({}) }),
    );
    renderAsk();
    submit("when did we last pay the window cleaner?");

    expect(
      await screen.findByText(/Looking through your records…/),
    ).toBeTruthy();
    await sleep(600);
    // Still waiting on the AI path: the zero-match verdict must NOT
    // be showing yet.
    expect(screen.queryByText(/No matching transactions/)).toBeNull();

    expect(
      await screen.findByText(
        /No matching transactions or documents in the household records\./,
        undefined,
        { timeout: 5000 },
      ),
    ).toBeTruthy();
  }, 15000);

  it("a genuine timeout shows its own copy, never the no-matching verdict", async () => {
    vi.useFakeTimers();
    stubFetch(
      (init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () =>
            reject(
              Object.assign(new Error("The operation was aborted"), {
                name: "AbortError",
              }),
            ),
          );
        }),
    );
    renderAsk();
    submit(PENNY_QUESTION);
    expect(screen.getByText(/Looking through your records…/)).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(ASK_TIMEOUT_MS + 1000);
    });
    expect(screen.getByText(/That took too long — try again/)).toBeTruthy();
    expect(screen.queryByText(/No matching transactions/)).toBeNull();
    expect(screen.queryByText(/Looking through your records…/)).toBeNull();
  });
});

describe("Ask fresh-state chips and no question echo (addendum)", () => {
  it("chips show only in the fresh state; the asked question is never echoed", async () => {
    stubFetch(() =>
      Promise.resolve({ ok: true, json: async () => PENNY_ANSWER }),
    );
    renderAsk();
    // Fresh: chips visible, no echo block anywhere.
    expect(
      screen.getByRole("button", { name: "How much on Ocado this month?" }),
    ).toBeTruthy();
    expect(screen.queryByText(/You asked/i)).toBeNull();

    const input = screen.getByLabelText("Question about your records");
    fireEvent.change(input, { target: { value: "how much" } });
    expect(
      screen.queryByRole("button", { name: "How much on Ocado this month?" }),
    ).toBeNull();
    // Clearing back to the fresh empty state restores them.
    fireEvent.change(input, { target: { value: "" } });
    expect(
      screen.getByRole("button", { name: "How much on Ocado this month?" }),
    ).toBeTruthy();

    submit(PENNY_QUESTION);
    expect(
      await screen.findByText(/You paid Penny Caulfield £4,428\.00 in total\./),
    ).toBeTruthy();
    // With an answer rendered: no chips, no echo.
    expect(
      screen.queryByRole("button", { name: "How much on Ocado this month?" }),
    ).toBeNull();
    expect(screen.queryByText(/You asked/i)).toBeNull();
    // Even clearing the input after asking does not bring them back:
    // something has been asked in this session.
    fireEvent.change(input, { target: { value: "" } });
    expect(
      screen.queryByRole("button", { name: "How much on Ocado this month?" }),
    ).toBeNull();
  });
});
