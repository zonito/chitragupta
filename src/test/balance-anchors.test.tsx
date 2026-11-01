import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { render, screen } from "@testing-library/react";
import type Database from "better-sqlite3";

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-router")>(
    "@tanstack/react-router",
  );
  return {
    ...actual,
    useRouter: () => ({ invalidate: async () => {} }),
    Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => (
      <a href={to} className={className}>{children}</a>
    ),
  };
});

// Imported after the router mock is registered.
const { AvailableBreakdown } = await import("@/routes/index");

import { openStore } from "@/lib/ingest/store";
import {
  addBalanceAnchor,
  anchorFor,
  balanceSourceFor,
  deriveBalance,
  listBalanceAnchors,
  seedBalanceAnchors,
} from "@/lib/ingest/balance-anchors";
import { ingestAll } from "@/lib/ingest/ingest";
import { buildSnapshot } from "@/lib/snapshot.server";
import { availableFor, hydrateData } from "@/lib/data";
import { SAMPLE_SNAPSHOT } from "@/test/fixtures";

/**
 * Balance anchors: accounts whose exports carry no balance column
 * get a balance derived from a statement anchor (a known balance on
 * a known date) walked forward over the store's transactions. Every
 * anchor, name and amount in this file is synthetic, invented for
 * the test — the one production seed is asserted only for its
 * presence and idempotence, never used as a derivation fixture.
 */

const prevStoreEnv = process.env["CHITRAGUPTA_STORE_DIR"];
const tmpDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  hydrateData(SAMPLE_SNAPSHOT);
  if (prevStoreEnv === undefined) delete process.env["CHITRAGUPTA_STORE_DIR"];
  else process.env["CHITRAGUPTA_STORE_DIR"] = prevStoreEnv;
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function insertTxn(
  db: Database.Database,
  fp: string,
  person: string,
  account: string,
  date: string,
  amountMinor: number,
  movement: string,
  currency = "GBP",
): void {
  db.prepare(
    `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
       description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
     VALUES (?, ?, ?, ?, ?, 'Synthetic', 'Synthetic', ?, 0, ?, 0, ?, 'One-off')`,
  ).run(fp, person, account, date, date.slice(0, 7), amountMinor, currency, movement);
}

function insertRun(
  db: Database.Database,
  person: string,
  account: string,
  startedAt: string,
  balanceMinor: number | null,
  currency: string | null = "GBP",
): void {
  db.prepare(
    `INSERT INTO ingest_runs (person, account, started_at, rows_seen, rows_added, balance_minor, currency)
     VALUES (?, ?, ?, 3, 3, ?, ?)`,
  ).run(person, account, startedAt, balanceMinor, balanceMinor === null ? null : currency);
}

/** The anchored account's transaction story, shared by the unit and
 *  snapshot tests: one row before the anchor, one ON the anchor date
 *  (already inside the statement balance — never counted), then a
 *  spread of movements after it, every one of which moves a bank
 *  balance. Anchor: 50,000 minor at 2026-09-01. Post-anchor sum:
 *  +100,000 − 25,000 + 5,000 − 1,200 = +78,800, so the derived
 *  balance is 128,800 as of the latest row, 2026-09-25. */
function seedAnchorStory(db: Database.Database): void {
  insertTxn(db, "pre", "zonito", "Anchor Current", "2026-08-15", 200000, "income");
  insertTxn(db, "on", "zonito", "Anchor Current", "2026-09-01", 99900, "income");
  insertTxn(db, "p1", "zonito", "Anchor Current", "2026-09-10", 100000, "income");
  insertTxn(db, "p2", "zonito", "Anchor Current", "2026-09-12", -25000, "spend");
  insertTxn(db, "p3", "zonito", "Anchor Current", "2026-09-20", 5000, "internal");
  insertTxn(db, "p4", "zonito", "Anchor Current", "2026-09-25", -1200, "fee");
  addBalanceAnchor(db, {
    person: "zonito",
    account: "Anchor Current",
    anchorDate: "2026-09-01",
    balanceMinor: 50000,
    currency: "GBP",
  });
}

describe("balance anchor store", () => {
  it("seeds exactly one production anchor at store open, idempotently", () => {
    const dir = tempDir("chitra-anchor-seed-");
    const db = openStore(dir);
    const anchors = listBalanceAnchors(db);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toEqual({
      person: "zonito",
      account: "Barclays Current",
      anchorDate: "2026-04-20",
      balanceMinor: 17711,
      currency: "GBP",
    });
    seedBalanceAnchors(db);
    db.close();
    const reopened = openStore(dir);
    expect(listBalanceAnchors(reopened)).toHaveLength(1);
    reopened.close();
  });
});

