import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ingestAll, recomputeAggregates } from "@/lib/ingest/ingest";
import { seedMerchantMemory } from "@/lib/ingest/merchants";
import { openStore } from "@/lib/ingest/store";

const DATA_DIR = process.env["CHITRAGUPTA_DATA_DIR"]?.trim() || null;
const describePenny = DATA_DIR ? describe : describe.skip;

/**
 * B1 acceptance on the repro fixture. The repro Originals are only ever
 * READ: they are ingested into a throwaway store under /tmp (the copy),
 * and the correction, the aggregate checks and the re-ingests all run
 * against that copy — via the real POST /api/merchants handler and the
 * real ingest path.
 *
 * Fixture facts (verified by ingesting the repro Originals): merchant
 * "Penny Caulfield" holds 13 rows, every one an outgoing transfer stored
 * as movement 'aside' with category NULL; the October 2026 row is
 * £148.00. October 2026 School spend before the correction is £69.99
 * (Atom Learning), so after promotion it must be £217.99.
 */
describePenny("Penny Caulfield acceptance (repro copy in /tmp)", () => {
  const prevEnv = process.env["CHITRAGUPTA_STORE_DIR"];
  let dir: string | null = null;

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env["CHITRAGUPTA_STORE_DIR"];
    else process.env["CHITRAGUPTA_STORE_DIR"] = prevEnv;
  });

  it("promotes every Penny row to School spend (£217.99 in Oct 2026) and re-ingest does not revert it", async () => {
    dir = mkdtempSync(join(tmpdir(), "chitra-penny-"));

    // Build the copy and pin the baseline.
    const seed = openStore(dir);
    ingestAll(seed, DATA_DIR!, "zonito");
    seedMerchantMemory(seed);
    recomputeAggregates(seed, "zonito");
    const baseline = seed
      .prepare(
        `SELECT movement, category FROM transactions WHERE merchant = 'Penny Caulfield'`,
      )
      .all() as { movement: string; category: string | null }[];
    expect(baseline).toHaveLength(13);
    expect(baseline.every((r) => r.movement === "aside")).toBe(true);
    expect(baseline.every((r) => r.category === null)).toBe(true);
    const schoolBefore = seed
      .prepare(
        `SELECT spend_minor FROM month_aggregates
         WHERE person = 'zonito' AND year_month = '2026-10' AND category = 'School' AND currency = 'GBP'`,
      )
      .get() as { spend_minor: number };
    expect(schoolBefore.spend_minor).toBe(6999);
    seed.close();

    // The user correction, through the real endpoint.
    process.env["CHITRAGUPTA_STORE_DIR"] = dir;
    const api = await import("@/lib/api");
    const post = await api.handleChitraguptaApi(
      new Request("http://local/api/merchants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          merchant: "Penny Caulfield",
          category: "School",
          source: "user",
        }),
      }),
    );
    expect(post?.status).toBe(200);
    expect(await post!.json()).toMatchObject({ ok: true });

    const expectPennySchool = async () => {
      // Every Penny row resolves to School (and, all being outgoing
      // aside rows, now moves as spend) through the transactions API.
      const txRes = await api.handleChitraguptaApi(
        new Request(
          "http://local/api/transactions?merchant=Penny%20Caulfield&limit=1000",
        ),
      );
      expect(txRes?.status).toBe(200);
      const txBody = (await txRes!.json()) as {
        count: number;
        transactions: { category: string; movement: string }[];
      };
      expect(txBody.count).toBe(13);
      expect(txBody.transactions.every((t) => t.category === "School")).toBe(
        true,
      );
      expect(txBody.transactions.every((t) => t.movement === "spend")).toBe(
        true,
      );
      // October 2026 School spend: £69.99 Atom Learning + £148 Penny.
      const aggRes = await api.handleChitraguptaApi(
        new Request("http://local/api/aggregates?month=2026-10&person=zonito"),
      );
      expect(aggRes?.status).toBe(200);
      const aggBody = (await aggRes!.json()) as {
        rows: { category: string; spend_minor: number }[];
      };
      const school = aggBody.rows.find((r) => r.category === "School");
      expect(school?.spend_minor).toBe(21799);
    };
    await expectPennySchool();

    // The memory row carries the user source.
    const check = openStore(dir);
    const memory = check
      .prepare(
        "SELECT category, source FROM merchant_memory WHERE merchant = 'Penny Caulfield'",
      )
      .get() as { category: string; source: string };
    expect(memory).toEqual({ category: "School", source: "user" });
    check.close();

    // A plain re-ingest adds nothing and reverts nothing.
    const again = openStore(dir);
    const second = ingestAll(again, DATA_DIR!, "zonito");
    expect(second.reduce((n, r) => n + r.rowsAdded, 0)).toBe(0);
    const stillSpend = again
      .prepare(
        `SELECT COUNT(*) AS n FROM transactions
         WHERE merchant = 'Penny Caulfield' AND movement = 'spend'`,
      )
      .get() as { n: number };
    expect(stillSpend.n).toBe(13);
    again.close();
    await expectPennySchool();

    // A full rules-version rebuild (memory carried into the temp store)
    // also keeps Penny as spend: the ingest learning rule fires there.
    const rebuild = openStore(dir);
    rebuild
      .prepare("UPDATE meta SET value = '0' WHERE key = 'rules_version'")
      .run();
    const rebuilt = ingestAll(rebuild, DATA_DIR!, "zonito");
    expect(rebuilt.every((r) => r.ok)).toBe(true);
    const afterRebuild = rebuild
      .prepare(
        `SELECT movement FROM transactions WHERE merchant = 'Penny Caulfield'`,
      )
      .all() as { movement: string }[];
    expect(afterRebuild).toHaveLength(13);
    expect(afterRebuild.every((r) => r.movement === "spend")).toBe(true);
    rebuild.close();
    await expectPennySchool();
  }, 180_000);
});
