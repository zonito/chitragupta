import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ingestAll } from "@/lib/ingest/ingest";
import { openStore } from "@/lib/ingest/store";
import { buildSnapshot } from "@/lib/snapshot.server";

const DATA_DIR = process.env["CHITRAGUPTA_DATA_DIR"]?.trim() || null;
const describeRepro = DATA_DIR ? describe : describe.skip;

/**
 * The rebuilt detector against the real store: genuine subscriptions in,
 * grocery/fuel noise out, and a stopped subscription shown as Ended.
 */
describeRepro("subscriptions from the real Originals", () => {
  const prevEnv = process.env["CHITRAGUPTA_STORE_DIR"];
  let dir: string | null = null;

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env["CHITRAGUPTA_STORE_DIR"];
    else process.env["CHITRAGUPTA_STORE_DIR"] = prevEnv;
  });

  it("detects the real subscriptions and none of the noise", () => {
    dir = mkdtempSync(join(tmpdir(), "chitra-subs-"));
    const db = openStore(dir);
    ingestAll(db, DATA_DIR!, "zonito");
    db.close();

    process.env["CHITRAGUPTA_STORE_DIR"] = dir;
    const snap = buildSnapshot();
    const byName = new Map(snap.subs.map((s) => [s.name, s]));

    expect(byName.get("Atom Learning")).toMatchObject({
      freq: "Monthly",
      status: "Active",
    });
    expect(byName.get("bitwarden.com")).toMatchObject({
      freq: "Yearly",
      status: "Active",
    });
    expect(byName.get("Peloton")).toMatchObject({
      freq: "Monthly",
      status: "Ended",
    });
    for (const noise of ["Mahavir Sweet Mart", "BP", "Greggs", "Esso"]) {
      expect(byName.has(noise), `${noise} must not be a subscription`).toBe(false);
    }
  }, 120_000);

  it("gives Tesla exactly its 19 charge ids, and /api/transactions?ids= serves exactly those rows", async () => {
    dir = mkdtempSync(join(tmpdir(), "chitra-subs-"));
    const db = openStore(dir);
    ingestAll(db, DATA_DIR!, "zonito");
    db.close();

    process.env["CHITRAGUPTA_STORE_DIR"] = dir;
    const snap = buildSnapshot();
    const tesla = snap.subs.find((s) => s.name === "Tesla");
    expect(tesla, "a Tesla subscription is detected").toBeTruthy();
    expect(tesla!.freq).toBe("Monthly");
    expect(tesla!.charges).toBe(19);
    expect(tesla!.chargeIds).toHaveLength(19);
    expect(new Set(tesla!.chargeIds).size).toBe(19);

    // The 19 ids are exactly the £9.99-cluster rows: 18 at £9.99, 1 at £9.84.
    const check = openStore(dir);
    const placeholders = tesla!.chargeIds.map(() => "?").join(", ");
    const rows = check
      .prepare(
        `SELECT amount_minor FROM transactions WHERE fingerprint IN (${placeholders})`,
      )
      .all(...tesla!.chargeIds) as { amount_minor: number }[];
    check.close();
    expect(rows).toHaveLength(19);
    const counts = new Map<number, number>();
    for (const r of rows) {
      const a = Math.abs(r.amount_minor);
      counts.set(a, (counts.get(a) ?? 0) + 1);
    }
    expect(counts.get(999)).toBe(18);
    expect(counts.get(984)).toBe(1);

    // The endpoint returns exactly those rows for the ids param.
    const api = await import("@/lib/api");
    const res = await api.handleChitraguptaApi(
      new Request(
        `http://local/api/transactions?ids=${encodeURIComponent(tesla!.chargeIds.join(","))}&limit=1000`,
      ),
    );
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as {
      count: number;
      transactions: { id: string }[];
    };
    expect(body.count).toBe(19);
    expect(new Set(body.transactions.map((t) => t.id))).toEqual(
      new Set(tesla!.chargeIds),
    );
  }, 120_000);
});