describe("deriveBalance", () => {
  it("derives anchor + post-anchor sum over every movement, as of the latest row", () => {
    const db = openStore(tempDir("chitra-anchor-derive-"));
    seedAnchorStory(db);
    expect(deriveBalance(db, "zonito", "Anchor Current")).toEqual({
      balanceMinor: 128800,
      currency: "GBP",
      asOf: "2026-09-25",
      anchorDate: "2026-09-01",
    });
    db.close();
  });

  it("the newest anchor wins; earlier anchors are superseded, not merged", () => {
    const db = openStore(tempDir("chitra-anchor-newest-"));
    seedAnchorStory(db);
    addBalanceAnchor(db, {
      person: "zonito",
      account: "Anchor Current",
      anchorDate: "2026-09-15",
      balanceMinor: 90000,
      currency: "GBP",
    });
    expect(anchorFor(db, "zonito", "Anchor Current")?.anchorDate).toBe("2026-09-15");
    // Only the rows after 15 Sep count now: +5,000 − 1,200.
    expect(deriveBalance(db, "zonito", "Anchor Current")).toEqual({
      balanceMinor: 93800,
      currency: "GBP",
      asOf: "2026-09-25",
      anchorDate: "2026-09-15",
    });
    db.close();
  });

  it("an anchor dated after all rows yields the anchor balance, as of the anchor date", () => {
    const db = openStore(tempDir("chitra-anchor-future-"));
    insertTxn(db, "f1", "zonito", "Future Current", "2026-08-20", 40000, "income");
    addBalanceAnchor(db, {
      person: "zonito",
      account: "Future Current",
      anchorDate: "2026-12-01",
      balanceMinor: 77700,
      currency: "GBP",
    });
    expect(deriveBalance(db, "zonito", "Future Current")).toEqual({
      balanceMinor: 77700,
      currency: "GBP",
      asOf: "2026-12-01",
      anchorDate: "2026-12-01",
    });
    db.close();
  });

  it("an account with no anchor derives nothing", () => {
    const db = openStore(tempDir("chitra-anchor-none-"));
    insertTxn(db, "n1", "zonito", "Plain Current", "2026-09-10", 40000, "income");
    expect(deriveBalance(db, "zonito", "Plain Current")).toBeNull();
    expect(balanceSourceFor(db, "zonito", "Plain Current")).toBeNull();
    db.close();
  });
});

describe("snapshot surfacing", () => {
  it("an anchored account derives into Available; a recorded balance ignores its anchor", () => {
    const dir = tempDir("chitra-anchor-snap-");
    const db = openStore(dir);
    seedAnchorStory(db);
    insertRun(db, "zonito", "Anchor Current", "2026-10-30T09:00:00.000Z", null);
    // A recorded-balance account that ALSO has an anchor: the anchor
    // must be ignored entirely, the recorded balance rules.
    insertTxn(db, "m1", "zonito", "Main", "2026-10-05", 1000, "spend");
    insertRun(db, "zonito", "Main", "2026-10-30T09:00:00.000Z", 500000);
    addBalanceAnchor(db, {
      person: "zonito",
      account: "Main",
      anchorDate: "2026-09-01",
      balanceMinor: 1,
      currency: "GBP",
    });
    // An anchor for an account the store has never seen: inert.
    addBalanceAnchor(db, {
      person: "zonito",
      account: "Ghost",
      anchorDate: "2026-09-01",
      balanceMinor: 424242,
      currency: "GBP",
    });
    db.close();

    process.env["CHITRAGUPTA_STORE_DIR"] = dir;
    const snapshot = buildSnapshot();
    const byId = new Map(snapshot.accounts.map((a) => [a.accountId, a]));
    expect(byId.get("Anchor Current")).toMatchObject({
      balanceMinor: 128800,
      currency: "GBP",
      balanceSource: "derived",
      balanceAsOf: "2026-09-25",
    });
    expect(byId.get("Main")).toMatchObject({
      balanceMinor: 500000,
      balanceSource: "statement",
    });
    expect(byId.has("Ghost")).toBe(false);

    hydrateData(snapshot);
    const avail = availableFor("household");
    // Derived counts into the total exactly like the recorded one.
    expect(avail.gbpTotal).toBe(6288);
    expect(avail.accounts.map((a) => a.accountId)).not.toContain("Ghost");
  });

  it("the Available breakdown flags a derived balance with a quiet tag", () => {
    hydrateData({
      ...SAMPLE_SNAPSHOT,
      accounts: [
        {
          name: "Anchor Current",
          owner: "zonito",
          last: "30 Oct",
          lastDate: "2026-10-30",
          added: 3,
          stale: false,
          balanceMinor: 128800,
          currency: "GBP",
          balanceSource: "derived",
          balanceAsOf: "2026-09-25",
          accountId: "Anchor Current",
          person: "zonito",
        },
        {
          name: "Revolut Main",
          owner: "zonito",
          last: "30 Oct",
          lastDate: "2026-10-30",
          added: 3,
          stale: false,
          balanceMinor: 500000,
          currency: "GBP",
          balanceSource: "statement",
          accountId: "Main",
          person: "zonito",
        },
      ],
    });
    render(<AvailableBreakdown person="household" />);
    expect(screen.getByText("Derived")).toBeTruthy();
    expect(screen.getByText("£1,288.00")).toBeTruthy();
  });
});

