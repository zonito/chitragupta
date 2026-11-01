import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { Activity } from "@/routes/activity";
import { PersonProvider } from "@/components/shell";
import { DocumentsProvider } from "@/components/documents";
import { hydrateData, type DataSnapshot, type Txn } from "@/lib/data";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";
import { apiTxnToTxn, timeOfDay, type ApiTxnRow } from "@/lib/txn-map";

/**
 * Part 3 of the Activity pass: the detail sheet shows the exact time
 * of day in a chip when the stored timestamp carries one ("Friday 23
 * October" + a 14:32 chip), and never prints 00:00 — a midnight stamp
 * is the date-only placeholder. Times are shown as recorded, no
 * timezone conversion.
 */

describe("timeOfDay", () => {
  it("extracts HH:MM from space- and T-separated timestamps", () => {
    expect(timeOfDay("2026-10-23 14:32:05")).toBe("14:32");
    expect(timeOfDay("2026-10-23T09:05:00")).toBe("09:05");
    expect(timeOfDay("2026-10-23 23:59")).toBe("23:59");
  });

  it("a bare date and a 00:00 placeholder carry no time", () => {
    expect(timeOfDay("2026-10-23")).toBeUndefined();
    expect(timeOfDay("2026-10-23 00:00:00")).toBeUndefined();
    expect(timeOfDay("2026-10-23T00:00")).toBeUndefined();
  });

  it("a seconds-bearing first-minute stamp (00:00:29) is returned in full", () => {
    // A genuine time just after midnight: the short "00:00" would
    // read as the placeholder, so the list value keeps its seconds.
    expect(timeOfDay("2026-11-01 00:00:29")).toBe("00:00:29");
    expect(timeOfDay("2026-11-01T00:00:05")).toBe("00:00:05");
  });
});

const apiRow = (over: Partial<ApiTxnRow>): ApiTxnRow => ({
  id: "fp1",
  person: "zonito",
  account: "Main",
  date: "2026-10-23 14:32:05",
  month: "2026-10",
  description: "Timed Shop",
  merchant: "Timed Shop",
  amountMinor: -1000,
  currency: "GBP",
  movement: "spend",
  category: "Groceries",
  ...over,
});

describe("apiTxnToTxn time", () => {
  it("a timestamped row maps its time; a midnight row maps none", () => {
    expect(apiTxnToTxn(apiRow({}))?.time).toBe("14:32");
    expect(
      apiTxnToTxn(apiRow({ date: "2026-10-23 00:00:00" }))?.time,
    ).toBeUndefined();
    expect(apiTxnToTxn(apiRow({ date: "2026-10-23" }))?.time).toBeUndefined();
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
  hydrateData(SAMPLE_SNAPSHOT);
});

describe("Activity sheet time", () => {
  it("a timed transaction shows the time in a chip beside the date", async () => {
    renderWith([mkTxn({ id: "timed", time: "14:32" })]);
    fireEvent.click(screen.getByText("Timed Shop").closest("button")!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Friday 23 October/)).toBeTruthy();
    expect(within(dialog).getByText("14:32")).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/October ·/);
  });

  it("a date-only transaction shows the date and no time", async () => {
    renderWith([mkTxn({ id: "plain" })]);
    fireEvent.click(screen.getByText("Timed Shop").closest("button")!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Friday 23 October/)).toBeTruthy();
    expect(dialog.textContent).not.toContain("00:00");
    expect(dialog.textContent).not.toMatch(/October ·/);
  });
});
