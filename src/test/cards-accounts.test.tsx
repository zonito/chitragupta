import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type Database from "better-sqlite3";

// The Accounts section's cards link to Activity; render the router
// Link as a plain anchor (same pattern as home-available.test.tsx).
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      search,
      children,
      ...rest
    }: {
      to: string;
      search?: Record<string, string>;
      children: React.ReactNode;
    } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
      <a href={`${to}?${new URLSearchParams(search ?? {}).toString()}`} {...rest}>
        {children}
      </a>
    ),
  };
});

// Activity's on-demand month fetcher, spied so the account-scope test
// can assert the server-side filter parameters.
const mocks = vi.hoisted(() => ({
  fetchTxns: vi.fn(async (): Promise<import("@/lib/data").Txn[]> => []),
}));
vi.mock("@/lib/txn-map", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/txn-map")>();
  return { ...actual, fetchApiTransactions: mocks.fetchTxns };
});

import { Cards } from "@/routes/cards";
import { Activity } from "@/routes/activity";
import { PersonProvider, usePerson } from "@/components/shell";
import { DocumentsProvider } from "@/components/documents";
import {
  hydrateData,
  monthOptions,
  type DataSnapshot,
  type Txn,
} from "@/lib/data";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";

/**
 * Follow-up 3: the Cards Accounts section (per-account insights from
 * GET /api/accounts, balances from the snapshot's selected ingest
 * runs) and Activity's account scope (a real, visible, clearable
 * filter keyed by (store person, store account) so two people's
 * same-named accounts never merge).
 */

const ACCOUNTS_PAYLOAD = {
  ok: true,
  month: "2026-10",
  accounts: [
    {
      person: "zonito",
      account: "Pro",
      spend: { GBP: 12345 },
      moneyIn: { GBP: 50000 },
      topCategories: [{ category: "Groceries", spend_minor: 6000 }],
      biggest: { merchant: "Ocado", amount_minor: 4500, currency: "GBP", date: "2026-10-21" },
    },
    {
      person: "nikhila",
      account: "Monzo Current",
      spend: { GBP: 2000 },
      moneyIn: {},
      topCategories: [],
      biggest: null,
    },
  ],
};

function PersonSwitcher() {
  const { setPerson } = usePerson();
  return (
    <div>
      <button onClick={() => setPerson("zonito")}>view-zonito</button>
      <button onClick={() => setPerson("nikhila")}>view-nikhila</button>
    </div>
  );
}

