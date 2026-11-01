import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@/lib/ingest/store";
import { reviewQueueCount } from "@/lib/ingest/merchants";
import { buildSnapshot } from "@/lib/snapshot.server";
import { apiTxnToTxn } from "@/lib/txn-map";

/**
 * Regression tests for the UI snapshot builder against real-store quirks:
 * some stored effective_date values carry a full "YYYY-MM-DD HH:MM:SS"
 * timestamp, and the store can hold merchants with no card payments.
 * Both used to throw inside the builder and silently empty every screen.
 */
describe("snapshot builder", () => {
  let dir: string | null = null;
  const prevEnv = process.env["CHITRAGUPTA_STORE_DIR"];

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
    if (prevEnv === undefined) delete process.env["CHITRAGUPTA_STORE_DIR"];
    else process.env["CHITRAGUPTA_STORE_DIR"] = prevEnv;
  });

  it("normalises timestamp-shaped dates and survives a spend-free merchant", () => {
    dir = mkdtempSync(join(tmpdir(), "chitragupta-snap-"));
    const db = openStore(dir);
    const insert = db.prepare(
      `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
         description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
       VALUES (?, 'zonito', 'Main', ?, ?, ?, ?, ?, 0, 'GBP', 0, ?, NULL)`,
    );
    insert.run(
      "a",
      "2026-10-05 13:58:16",
      "2026-10",
      "Ocado",
      "Ocado",
      -4250,
      "spend",
    );
    insert.run("b", "2026-10-06", "2026-10", "Ocado", "Ocado", -1000, "spend");
    // Income-only merchant: present in the store with no spend rows.
    insert.run(
      "c",
      "2026-10-07",
      "2026-10",
      "Mystery Sender",
      "Mystery Sender",
      5000,
      "income",
    );
    db.prepare(
      `INSERT INTO ingest_runs (account, started_at, rows_seen, rows_added) VALUES ('Main', '2026-10-30T09:00:00.000Z', 3, 3)`,
    ).run();
    db.close();

    process.env["CHITRAGUPTA_STORE_DIR"] = dir;
    const snap = buildSnapshot();
    expect(snap.configured).toBe(true);
    expect(snap.monthKey).toBe("2026-10");
    const ocado = snap.txns.filter((t) => t.merchant === "Ocado");
    expect(ocado).toHaveLength(2);
    expect(ocado.every((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.date))).toBe(true);
    // Since B2/G12 a pure-income label never qualifies for the review
    // queue, so it does not count toward the review total either; the
    // builder still survives it. Only Ocado (spend-bearing, unknown)
    // counts.
    expect(snap.reviewTotal).toBe(1);
    expect(snap.accounts[0]?.name).toBe("Revolut Main");
  });

  it("carries no hardcoded review items and a reviewTotal equal to reviewQueueCount", () => {
    dir = mkdtempSync(join(tmpdir(), "chitragupta-snap-"));
    const db = openStore(dir);
    const insert = db.prepare(
      `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
         description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
       VALUES (?, 'zonito', 'Main', ?, ?, ?, ?, ?, 0, 'GBP', 0, 'spend', NULL)`,
    );
    insert.run(
      "r1",
      "2026-10-05",
      "2026-10",
      "Alpha Unknown",
      "Alpha Unknown",
      -1000,
    );
    insert.run(
      "r2",
      "2026-10-06",
      "2026-10",
      "Beta Unknown",
      "Beta Unknown",
      -2000,
    );
    insert.run(
      "r3",
      "2026-10-07",
      "2026-10",
      "Beta Unknown",
      "Beta Unknown",
      -500,
    );
    const expected = reviewQueueCount(db);
    db.close();

    process.env["CHITRAGUPTA_STORE_DIR"] = dir;
    const snap = buildSnapshot();
    // The snapshot no longer carries a review item list at all (the
    // sheet fetches items from /api/review-queue), so nothing in it
    // can be a hardcoded "One-off" review entry.
    expect("merchantReview" in snap).toBe(false);
    expect(expected).toBe(2);
    expect(snap.reviewTotal).toBe(expected);
  });

  it("lists every month in the store while txns stay at the two newest months", () => {
    dir = mkdtempSync(join(tmpdir(), "chitragupta-snap-"));
    const db = openStore(dir);
    const insert = db.prepare(
      `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
         description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
       VALUES (?, 'zonito', 'Main', ?, ?, ?, ?, ?, 0, 'GBP', 0, 'spend', NULL)`,
    );
    insert.run("m1", "2022-08-15", "2022-08", "Old Shop", "Old Shop", -1000);
    insert.run("m2", "2023-01-15", "2023-01", "Old Shop", "Old Shop", -1100);
    insert.run("m3", "2025-06-15", "2025-06", "Old Shop", "Old Shop", -1200);
    insert.run(
      "m4",
      "2026-09-15",
      "2026-09",
      "Recent Shop",
      "Recent Shop",
      -1300,
    );
    insert.run(
      "m5",
      "2026-10-15",
      "2026-10",
      "Recent Shop",
      "Recent Shop",
      -1400,
    );
    db.close();

    process.env["CHITRAGUPTA_STORE_DIR"] = dir;
    const snap = buildSnapshot();
    expect(snap.months.map((m) => m.key)).toEqual([
      "2026-10",
      "2026-09",
      "2025-06",
      "2023-01",
      "2022-08",
    ]);
    expect(snap.months.at(-1)).toEqual({
      key: "2022-08",
      label: "August 2022",
    });
    // Instant first paint is unchanged: only the two newest months of rows.
    expect([...new Set(snap.txns.map((t) => t.monthKey))].sort()).toEqual([
      "2026-09",
      "2026-10",
    ]);
  });

  it("mirrors the API mapper: description becomes the note, no fx is invented, same-day rows are newest first", () => {
    dir = mkdtempSync(join(tmpdir(), "chitragupta-snap-"));
    const db = openStore(dir);
    const insert = db.prepare(
      `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
         description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
       VALUES (?, 'zonito', 'Main', ?, '2026-10', ?, 'Trainline', ?, 0, ?, 0, 'spend', 'Transport')`,
    );
    insert.run(
      "n1",
      "2026-10-05 09:00:00",
      "Train ticket to Edinburgh",
      -1000,
      "GBP",
    );
    insert.run("n2", "2026-10-05 17:30:00", "Trainline", -2000, "GBP");
    // A foreign-currency row: the snapshot selection is GBP-only, exactly
    // as the API mapper drops non-GBP rows instead of decorating them.
    insert.run("n3", "2026-10-06", "Train ticket to Paris", -3000, "EUR");
    db.close();

    process.env["CHITRAGUPTA_STORE_DIR"] = dir;
    const snap = buildSnapshot();
    // Newest first within the day, like /api/transactions' ordering.
    expect(snap.txns.map((t) => t.id)).toEqual(["n2", "n1"]);
    const [later, earlier] = snap.txns;
    expect(earlier!.note).toBe("Train ticket to Edinburgh");
    expect(later!.note).toBeUndefined();
    expect(earlier!.fx).toBeUndefined();
    expect(later!.fx).toBeUndefined();

    // The same rows through the API mapper carry the same note/fx shape.
    const apiEarlier = apiTxnToTxn({
      id: "n1",
      person: "zonito",
      account: "Main",
      date: "2026-10-05 09:00:00",
      month: "2026-10",
      description: "Train ticket to Edinburgh",
      merchant: "Trainline",
      amountMinor: -1000,
      currency: "GBP",
      movement: "spend",
      category: "Transport",
    });
    expect(apiEarlier!.note).toBe(earlier!.note);
    expect(apiEarlier!.fx).toBe(earlier!.fx);
  });

  it("carries income rows in txns for both snapshot months, identical to the API mapper, with the Money-in feed unchanged", () => {
    dir = mkdtempSync(join(tmpdir(), "chitragupta-snap-"));
    const db = openStore(dir);
    const insert = db.prepare(
      `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
         description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
       VALUES (?, 'zonito', 'Main', ?, ?, ?, ?, ?, 0, 'GBP', 0, ?, NULL)`,
    );
    // Salary in the current month and the previous month, plus a spend
    // row each month so both months are real snapshot months.
    insert.run(
      "sal-oct",
      "2026-10-28",
      "2026-10",
      "ACME PAYROLL",
      "ACME PAYROLL",
      300000,
      "income",
    );
    insert.run(
      "sal-sep",
      "2026-09-28",
      "2026-09",
      "ACME PAYROLL",
      "ACME PAYROLL",
      295000,
      "income",
    );
    insert.run(
      "sp-oct",
      "2026-10-05",
      "2026-10",
      "Corner Shop",
      "Corner Shop",
      -1500,
      "spend",
    );
    insert.run(
      "sp-sep",
      "2026-09-05",
      "2026-09",
      "Corner Shop",
      "Corner Shop",
      -1200,
      "spend",
    );
    db.close();

    process.env["CHITRAGUPTA_STORE_DIR"] = dir;
    const snap = buildSnapshot();

    // Both months' salary rows are in txns, with the income kind.
    const oct = snap.txns.find((t) => t.id === "sal-oct");
    const sep = snap.txns.find((t) => t.id === "sal-sep");
    expect(oct?.kind).toBe("income");
    expect(sep?.kind).toBe("income");

    // Field-for-field parity with the API mapper for the same rows
    // (the API's category for an uncategorised income row is One-off,
    // per CATEGORY_SQL — the same fallback resolveCategory gives).
    const apiOct = apiTxnToTxn({
      id: "sal-oct",
      person: "zonito",
      account: "Main",
      date: "2026-10-28",
      month: "2026-10",
      description: "ACME PAYROLL",
      merchant: "ACME PAYROLL",
      amountMinor: 300000,
      currency: "GBP",
      movement: "income",
      category: "One-off",
    });
    const apiSep = apiTxnToTxn({
      id: "sal-sep",
      person: "zonito",
      account: "Main",
      date: "2026-09-28",
      month: "2026-09",
      description: "ACME PAYROLL",
      merchant: "ACME PAYROLL",
      amountMinor: 295000,
      currency: "GBP",
      movement: "income",
      category: "One-off",
    });
    expect(oct).toEqual(apiOct);
    expect(sep).toEqual(apiSep);

    // The Home Money-in feed derivation is unchanged: current-month
    // positive income only — September's salary is not in it — and the
    // payroll description still earns the "Salary" type label.
    expect(snap.income).toEqual([
      { day: 28, amount: 3000, owner: "zonito", type: "Salary" },
    ]);
  });

  it("returns the honest empty snapshot when no store is configured", () => {
    // Hermetic: buildSnapshot loads .env from the working directory, so
    // point cwd at an empty temp dir — otherwise a developer's real .env
    // resurrects CHITRAGUPTA_STORE_DIR after the delete below.
    dir = mkdtempSync(join(tmpdir(), "chitragupta-noenv-"));
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      delete process.env["CHITRAGUPTA_STORE_DIR"];
      const snap = buildSnapshot();
      expect(snap.configured).toBe(false);
      expect(snap.txns).toEqual([]);
    } finally {
      process.chdir(prevCwd);
    }
  });
});
