import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PersonProvider, usePerson } from "@/components/shell";
import { availableFor, hydrateData, type AccountInfo } from "@/lib/data";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-router")>(
    "@tanstack/react-router",
  );
  return {
    ...actual,
    useRouter: () => ({ invalidate: async () => {} }),
    Link: ({
      to,
      children,
      className,
    }: {
      to: string;
      children: React.ReactNode;
      className?: string;
    }) => (
      <a href={to} className={className}>
        {children}
      </a>
    ),
  };
});

// Imported after the router mock is registered.
const { Index } = await import("@/routes/index");

/**
 * Home "Available": the total of the current view's account balances
 * (from the balances the latest real ingest runs recorded) with a
 * per-account breakdown sheet — so a planned spend can be checked
 * against what each account actually holds.
 */

const acct = (over: Partial<AccountInfo>): AccountInfo => ({
  name: "Revolut Main",
  owner: "zonito",
  last: "28 Oct",
  lastDate: "2026-10-28",
  added: 0,
  stale: false,
  balanceMinor: null,
  currency: null,
  ...over,
});

afterEach(() => {
  hydrateData(SAMPLE_SNAPSHOT);
});

describe("availableFor", () => {
  it("household sums every GBP account including Joint; foreign money stays in its own currency", () => {
    hydrateData({
      ...SAMPLE_SNAPSHOT,
      accounts: [
        acct({ name: "Main", balanceMinor: 10000, currency: "GBP" }),
        acct({ name: "USD-Invest", balanceMinor: 5000, currency: "USD" }),
        acct({ name: "EUR Pot", balanceMinor: 3000, currency: "EUR" }),
        acct({
          name: "Joint Bills",
          owner: "joint",
          balanceMinor: 20000,
          currency: "GBP",
        }),
        acct({
          name: "Her Current",
          owner: "nikhila",
          balanceMinor: null,
          currency: null,
          lastDate: "2026-10-29",
        }),
        acct({
          name: "Her Pro",
          owner: "nikhila",
          balanceMinor: 5000,
          currency: "GBP",
        }),
      ],
    });
    const avail = availableFor("household");
    expect(avail.gbpTotal).toBe(350);
    expect(avail.foreign).toEqual([
      { currency: "EUR", total: 30 },
      { currency: "USD", total: 50 },
    ]);
    // Breakdown order: GBP by balance desc (unknown balances last in
    // the GBP group), then foreign by currency.
    expect(avail.accounts.map((a) => a.name)).toEqual([
      "Joint Bills",
      "Main",
      "Her Pro",
      "Her Current",
      "EUR Pot",
      "USD-Invest",
    ]);
    expect(avail.asOf).toBe("2026-10-29");
  });

  it("a zero foreign balance is not reported as money held elsewhere", () => {
    hydrateData({
      ...SAMPLE_SNAPSHOT,
      accounts: [
        acct({ name: "Main", balanceMinor: 10000, currency: "GBP" }),
        acct({ name: "USD-Invest", balanceMinor: 0, currency: "USD" }),
      ],
    });
    const avail = availableFor("household");
    expect(avail.gbpTotal).toBe(100);
    expect(avail.foreign).toEqual([]);
    // The zero-balance USD account still appears in the breakdown.
    expect(avail.accounts.map((a) => a.name)).toContain("USD-Invest");
  });

  it("individual views hold only that person's accounts — Joint is the household's", () => {
    hydrateData({
      ...SAMPLE_SNAPSHOT,
      accounts: [
        acct({ name: "Main", balanceMinor: 10000, currency: "GBP" }),
        acct({
          name: "Joint Bills",
          owner: "joint",
          balanceMinor: 20000,
          currency: "GBP",
        }),
        acct({
          name: "Her Pro",
          owner: "nikhila",
          balanceMinor: 5000,
          currency: "GBP",
        }),
      ],
    });
    const zonito = availableFor("zonito");
    expect(zonito.gbpTotal).toBe(100);
    expect(zonito.accounts.map((a) => a.name)).toEqual(["Main"]);
    const nikhila = availableFor("nikhila");
    expect(nikhila.gbpTotal).toBe(50);
    expect(nikhila.accounts.map((a) => a.name)).toEqual(["Her Pro"]);
  });

  it("no recorded balance anywhere is an honest null, never a zero total", () => {
    hydrateData({
      ...SAMPLE_SNAPSHOT,
      accounts: [
        acct({ name: "Main" }),
        acct({ name: "Her Pro", owner: "nikhila" }),
      ],
    });
    const avail = availableFor("household");
    expect(avail.gbpTotal).toBeNull();
    expect(avail.foreign).toEqual([]);
    expect(avail.accounts).toHaveLength(2);

    hydrateData({ ...SAMPLE_SNAPSHOT, accounts: [] });
    const empty = availableFor("household");
    expect(empty.gbpTotal).toBeNull();
    expect(empty.asOf).toBe("");
  });
});

