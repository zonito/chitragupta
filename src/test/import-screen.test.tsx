import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PersonProvider } from "@/components/shell";
import { hydrateData } from "@/lib/data";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";

/**
 * Phase B / B7 — Import screen honesty:
 * (iii) a partial-failure run response renders "finished with errors"
 * naming the failed account and still invalidates the snapshot; a
 * no-results failure keeps "did not run".
 * (iv) the ingest status endpoint's balance and discrepancy render
 * under each account row, failures included.
 */

const { invalidateMock } = vi.hoisted(() => ({
  invalidateMock: vi.fn(async () => {}),
}));

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-router")>(
    "@tanstack/react-router",
  );
  return {
    ...actual,
    useRouter: () => ({ invalidate: invalidateMock }),
  };
});

// Imported after the router mock is registered.
const { Import } = await import("@/routes/import");

type RunBody = Record<string, unknown>;
let runBody: RunBody;
let statusBody: Record<string, unknown>;
let fetchMock: ReturnType<typeof vi.fn>;

function installFetch() {
  fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/ingest/status") {
      return { ok: true, json: async () => statusBody };
    }
    if (url === "/api/ingest/run") {
      return { ok: true, json: async () => runBody };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderImport() {
  const utils = render(
    <PersonProvider>
      <Import />
    </PersonProvider>,
  );
  const input = utils.container.querySelector(
    'input[type="file"]',
  )! as HTMLInputElement;
  return { ...utils, input };
}

function triggerImport(input: HTMLInputElement) {
  const file = new File(["statement"], "statement.csv", { type: "text/csv" });
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  hydrateData(SAMPLE_SNAPSHOT);
  invalidateMock.mockClear();
  runBody = { ok: true, results: [] };
  statusBody = { ok: true, accounts: [] };
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  hydrateData(SAMPLE_SNAPSHOT);
});

describe("Import screen run result handling (B7)", () => {
  it("renders finished-with-errors naming the failed account and invalidates on partial failure", async () => {
    runBody = {
      ok: false,
      error:
        "1 of 2 accounts failed: Pro (account-statement_2022_01cac2.csv): invalid statement header",
      results: [
        {
          account: "Main",
          rowsSeen: 5,
          rowsAdded: 3,
          balanceMinor: 99000,
          currency: "GBP",
          discrepancy: null,
          ok: true,
          file: "account-statement_2022_f5660e.csv",
        },
        {
          account: "Pro",
          rowsSeen: 0,
          rowsAdded: 0,
          balanceMinor: null,
          currency: null,
          discrepancy: null,
          ok: false,
          file: "account-statement_2022_01cac2.csv",
          error: "invalid statement header: expected Type, Product",
        },
      ],
    };
    const { input } = renderImport();
    triggerImport(input);

    expect(await screen.findByText(/Import finished with errors/)).toBeTruthy();
    expect(screen.getByText(/3 new rows across 2 accounts/)).toBeTruthy();
    expect(
      screen.getByText(/Pro \(account-statement_2022_01cac2\.csv\)/),
    ).toBeTruthy();
    expect(screen.queryByText(/Import did not run/)).toBeNull();
    expect(invalidateMock).toHaveBeenCalled();
    // Status is refetched after the run as well as on mount.
    const statusCalls = fetchMock.mock.calls.filter(
      (c) => c[0] === "/api/ingest/status",
    );
    expect(statusCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps 'did not run' when the response carries no results", async () => {
    runBody = { ok: false, error: "CHITRAGUPTA_DATA_DIR is not set" };
    const { input } = renderImport();
    triggerImport(input);

    expect(
      await screen.findByText(
        "Import did not run: CHITRAGUPTA_DATA_DIR is not set",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Import finished with errors/)).toBeNull();
    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it("keeps the success wording when every account is ok", async () => {
    runBody = {
      ok: true,
      results: [
        { account: "Main", rowsAdded: 4, ok: true, file: "a.csv" },
        { account: "Pro", rowsAdded: 1, ok: true, file: "b.csv" },
      ],
    };
    const { input } = renderImport();
    triggerImport(input);

    expect(
      await screen.findByText(
        "Import finished — 5 new rows across 2 accounts.",
      ),
    ).toBeTruthy();
    expect(invalidateMock).toHaveBeenCalled();
  });
});

describe("Import screen ingest status (B7)", () => {
  it("shows each account's balance and discrepancy, including a failed run's text", async () => {
    hydrateData({
      ...SAMPLE_SNAPSHOT,
      accounts: [
        {
          name: "Revolut Main",
          owner: "zonito",
          last: "28 Oct",
          added: 31,
          stale: false,
        },
        {
          name: "Revolut Savings 0001",
          owner: "zonito",
          last: "28 Oct",
          added: 2,
          stale: false,
        },
      ],
    });
    statusBody = {
      ok: true,
      accounts: [
        {
          account: "Main",
          lastIngest: "2026-10-30T09:00:00.000Z",
          rowsSeen: 2770,
          rowsAdded: 0,
          balanceMinor: 14274,
          currency: "GBP",
          discrepancy: "balance chain breaks on 2 row(s); last balance kept",
        },
        {
          account: "Savings-9000000001",
          lastIngest: "2026-10-30T09:00:00.000Z",
          rowsSeen: 0,
          rowsAdded: 0,
          balanceMinor: null,
          currency: null,
          discrepancy:
            "ingest failed for savings-statement_2014731036.csv: savings-statement_2014731036.csv: no transactions parsed — the file does not look like a savings export",
        },
      ],
    };
    renderImport();

    expect(await screen.findByText("Balance £142.74")).toBeTruthy();
    expect(
      screen.getByText("balance chain breaks on 2 row(s); last balance kept"),
    ).toBeTruthy();
    // The failed account surfaces its failure text honestly, with no
    // invented balance.
    expect(
      screen.getByText(/ingest failed for savings-statement_2014731036\.csv/),
    ).toBeTruthy();
    expect(screen.queryByText("Balance £0.00")).toBeNull();
  });
});