beforeEach(() => {
  hydrateData(structuredClone(SAMPLE_SNAPSHOT) as DataSnapshot);
  localStorage.clear();
  window.history.pushState({}, "", "/");
  mocks.fetchTxns.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(ACCOUNTS_PAYLOAD), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

describe("Cards Accounts section", () => {
  it("household view groups every account by owner and renders the server figures", async () => {
    render(
      <PersonProvider>
        <Cards />
      </PersonProvider>,
    );
    expect(await screen.findByText("Accounts")).toBeTruthy();
    // Owner group headings.
    expect(screen.getByRole("heading", { name: "👨 Zonito" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "👩 Nikhila" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "🤝 Joint" })).toBeTruthy();
    // Balance from the snapshot's selected run for Zonito's Pro.
    expect(screen.getByText("£342.10")).toBeTruthy();
    // This month's figures from /api/accounts, in the store's month.
    expect(await screen.findByText(/Spent £123\.45 · In £500\.00/)).toBeTruthy();
    expect(screen.getAllByText(/October 2026/).length).toBeGreaterThan(0);
    expect(screen.getByText("Groceries")).toBeTruthy();
    expect(screen.getByText(/Biggest payment: Ocado · £45\.00/)).toBeTruthy();
    // The card links to Activity scoped by (store person, store account).
    const link = screen.getByRole("link", { name: /Revolut Pro activity/ });
    expect(link.getAttribute("href")).toContain("account=Pro");
    expect(link.getAttribute("href")).toContain("accountPerson=zonito");
  });

  it("a single-person view shows that person's accounts plus Joint, not the other's", async () => {
    render(
      <PersonProvider>
        <PersonSwitcher />
        <Cards />
      </PersonProvider>,
    );
    await screen.findByText("Accounts");
    fireEvent.click(screen.getByText("view-zonito"));
    expect(screen.getByText("Revolut Main")).toBeTruthy();
    expect(screen.getByText("Joint Bills")).toBeTruthy();
    expect(screen.queryByText("Monzo Current")).toBeNull();
    expect(screen.queryByText("Amex Gold")).toBeNull();
    fireEvent.click(screen.getByText("view-nikhila"));
    expect(screen.getByText("Monzo Current")).toBeTruthy();
    expect(screen.getByText("Joint Bills")).toBeTruthy();
    expect(screen.queryByText("Revolut Main")).toBeNull();
  });
});

describe("Activity account scope", () => {
  const mkTxn = (over: Partial<Txn>): Txn => ({
    id: "x",
    date: "2026-10-20",
    day: 20,
    monthKey: "2026-10",
    merchant: "M",
    category: "Groceries",
    amount: 10,
    owner: "zonito",
    account: "Revolut Pro · Zonito",
    accountId: "Pro",
    kind: "spend",
    ...over,
  });

  function hydrateScoped() {
    const snap = structuredClone(SAMPLE_SNAPSHOT) as DataSnapshot;
    snap.txns = [
      mkTxn({ id: "z-pro", merchant: "Zonito Pro Merchant" }),
      mkTxn({
        id: "n-pro",
        merchant: "Nikhila Pro Merchant",
        owner: "nikhila",
        account: "Revolut Pro · Nikhila",
        accountId: "Pro",
      }),
      mkTxn({
        id: "z-main",
        merchant: "Zonito Main Merchant",
        account: "Revolut Main · Zonito",
        accountId: "Main",
      }),
    ];
    hydrateData(snap);
  }

  it("shows only the scoped (person, account) rows, with a visible chip that clears cleanly", () => {
    hydrateScoped();
    window.history.pushState({}, "", "/activity?account=Pro&accountPerson=zonito");
    render(
      <PersonProvider>
        <DocumentsProvider>
          <Activity />
        </DocumentsProvider>
      </PersonProvider>,
    );
    // Same store account name "Pro", two people: only Zonito's rows.
    expect(screen.getByText("Zonito Pro Merchant")).toBeTruthy();
    expect(screen.queryByText("Nikhila Pro Merchant")).toBeNull();
    expect(screen.queryByText("Zonito Main Merchant")).toBeNull();
    // The scope stays visible as a chip naming the account… (the
    // chip is the clear button's pill; the account picker's option
    // carries the same name, so query the chip itself)
    const chip = screen
      .getByRole("button", { name: "Clear account filter" })
      .closest("span");
    expect(chip?.textContent).toContain("Revolut Pro");
    // …and clearing it restores the whole month.
    fireEvent.click(screen.getByRole("button", { name: "Clear account filter" }));
    expect(screen.getByText("Nikhila Pro Merchant")).toBeTruthy();
    expect(screen.getByText("Zonito Main Merchant")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear account filter" })).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("a scoped fetch for an older month sends person + account to the server", async () => {
    hydrateScoped();
    window.history.pushState({}, "", "/activity?account=Pro&accountPerson=zonito");
    render(
      <PersonProvider>
        <DocumentsProvider>
          <Activity />
        </DocumentsProvider>
      </PersonProvider>,
    );
    const target = monthOptions().find((o) => o.key !== "2026-10")!.key;
    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[selects.length - 1]!, { target: { value: target } });
    await waitFor(() =>
      expect(mocks.fetchTxns).toHaveBeenCalledWith({
        month: target,
        person: "zonito",
        account: "Pro",
        limit: "1000",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Gated repro2: per-account figures against direct SQL on a store
// built from the real fixture, and balance agreement with ingest
// status (one Zonito account, one Nikhila account).
// ---------------------------------------------------------------------------

const DATA_DIR = process.env["CHITRAGUPTA_DATA_DIR"];
const BOTH_PEOPLE =
  !!DATA_DIR &&
  existsSync(
    join(DATA_DIR, "Originals", "account-statement_2023-02-01_2026-10-31_en-sg_f68986.csv"),
  );

describe.runIf(BOTH_PEOPLE)("Cards accounts figures (repro2, direct SQL)", () => {
  let db: Database.Database;
  let storeDir: string;
  let month: string;
  let accounts: {
    person: string;
    account: string;
    spend: Record<string, number>;
    moneyIn: Record<string, number>;
    topCategories: { category: string; spend_minor: number }[];
    biggest: { merchant: string; amount_minor: number; currency: string; date: string } | null;
  }[];
  let statusAccounts: { person: string; account: string; balanceMinor: number | null }[];

  const insightFor = (person: string, account: string) =>
    accounts.find((a) => a.person === person && a.account === account)!;

  beforeAll(async () => {
    const { openStore } = await import("@/lib/ingest/store");
    const { ingestAll } = await import("@/lib/ingest/ingest");
    const { handleChitraguptaApi } = await import("@/lib/api");
    storeDir = mkdtempSync(join(tmpdir(), "chitra-cards-"));
    db = openStore(storeDir);
    ingestAll(db, DATA_DIR!);
    process.env["CHITRAGUPTA_STORE_DIR"] = storeDir;
    const accountsRes = await handleChitraguptaApi(new Request("http://test/api/accounts"));
    expect(accountsRes).not.toBeNull();
    const body = (await accountsRes!.json()) as { month: string; accounts: typeof accounts };
    month = body.month;
    accounts = body.accounts;
    const statusRes = await handleChitraguptaApi(new Request("http://test/api/ingest/status"));
    expect(statusRes).not.toBeNull();
    const status = (await statusRes!.json()) as { accounts: typeof statusAccounts };
    statusAccounts = status.accounts;
  }, 180_000);

  afterAll(() => {
    db.close();
    rmSync(storeDir, { recursive: true, force: true });
  });

  it("covers exactly the accounts ingest status reports, in the store's latest month", () => {
    expect(month).toBe("2026-10");
    const key = (a: { person: string; account: string }) => `${a.person}|${a.account}`;
    expect(new Set(accounts.map(key))).toEqual(new Set(statusAccounts.map(key)));
  });

  it("Zonito Pro: month spend and money-in equal direct SQL", () => {
    const row = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN movement = 'spend' AND amount_minor < 0 THEN -amount_minor END), 0) AS spend,
           COALESCE(SUM(CASE WHEN movement IN ('income', 'interest') AND amount_minor > 0 THEN amount_minor END), 0) AS money_in
         FROM transactions
         WHERE person = 'zonito' AND account = 'Pro' AND year_month = ? AND currency = 'GBP'`,
      )
      .get(month) as { spend: number; money_in: number };
    const insight = insightFor("zonito", "Pro");
    expect(insight.spend["GBP"]).toBe(row.spend);
    expect(insight.moneyIn["GBP"]).toBe(row.money_in);
    expect(row.spend).toBeGreaterThan(0);
  });

  it("Nikhila Pro: top category and biggest payment equal direct SQL", async () => {
    const rows = db
      .prepare(
        `SELECT COALESCE(t.category, m.category,
           CASE t.movement
             WHEN 'spend' THEN 'One-off' WHEN 'income' THEN 'One-off'
             WHEN 'aside' THEN 'Moved aside' WHEN 'fee' THEN 'Fees'
             WHEN 'interest' THEN 'Interest' ELSE 'Transfer' END) AS category,
           SUM(-t.amount_minor) AS s
         FROM transactions t LEFT JOIN merchant_memory m ON m.merchant = t.merchant
         WHERE t.person = 'nikhila' AND t.account = 'Pro' AND t.year_month = ?
           AND t.movement = 'spend' AND t.amount_minor < 0 AND t.currency = 'GBP'
         GROUP BY 1`,
      )
      .all(month) as { category: string; s: number }[];
    // Fold exactly as the endpoint does (categoryFolder in api.ts):
    // system labels and live categories pass, anything else is One-off.
    const { listCategories } = await import("@/lib/ingest/categories");
    const known = new Set(listCategories(db).map((c) => c.name));
    const foldName = (name: string): string =>
      name === "Transfer" || name === "Moved aside" || known.has(name) ? name : "One-off";
    const folded = new Map<string, number>();
    for (const r of rows) {
      const name = foldName(r.category);
      folded.set(name, (folded.get(name) ?? 0) + r.s);
    }
    const expectedTop = [...folded.entries()]
      .map(([category, spend_minor]) => ({ category, spend_minor }))
      .sort((a, b) => b.spend_minor - a.spend_minor || a.category.localeCompare(b.category))[0]!;
    const insight = insightFor("nikhila", "Pro");
    expect(insight.topCategories[0]).toEqual(expectedTop);
    expect(insight.topCategories.length).toBeLessThanOrEqual(3);

    const big = db
      .prepare(
        `SELECT description, amount_minor, currency, substr(effective_date, 1, 10) AS date FROM transactions
         WHERE person = 'nikhila' AND account = 'Pro' AND year_month = ?
           AND movement = 'spend' AND amount_minor < 0
         ORDER BY ABS(amount_minor) DESC LIMIT 1`,
      )
      .get(month) as { description: string; amount_minor: number; currency: string; date: string };
    expect(insight.biggest).toEqual({
      merchant: big.description,
      amount_minor: Math.abs(big.amount_minor),
      currency: big.currency,
      date: big.date,
    });
  });

  it("the snapshot's balance for Zonito's Pro agrees with ingest status", async () => {
    const { buildSnapshot } = await import("@/lib/snapshot.server");
    const snap = buildSnapshot();
    const fromSnapshot = snap.accounts.find(
      (a) => a.person === "zonito" && a.accountId === "Pro",
    )!;
    const fromStatus = statusAccounts.find(
      (a) => a.person === "zonito" && a.account === "Pro",
    )!;
    expect(fromSnapshot.balanceMinor).toBe(fromStatus.balanceMinor);
    expect(fromSnapshot.balanceMinor).toBe(15833);
  });
});