describe("snapshot account balances", () => {
  let dir: string | null = null;
  const prevEnv = process.env["CHITRAGUPTA_STORE_DIR"];

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
    if (prevEnv === undefined) delete process.env["CHITRAGUPTA_STORE_DIR"];
    else process.env["CHITRAGUPTA_STORE_DIR"] = prevEnv;
  });

  async function buildAccounts(runs: unknown[][]) {
    const { openStore } = await import("@/lib/ingest/store");
    const { buildSnapshot } = await import("@/lib/snapshot.server");
    dir = mkdtempSync(join(tmpdir(), "chitragupta-avail-"));
    const db = openStore(dir);
    db.prepare(
      `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
         description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
       VALUES ('t1', 'zonito', 'Main', '2026-10-05', '2026-10', 'Ocado', 'Ocado', -1000, 0, 'GBP', 0, 'spend', NULL)`,
    ).run();
    const insertRun = db.prepare(
      `INSERT INTO ingest_runs (person, account, started_at, rows_seen, rows_added, balance_minor, currency, discrepancy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of runs) insertRun.run(...(r as never[]));
    db.close();
    process.env["CHITRAGUPTA_STORE_DIR"] = dir;
    return buildSnapshot().accounts;
  }

  it("carries the balance of the latest real run; a later failed run does not pose as the balance", async () => {
    const accounts = await buildAccounts([
      ["zonito", "Main", "2026-10-28T09:00:00.000Z", 3, 3, 14274, "GBP", null],
      [
        "zonito",
        "Main",
        "2026-10-30T09:00:00.000Z",
        0,
        0,
        null,
        null,
        "ingest failed for x.csv",
      ],
    ]);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      name: "Revolut Main",
      balanceMinor: 14274,
      currency: "GBP",
      lastDate: "2026-10-28",
      added: 3,
    });
  });

  it("a run that recorded no balance leaves it unknown (null), not zero", async () => {
    const accounts = await buildAccounts([
      ["zonito", "Main", "2026-10-28T09:00:00.000Z", 3, 3, null, null, null],
    ]);
    expect(accounts[0]!.balanceMinor).toBeNull();
    expect(accounts[0]!.currency).toBeNull();
  });

  it("keeps the two people's Pro accounts apart, balance included", async () => {
    const accounts = await buildAccounts([
      ["zonito", "Pro", "2026-10-28T09:00:00.000Z", 3, 3, 15833, "GBP", null],
      ["nikhila", "Pro", "2026-10-28T09:00:00.000Z", 3, 3, 12192, "GBP", null],
    ]);
    const pros = accounts.filter((a) => a.name === "Revolut Pro");
    expect(pros.map((p) => [p.owner, p.balanceMinor]).sort()).toEqual([
      ["nikhila", 12192],
      ["zonito", 15833],
    ]);
  });
});

describe("Home Available card and breakdown", () => {
  it("shows the household total and opens a per-account breakdown", () => {
    hydrateData(SAMPLE_SNAPSHOT);
    render(
      <PersonProvider>
        <Index />
      </PersonProvider>,
    );
    // Sample balances: 1250.00 + 342.10 + 5000.00 + 864.20 + 2210.45 + 640.00.
    expect(screen.getAllByText("£10,306.75").length).toBeGreaterThan(0);
    expect(
      screen.getByText(/Across 6 accounts · Latest balances · 28 Oct 2026/),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Available balance, show breakdown by account",
      }),
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Revolut Savings");
    expect(dialog.textContent).toContain("£5,000.00");
    expect(dialog.textContent).toContain("Total available");
    expect(dialog.textContent).toContain("🤝 Joint · last upload 27 Oct 2026");
    // GBP order in the sheet: biggest balance first.
    const names = [
      "Revolut Savings",
      "Monzo Current",
      "Revolut Main",
      "Joint Bills",
      "Amex Gold",
      "Revolut Pro",
    ];
    const positions = names.map((n) => dialog.textContent!.indexOf(n));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("follows the person switch and leaves Joint out of individual totals", () => {
    hydrateData(SAMPLE_SNAPSHOT);
    function Harness() {
      const { setPerson } = usePerson();
      return (
        <>
          <button onClick={() => setPerson("zonito")}>view zonito</button>
          <button onClick={() => setPerson("nikhila")}>view nikhila</button>
          <Index />
        </>
      );
    }
    render(
      <PersonProvider>
        <Harness />
      </PersonProvider>,
    );
    fireEvent.click(screen.getByText("view zonito"));
    // His own: 1250.00 + 342.10 + 5000.00 — Joint's 864.20 stays out.
    expect(screen.getAllByText("£6,592.10").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("view nikhila"));
    // Hers: 2210.45 + 640.00.
    expect(screen.getAllByText("£2,850.45").length).toBeGreaterThan(0);
  });

  it("renders the honest empty card when no account has a recorded balance", () => {
    hydrateData({
      ...SAMPLE_SNAPSHOT,
      accounts: [acct({ name: "Revolut Main" })],
    });
    const { container } = render(
      <PersonProvider>
        <Index />
      </PersonProvider>,
    );
    expect(screen.getByText(/No balances recorded yet/)).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Available balance, show breakdown by account",
      }),
    ).toBeNull();
    expect(container.textContent).not.toContain("£0.00");
  });
});

// ---------------------------------------------------------------------
// repro2 consistency: snapshot balances vs GET /api/ingest/status.

const DATA_DIR = process.env["CHITRAGUPTA_DATA_DIR"]?.trim() || null;
const HER_CURRENT = "account-statement_2023-02-01_2026-10-31_en-sg_f68986.csv";
const HAS_HER_FILES = Boolean(
  DATA_DIR && existsSync(join(DATA_DIR, "Originals", HER_CURRENT)),
);
const describeRepro2 = HAS_HER_FILES ? describe : describe.skip;

describeRepro2("Available totals on the real two-person store (repro2)", () => {
  const storeDir = mkdtempSync(join(tmpdir(), "chitra-avail-store-"));
  const prevStoreEnv = process.env["CHITRAGUPTA_STORE_DIR"];
  let statusAccounts: {
    person: string;
    account: string;
    balanceMinor: number | null;
    currency: string | null;
  }[] = [];
  let built: ReturnType<typeof import("@/lib/snapshot.server").buildSnapshot>;

  beforeAll(async () => {
    process.env["CHITRAGUPTA_STORE_DIR"] = storeDir;
    const { openStore } = await import("@/lib/ingest/store");
    const { ingestAll } = await import("@/lib/ingest/ingest");
    const db = openStore(storeDir);
    ingestAll(db, DATA_DIR!);
    db.close();
    const api = await import("@/lib/api");
    const res = await api.handleChitraguptaApi(
      new Request("http://test/api/ingest/status"),
    );
    const body = (await res!.json()) as {
      ok: boolean;
      accounts: typeof statusAccounts;
    };
    expect(body.ok).toBe(true);
    statusAccounts = body.accounts;
    const { buildSnapshot } = await import("@/lib/snapshot.server");
    built = buildSnapshot();
  }, 240_000);

  afterAll(() => {
    if (prevStoreEnv === undefined) delete process.env["CHITRAGUPTA_STORE_DIR"];
    else process.env["CHITRAGUPTA_STORE_DIR"] = prevStoreEnv;
    hydrateData(SAMPLE_SNAPSHOT);
  });

  it("household GBP total equals the sum of the status endpoint's GBP balances", () => {
    hydrateData(built);
    const statusGbp = statusAccounts
      .filter((a) => a.currency === "GBP" && a.balanceMinor !== null)
      .reduce((s, a) => s + (a.balanceMinor ?? 0), 0);
    // Pinned from the fixture CSVs: his 14274 + 15833 + 0 (Joint) +
    // 80563 + 27164, hers 600 + 12192 + 255911.
    expect(statusGbp).toBe(406537);
    const household = availableFor("household");
    expect(household.gbpTotal).toBe(4065.37);
    expect(Math.round((household.gbpTotal ?? 0) * 100)).toBe(statusGbp);
  });

  it("per-person totals match the status rows for that person, Joint excluded", () => {
    hydrateData(built);
    const zonito = availableFor("zonito");
    expect(zonito.gbpTotal).toBe(1378.34);
    expect(zonito.accounts.map((a) => a.owner)).not.toContain("joint");
    expect(zonito.accounts.map((a) => a.owner)).not.toContain("nikhila");
    const nikhila = availableFor("nikhila");
    expect(nikhila.gbpTotal).toBe(2687.03);
    expect(nikhila.accounts.map((a) => a.owner)).not.toContain("joint");
    expect(nikhila.accounts.map((a) => a.owner)).not.toContain("zonito");
  });

  it("Joint and the zero USD account sit in the household breakdown without moving the GBP total", () => {
    hydrateData(built);
    const household = availableFor("household");
    const joint = household.accounts.find((a) => a.owner === "joint");
    expect(joint).toMatchObject({
      name: "Joint Bills",
      balanceMinor: 0,
      currency: "GBP",
    });
    const usd = household.accounts.find((a) => a.currency === "USD");
    expect(usd).toMatchObject({ name: "Revolut USD-Invest", balanceMinor: 0 });
    expect(household.foreign).toEqual([]);
    // Both Pro accounts survive side by side with their own balances.
    const pros = household.accounts.filter((a) => a.name === "Revolut Pro");
    expect(pros.map((p) => [p.owner, p.balanceMinor]).sort()).toEqual([
      ["nikhila", 12192],
      ["zonito", 15833],
    ]);
  });
});
