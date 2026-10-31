import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type Database from "better-sqlite3";

import { Subs } from "@/routes/subscriptions";
import { Activity } from "@/routes/activity";
import { PersonProvider } from "@/components/shell";
import { DocumentsProvider } from "@/components/documents";
import { hydrateData, monthlyOf, type DataSnapshot, type Sub, type Txn } from "@/lib/data";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";

/**
 * Follow-up 7: human subscription overrides (subscription_overrides,
 * keyed by canonical merchant) consulted where subscriptions are
 * computed — the snapshot — so the Subscriptions screen, Coach and
 * Home Coming up all honour a correction at once. force / suppress /
 * cancelled semantics, undo restoring the detector exactly, survival
 * across rebuilds.
 */

let fetchCalls: { url: string; body: unknown }[] = [];

beforeEach(() => {
  hydrateData(structuredClone(SAMPLE_SNAPSHOT) as DataSnapshot);
  localStorage.clear();
  window.history.pushState({}, "", "/");
  fetchCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      fetchCalls.push({ url: String(url), body });
      if (String(url).includes("/api/subscriptions/override")) {
        return new Response(JSON.stringify({ ok: true, merchant: body?.merchant, mode: body?.mode ?? null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, transactions: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Subscription override controls", () => {
  it("a suppressed merchant appears under Removed by you in the Ended area, with Restore", async () => {
    const snap = structuredClone(SAMPLE_SNAPSHOT) as DataSnapshot;
    snap.subOverrides = [{ merchant: "oldshop", label: "Old Shop", mode: "suppress" }];
    hydrateData(snap);
    render(
      <PersonProvider>
        <Subs />
      </PersonProvider>,
    );
    // SAMPLE has no Ended subs, so the section exists only because of
    // the removed entry — and it starts collapsed like Ended does.
    fireEvent.click(screen.getByRole("button", { name: /Ended/ }));
    expect(await screen.findByText("Removed by you")).toBeTruthy();
    expect(screen.getByText("Old Shop")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() =>
      expect(fetchCalls).toContainEqual({
        url: "/api/subscriptions/override",
        body: { merchant: "Old Shop", mode: null },
      }),
    );
  });

  it("the detail sheet offers Mark cancelled and Not a subscription, posting the merchant", async () => {
    render(
      <PersonProvider>
        <Subs />
      </PersonProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Netflix transactions/ }));
    expect(await screen.findByText("Your correction")).toBeTruthy();
    expect(screen.getByText(/Applies to all Netflix payments/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mark cancelled" }));
    await waitFor(() =>
      expect(fetchCalls).toContainEqual({
        url: "/api/subscriptions/override",
        body: { merchant: "Netflix", mode: "cancelled" },
      }),
    );
    expect(await screen.findByText("Marked cancelled.")).toBeTruthy();
  });

  it("the Activity sheet marks a non-subscription merchant as a subscription, merchant-wide", async () => {
    const snap = structuredClone(SAMPLE_SNAPSHOT) as DataSnapshot;
    snap.txns = [
      {
        id: "cs-1",
        date: "2026-10-20",
        day: 20,
        monthKey: "2026-10",
        merchant: "Corner Shop",
        category: "Groceries",
        amount: 12,
        owner: "zonito",
        account: "Revolut Main · Zonito",
        accountId: "Main",
        kind: "spend",
      } as Txn,
    ];
    hydrateData(snap);
    render(
      <PersonProvider>
        <DocumentsProvider>
          <Activity />
        </DocumentsProvider>
      </PersonProvider>,
    );
    fireEvent.click(screen.getByText("Corner Shop"));
    expect(await screen.findByText(/Applies to all Corner Shop payments/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mark as subscription" }));
    await waitFor(() =>
      expect(fetchCalls).toContainEqual({
        url: "/api/subscriptions/override",
        body: { merchant: "Corner Shop", mode: "force" },
      }),
    );
    expect(await screen.findByText("A subscription you added.")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Gated repro2: the four flows on real data, through the API and the
// snapshot builder (the one place subscriptions are computed).
// ---------------------------------------------------------------------------

const DATA_DIR = process.env["CHITRAGUPTA_DATA_DIR"];
const BOTH_PEOPLE =
  !!DATA_DIR &&
  existsSync(
    join(DATA_DIR, "Originals", "account-statement_2023-02-01_2026-10-31_en-sg_f68986.csv"),
  );

describe.runIf(BOTH_PEOPLE)("Subscription overrides (repro2)", () => {
  let db: Database.Database;
  let storeDir: string;
  let api: (req: Request) => Promise<Response | null>;
  let buildSnapshot: () => DataSnapshot;
  let baseline: Sub[] = [];

  const post = async (merchant: string, mode: string | null) => {
    const res = await api(
      new Request("http://test/api/subscriptions/override", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ merchant, mode }),
      }),
    );
    expect(res).not.toBeNull();
    expect(((await res!.json()) as { ok: boolean }).ok).toBe(true);
  };
  const shape = (subs: Sub[]) =>
    subs.map((s) => ({
      name: s.name,
      status: s.status,
      amount: s.amount,
      charges: s.charges,
      nextExpected: s.nextExpected,
    }));
  const activeMonthlyTotal = (subs: Sub[]) =>
    subs.filter((s) => s.status === "Active").reduce((a, s) => a + monthlyOf(s), 0);

  beforeAll(async () => {
    const { openStore } = await import("@/lib/ingest/store");
    const { ingestAll } = await import("@/lib/ingest/ingest");
    const { handleChitraguptaApi } = await import("@/lib/api");
    const snapshotModule = await import("@/lib/snapshot.server");
    api = handleChitraguptaApi as typeof api;
    buildSnapshot = snapshotModule.buildSnapshot as typeof buildSnapshot;
    storeDir = mkdtempSync(join(tmpdir(), "chitra-subs-"));
    db = openStore(storeDir);
    ingestAll(db, DATA_DIR!);
    process.env["CHITRAGUPTA_STORE_DIR"] = storeDir;
    baseline = buildSnapshot().subs;
  }, 180_000);

  afterAll(() => {
    db.close();
    rmSync(storeDir, { recursive: true, force: true });
  });

  it("baseline: the detector's output is untouched with no overrides (Costco present)", () => {
    expect(baseline.length).toBeGreaterThan(20);
    expect(baseline.some((s) => s.name === "Costco")).toBe(true);
    expect(baseline.some((s) => s.name === "Tesla" && s.status === "Active")).toBe(true);
    // Independent detector run over the store's charges agrees.
    return (async () => {
      const { detectSubscriptions, canonicalMerchant } = await import("@/lib/subscriptions");
      const { accountTxnLabel } = await import("@/lib/txn-map");
      const { dateLabel } = await import("@/lib/data");
      const rows = db
        .prepare(
          `SELECT fingerprint, merchant, effective_date, amount_minor, account, person
           FROM transactions WHERE currency = 'GBP' AND movement = 'spend' AND amount_minor < 0
           ORDER BY effective_date`,
        )
        .all() as {
        fingerprint: string;
        merchant: string;
        effective_date: string;
        amount_minor: number;
        account: string;
        person: string;
      }[];
      const detected = detectSubscriptions(
        rows.map((r) => ({
          id: r.fingerprint,
          merchant: r.merchant,
          date: r.effective_date,
          amountMinor: r.amount_minor,
          account: r.account,
          person: r.person,
        })),
        "2026-10-31",
        { dateLabel, accountLabel: (a, p) => accountTxnLabel(p, a) },
      );
      expect(shape(baseline)).toEqual(shape(detected));
      expect(canonicalMerchant("Costco")).toBe("costco");
    })();
  });

  it("force: a non-pattern merchant appears Active with figures derived from its charges", async () => {
    const { canonicalMerchant } = await import("@/lib/subscriptions");
    const detectedKeys = new Set(baseline.map((s) => canonicalMerchant(s.name)));
    const groups = db
      .prepare(
        `SELECT merchant, COUNT(*) AS n, MAX(effective_date) AS last_date
         FROM transactions WHERE currency = 'GBP' AND movement = 'spend' AND amount_minor < 0
         GROUP BY merchant HAVING n >= 2 ORDER BY merchant`,
      )
      .all() as { merchant: string; n: number; last_date: string }[];
    const candidate = groups.find((g) => !detectedKeys.has(canonicalMerchant(g.merchant)));
    expect(candidate).toBeTruthy();
    const latest = db
      .prepare(
        `SELECT amount_minor FROM transactions
         WHERE merchant = ? AND currency = 'GBP' AND movement = 'spend' AND amount_minor < 0
         ORDER BY effective_date DESC LIMIT 1`,
      )
      .get(candidate!.merchant) as { amount_minor: number };

    await post(candidate!.merchant, "force");
    const subs = buildSnapshot().subs;
    const forced = subs.find((s) => canonicalMerchant(s.name) === canonicalMerchant(candidate!.merchant));
    expect(forced).toBeTruthy();
    expect(forced!.status).toBe("Active");
    expect(forced!.amount).toBe(Math.abs(latest.amount_minor) / 100);
    expect(forced!.charges).toBe(candidate!.n);
    await post(candidate!.merchant, null);
  });

  it("suppress: Costco vanishes from the list and from the active totals Coach reads", async () => {
    const costco = baseline.find((s) => s.name === "Costco")!;
    const beforeTotal = activeMonthlyTotal(baseline);
    await post("Costco", "suppress");
    const snap = buildSnapshot();
    expect(snap.subs.some((s) => s.name === "Costco")).toBe(false);
    expect(activeMonthlyTotal(snap.subs)).toBeCloseTo(beforeTotal - monthlyOf(costco), 6);
    expect(snap.subOverrides).toContainEqual({
      merchant: "costco",
      label: "Costco",
      mode: "suppress",
    });
  });

  it("cancelled: Tesla renders Cancelled and drops out of Coming up and the active total", async () => {
    const tesla = baseline.find((s) => s.name === "Tesla")!;
    const beforeTotal = activeMonthlyTotal(buildSnapshot().subs);
    await post("Tesla", "cancelled");
    const snap = buildSnapshot();
    const after = snap.subs.find((s) => s.name === "Tesla")!;
    expect(after.status).toBe("Cancelled");
    expect(after.nextExpected).toBeNull();
    expect(snap.upcoming.some((u) => u.name === "Tesla")).toBe(false);
    expect(activeMonthlyTotal(snap.subs)).toBeCloseTo(beforeTotal - monthlyOf(tesla), 6);
  });

  it("undo restores the detector's original output exactly, and overrides survive a rebuild", async () => {
    await post("Tesla", null);
    await post("Costco", null);
    expect(shape(buildSnapshot().subs)).toEqual(shape(baseline));

    // Suppress again, force the atomic rebuild, and the correction
    // must still apply on the rebuilt store.
    await post("Costco", "suppress");
    db.prepare("UPDATE meta SET value = '0' WHERE key = 'rules_version'").run();
    const run = await api(
      new Request("http://test/api/ingest/run", { method: "POST" }),
    );
    expect(((await run!.json()) as { ok: boolean }).ok).toBe(true);
    expect(buildSnapshot().subs.some((s) => s.name === "Costco")).toBe(false);
    await post("Costco", null);
    expect(shape(buildSnapshot().subs)).toEqual(shape(baseline));
  });
});
