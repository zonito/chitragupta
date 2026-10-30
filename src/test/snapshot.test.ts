import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@/lib/ingest/store";
import { buildSnapshot } from "@/lib/snapshot.server";

/**
 * Regression tests for the UI snapshot builder against real-store quirks:
 * some stored effective_date values carry a full "YYYY-MM-DD HH:MM:SS"
 * timestamp, and the review queue can hold merchants with no card payments.
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

  it("normalises timestamp-shaped dates and survives a spend-free review merchant", () => {
    dir = mkdtempSync(join(tmpdir(), "chitragupta-snap-"));
    const db = openStore(dir);
    const insert = db.prepare(
      `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
         description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
       VALUES (?, 'zonito', 'Main', ?, ?, ?, ?, ?, 0, 'GBP', 0, ?, NULL)`,
    );
    insert.run("a", "2026-10-05 13:58:16", "2026-10", "Ocado", "Ocado", -4250, "spend");
    insert.run("b", "2026-10-06", "2026-10", "Ocado", "Ocado", -1000, "spend");
    // Income-only merchant: lands in the review queue with no spend rows.
    insert.run("c", "2026-10-07", "2026-10", "Mystery Sender", "Mystery Sender", 5000, "income");
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
    const review = snap.merchantReview.find((m) => m.name === "Mystery Sender");
    expect(review?.detail).toContain("No card payments");
    expect(snap.accounts[0]?.name).toBe("Revolut Main");
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
    insert.run("m4", "2026-09-15", "2026-09", "Recent Shop", "Recent Shop", -1300);
    insert.run("m5", "2026-10-15", "2026-10", "Recent Shop", "Recent Shop", -1400);
    db.close();

    process.env["CHITRAGUPTA_STORE_DIR"] = dir;
    const snap = buildSnapshot();
    expect(snap.months.map((m) => m.key)).toEqual([
      "2026-10", "2026-09", "2025-06", "2023-01", "2022-08",
    ]);
    expect(snap.months.at(-1)).toEqual({ key: "2022-08", label: "August 2022" });
    // Instant first paint is unchanged: only the two newest months of rows.
    expect([...new Set(snap.txns.map((t) => t.monthKey))].sort()).toEqual(["2026-09", "2026-10"]);
  });

  it("returns the honest empty snapshot when no store is configured", () => {
    delete process.env["CHITRAGUPTA_STORE_DIR"];
    const snap = buildSnapshot();
    expect(snap.configured).toBe(false);
    expect(snap.txns).toEqual([]);
  });
});