const STATEMENT_HEADER =
  "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance";

function statementRow(
  type: string,
  product: string,
  date: string,
  desc: string,
  amount: string,
  currency = "GBP",
  balance = "",
): string {
  return `${type},${product},${date} 00:00:00,${date} 00:00:00,${desc},${amount},0.00,${currency},COMPLETED,${balance}`;
}

function writeBarclaysFile(dir: string, currentRows: string[]): void {
  const cardRow = statementRow(
    "Card Payment",
    "Barclaycard",
    "2026-09-03",
    "SYNTH STORE",
    "-10.00",
    "GBP",
    "-10.00",
  );
  writeFileSync(
    join(dir, "Zonito", "Barclay", "Barclaycard", "barclaycard-full-history.csv"),
    [STATEMENT_HEADER, ...currentRows, cardRow].join("\n"),
  );
}

/**
 * A complete synthetic Zonito data dir, so a full ingestAll succeeds
 * for every expected account (any failure aborts the atomic rebuild
 * swap, which is exactly what this fixture must not trip). Every
 * account gets one innocuous row with a unique amount, so the
 * cross-account transfer matcher finds no pairs. The centrepiece is
 * the prepared Barclays file: Product "Current" rows with the
 * Balance column blank — the exact shape whose account can only
 * ever get its balance from an anchor.
 */
function makeBarclaysDataDir(currentRows: string[]): string {
  const dir = tempDir("chitra-anchor-data-");
  mkdirSync(join(dir, "Originals"), { recursive: true });
  mkdirSync(join(dir, "Zonito", "Barclay", "Barclaycard"), { recursive: true });
  const originals: [string, string][] = [
    ["account-statement_f5660e.csv", statementRow("Deposit", "Main", "2026-09-01", "Synthetic opening", "111.11", "GBP", "111.11")],
    ["account-statement_01cac2.csv", statementRow("Deposit", "Pro", "2026-09-01", "Synthetic opening", "222.22", "GBP", "222.22")],
    ["account-statement_2151f7.csv", statementRow("Deposit", "Current", "2026-09-01", "Synthetic opening", "33.33", "USD", "33.33")],
    ["account-statement_bd9d00.csv", statementRow("Deposit", "Current", "2026-09-01", "Synthetic opening", "44.44", "GBP", "44.44")],
  ];
  for (const [name, row] of originals) {
    writeFileSync(join(dir, "Originals", name), [STATEMENT_HEADER, row].join("\n"));
  }
  const savingsHeader = "Date,Description,Money out,Money in,Balance";
  for (const [name, amount] of [
    ["savings-statement_2026-02-01_2026-10-31_en-sg_2071970671.csv", "55.55"],
    ["savings-statement_2026-02-01_2026-10-31_en-sg_2014731036.csv", "66.66"],
  ] as const) {
    writeFileSync(
      join(dir, "Originals", name),
      [savingsHeader, `"Sep 1, 2026",Deposit,,£${amount},£${amount}`].join("\n"),
    );
  }
  writeBarclaysFile(dir, currentRows);
  return dir;
}

const currentRow = (type: string, date: string, desc: string, amount: string) =>
  statementRow(type, "Current", date, desc, amount);

