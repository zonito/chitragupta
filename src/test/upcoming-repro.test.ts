import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ingestAll } from "@/lib/ingest/ingest";
import { openStore } from "@/lib/ingest/store";
import { buildSnapshot } from "@/lib/snapshot.server";
import {
  hydrateData,
  upcomingPanel,
  upcomingShare,
} from "@/lib/data";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";

const DATA_DIR = process.env["CHITRAGUPTA_DATA_DIR"]?.trim() || null;
const describeRepro = DATA_DIR ? describe : describe.skip;

/**
 * Home's "Coming up" is built from the subscription detector, so the
 * November 2026 list is exactly the detector's Active subs whose next
 * expected charge falls in the window: after the store's latest
 * transaction (30 Oct 2026) and on or before 30 Nov 2026.
 */
describeRepro("upcoming from the real Originals", () => {
  const prevEnv = process.env["CHITRAGUPTA_STORE_DIR"];
  let dir: string | null = null;

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env["CHITRAGUPTA_STORE_DIR"];
    else process.env["CHITRAGUPTA_STORE_DIR"] = prevEnv;
    hydrateData(SAMPLE_SNAPSHOT);
  });

  it("lists the detector's November 2026 regulars and not GitHub", () => {
    dir = mkdtempSync(join(tmpdir(), "chitra-upcoming-"));
    const db = openStore(dir);
    ingestAll(db, DATA_DIR!);
    db.close();

    process.env["CHITRAGUPTA_STORE_DIR"] = dir;
    const snap = buildSnapshot();
    expect(snap.monthKey).toBe("2026-10");

    const byName = new Map(snap.upcoming.map((p) => [p.name, p]));
    expect(byName.get("Infinite Clarity")).toMatchObject({
      date: "2026-11-29",
      day: 29,
      amount: 28.85,
    });
    expect(byName.get("Tesla")).toMatchObject({
      date: "2026-11-04",
      day: 4,
      amount: 9.99,
    });
    expect(byName.get("langbase.com")).toMatchObject({
      date: "2026-11-17",
      day: 17,
      amount: 8.42,
    });
    expect(byName.get("Apple")).toMatchObject({
      date: "2026-11-10",
      day: 10,
      amount: 3.99,
    });
    // A yearly sub due next month is here too (the old heuristic,
    // which required a charge in the current month, missed it).
    expect(byName.get("bitwarden.com")).toMatchObject({
      date: "2026-11-01",
      day: 1,
      amount: 7.65,
    });
    // The merged Lebara display name the Subscriptions card shows.
    const lebara = snap.upcoming.find((p) => p.name.includes("Lebara"));
    expect(lebara).toMatchObject({
      name: "Lebara mobile",
      date: "2026-11-10",
      day: 10,
      amount: 5,
    });

    // GitHub is not a subscription the detector recognises (its charges
    // swing £28.94–£78.78), so it is in neither list.
    expect(byName.has("GitHub")).toBe(false);
    expect(snap.subs.some((s) => s.name === "GitHub")).toBe(false);

    // Every entry is one of the detector's subs at its own amount and
    // nextExpected date, inside the window, and the list is date-sorted.
    for (const entry of snap.upcoming) {
      const sub = snap.subs.find((s) => s.name === entry.name);
      expect(sub, `${entry.name} comes from the detector`).toBeTruthy();
      expect(entry.amount).toBe(sub!.amount);
      expect(entry.date).toBe(sub!.nextExpected);
      expect(entry.date > "2026-10-30").toBe(true);
      expect(entry.date <= "2026-11-30").toBe(true);
    }
    const dates = snap.upcoming.map((p) => p.date);
    expect(dates).toEqual([...dates].sort());

    // Headline consistency at the data layer: the panel's visible rows
    // plus its "and N more" remainder sum to the total it headlines.
    hydrateData(snap);
    const panel = upcomingPanel("household");
    const visibleSum = panel.visible.reduce(
      (sum, p) => sum + upcomingShare(p, "household"),
      0,
    );
    expect(panel.visible).toHaveLength(5);
    expect(panel.restCount).toBe(snap.upcoming.length - 5);
    expect(panel.restCount).toBeGreaterThan(0);
    expect(visibleSum + panel.restTotal).toBeCloseTo(panel.total, 2);
    expect(panel.total).toBeCloseTo(
      snap.upcoming.reduce((sum, p) => sum + p.amount, 0),
      2,
    );
  }, 120_000);
});

/**
 * The window rules on a synthetic store: an Active sub whose
 * nextExpected is already past is excluded, an Ended sub is excluded,
 * and a yearly sub due next month is included.
 */
describe("upcoming window rules on a synthetic store", () => {
  let dir: string | null = null;
  const prevEnv = process.env["CHITRAGUPTA_STORE_DIR"];

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
    if (prevEnv === undefined) delete process.env["CHITRAGUPTA_STORE_DIR"];
    else process.env["CHITRAGUPTA_STORE_DIR"] = prevEnv;
  });

  it("excludes past-due Active and Ended subs, includes a yearly sub due next month", () => {
    dir = mkdtempSync(join(tmpdir(), "chitra-upcoming-synth-"));
    const db = openStore(dir);
    const insert = db.prepare(
      `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
         description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'GBP', 0, 'spend', NULL)`,
    );
    const charge = (
      id: string,
      merchant: string,
      date: string,
      amountMinor: number,
      account = "Main",
      person = "zonito",
    ) =>
      insert.run(
        id,
        person,
        account,
        date,
        date.slice(0, 7),
        merchant,
        merchant,
        amountMinor,
      );
    // Yearly sub due next month, on the Joint account: charges a year
    // apart, next expected 5 Nov 2026.
    charge("y1", "Yearly Due", "2024-11-05", -1000, "Joint");
    charge("y2", "Yearly Due", "2025-11-05", -1000, "Joint");
    // Yearly sub the detector still calls Active (its last charge is
    // within 1.5 cadences of the latest transaction) but whose next
    // expected date, 2 May 2026, is already past.
    charge("p1", "Past Due Yearly", "2024-05-02", -1250);
    charge("p2", "Past Due Yearly", "2025-05-02", -1250);
    // Monthly sub that stopped in mid-2025: Ended, nextExpected null.
    charge("e1", "Ended Monthly", "2025-05-05", -3900, "Main", "nikhila");
    charge("e2", "Ended Monthly", "2025-06-05", -3900, "Main", "nikhila");
    charge("e3", "Ended Monthly", "2025-07-05", -3900, "Main", "nikhila");
    // The store's latest transaction, 30 Oct 2026.
    charge("a1", "Corner Shop", "2026-10-30", -500);
    db.close();

    process.env["CHITRAGUPTA_STORE_DIR"] = dir;
    const snap = buildSnapshot();
    expect(snap.monthKey).toBe("2026-10");

    const subsByName = new Map(snap.subs.map((s) => [s.name, s]));
    expect(subsByName.get("Past Due Yearly")).toMatchObject({
      status: "Active",
      nextExpected: "2026-05-02",
    });
    expect(subsByName.get("Ended Monthly")).toMatchObject({
      status: "Ended",
      nextExpected: null,
    });

    expect(snap.upcoming).toEqual([
      {
        name: "Yearly Due",
        day: 5,
        date: "2026-11-05",
        amount: 10,
        owner: "joint",
      },
    ]);
  });
});