describe("anchors across ingest", () => {
  it("survive the two-ingest rebuild flow, and the derivation stays LIVE: later ingested rows advance balance and as-of with no new configuration", () => {
    const baseRows = [
      currentRow("Transfer", "2026-08-15", "SYNTH EMPLOYER BGC", "2000.00"),
      currentRow("Transfer", "2026-09-10", "SYNTH EMPLOYER BGC", "1000.00"),
      currentRow("Card Payment", "2026-09-12", "SYNTH SHOP BCC", "-250.00"),
    ];
    const dataDir = makeBarclaysDataDir(baseRows);
    const storeDir = tempDir("chitra-anchor-live-");
    const db = openStore(storeDir);
    addBalanceAnchor(db, {
      person: "zonito",
      account: "Barclays Current",
      anchorDate: "2026-09-01",
      balanceMinor: 50000,
      currency: "GBP",
    });

    // First ingest (a fresh store routes through the atomic rebuild),
    // then the standard second ingest. The anchor — added BEFORE any
    // ingest — must still be there, and the account's recorded
    // balance stays null: the derivation is the only source.
    const first = ingestAll(db, dataDir);
    expect(first.every((r) => r.ok)).toBe(true);
    const second = ingestAll(db, dataDir);
    expect(second.every((r) => r.ok)).toBe(true);
    expect(
      listBalanceAnchors(db).some(
        (a) => a.account === "Barclays Current" && a.anchorDate === "2026-09-01",
      ),
    ).toBe(true);
    // 50,000 + (100,000 − 25,000); the 2026-08-15 row predates the anchor.
    expect(deriveBalance(db, "zonito", "Barclays Current")).toEqual({
      balanceMinor: 125000,
      currency: "GBP",
      asOf: "2026-09-12",
      anchorDate: "2026-09-01",
    });

    // A later statement export lands with a newer row. No anchor is
    // touched; the next derivation — and the next snapshot — must
    // simply move forward, because the balance is computed from the
    // store's transactions at build time, never frozen.
    writeBarclaysFile(dataDir, [
      ...baseRows,
      currentRow("Card Payment", "2026-10-05", "SYNTH SHOP BCC", "-100.00"),
    ]);
    const third = ingestAll(db, dataDir);
    expect(third.every((r) => r.ok)).toBe(true);
    expect(deriveBalance(db, "zonito", "Barclays Current")).toEqual({
      balanceMinor: 115000,
      currency: "GBP",
      asOf: "2026-10-05",
      anchorDate: "2026-09-01",
    });
    db.close();

    process.env["CHITRAGUPTA_STORE_DIR"] = storeDir;
    const snapshot = buildSnapshot();
    expect(
      snapshot.accounts.find((a) => a.accountId === "Barclays Current"),
    ).toMatchObject({
      balanceMinor: 115000,
      balanceSource: "derived",
      balanceAsOf: "2026-10-05",
    });
  });
});

describe("GET /api/accounts provenance", () => {
  it("labels each account statement / derived / null by the snapshot's own rules", async () => {
    const dir = tempDir("chitra-anchor-api-");
    const db = openStore(dir);
    seedAnchorStory(db);
    insertRun(db, "zonito", "Anchor Current", "2026-10-30T09:00:00.000Z", null);
    insertTxn(db, "m1", "zonito", "Main", "2026-10-05", 1000, "spend");
    insertRun(db, "zonito", "Main", "2026-10-30T09:00:00.000Z", 500000);
    insertTxn(db, "h1", "nikhila", "Current", "2026-10-05", 1000, "spend");
    insertRun(db, "nikhila", "Current", "2026-10-30T09:00:00.000Z", null);
    db.close();

    process.env["CHITRAGUPTA_STORE_DIR"] = dir;
    const { handleChitraguptaApi } = await import("@/lib/api");
    const res = await handleChitraguptaApi(new Request("http://test/api/accounts"));
    expect(res).not.toBeNull();
    const body = (await res!.json()) as {
      accounts: { person: string; account: string; balanceSource: string | null }[];
    };
    const source = new Map(
      body.accounts.map((a) => [`${a.person}|${a.account}`, a.balanceSource]),
    );
    expect(source.get("zonito|Anchor Current")).toBe("derived");
    expect(source.get("zonito|Main")).toBe("statement");
    expect(source.get("nikhila|Current")).toBeNull();
  });
});
