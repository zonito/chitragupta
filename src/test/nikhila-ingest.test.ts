import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ingestAll,
  savingsIsoDate,
  type IngestResult,
} from "@/lib/ingest/ingest";
import {
  classifyMovement,
  gbpPence,
  parseAccountCsv,
  parseSavingsCsv,
  savingsFingerprint,
} from "@/lib/ingest/parse";
import { openStore } from "@/lib/ingest/store";
import { buildSnapshot } from "@/lib/snapshot.server";

/**
 * Phase 1 acceptance: Nikhila's statements (filed by her own agent into
 * Originals, next to Zonito's) are discovered, ingested under
 * person='nikhila', and included in true both-people household
 * aggregates — while Zonito's numbers stay exactly as they were.
 * Gated on the repro2 fixture (repro + her three real exports).
 */

const DATA_DIR = process.env["CHITRAGUPTA_DATA_DIR"]?.trim() || null;
const HER_CURRENT = "account-statement_2023-02-01_2026-10-31_en-sg_f68986.csv";
const HER_PRO = "account-statement_2025-12-22_2026-10-31_en-sg_62af2b.csv";
const HER_SAVINGS =
  "savings-statement_2026-02-01_2026-10-31_en-sg_-900000003_3b9780.csv";
const HAS_HER_FILES = Boolean(
  DATA_DIR && existsSync(join(DATA_DIR, "Originals", HER_CURRENT)),
);
const describeNikhila = HAS_HER_FILES ? describe : describe.skip;

/** Her October 2026 GBP spend, computed from the raw fixture CSVs with
 * the statement parser and movement rules — never from the store — so
 * the household figure is checked against an independent derivation. */
function herOctoberGbpSpendFromCsv(dataDir: string): number {
  const originals = join(dataDir, "Originals");
  let spend = 0;
  for (const file of [HER_CURRENT, HER_PRO]) {
    const rows = parseAccountCsv(readFileSync(join(originals, file), "utf8"));
    for (const r of rows) {
      if (r.state === "REVERTED") continue;
      const effective = r.completedDate || r.startedDate;
      if (!effective.startsWith("2026-10") || r.currency !== "GBP") continue;
      const amountMinor = gbpPence(r.amount);
      const movement = classifyMovement(
        r.type,
        r.description,
        amountMinor,
        r.currency,
        r.state,
      );
      if (movement === "spend" && amountMinor < 0) spend += -amountMinor;
    }
  }
  const srows = parseSavingsCsv(
    readFileSync(join(originals, HER_SAVINGS), "utf8"),
  );
  const seen = new Set<string>();
  for (const r of srows) {
    const fp = savingsFingerprint("Savings-900000003", r);
    if (seen.has(fp)) continue;
    seen.add(fp);
    if (!savingsIsoDate(r.date).startsWith("2026-10")) continue;
    const amountMinor = gbpPence(r.moneyIn) - gbpPence(r.moneyOut);
    const movement = classifyMovement(
      r.description.toLowerCase().includes("interest") ? "interest" : "deposit",
      r.description,
      amountMinor,
      "GBP",
    );
    if (movement === "spend" && amountMinor < 0) spend += -amountMinor;
  }
  return spend;
}

describeNikhila("Nikhila's statements ingest (repro2 fixture)", () => {
  const storeDir = mkdtempSync(join(tmpdir(), "chitra-nikhila-store-"));
  const prevStoreEnv = process.env["CHITRAGUPTA_STORE_DIR"];
  let db: ReturnType<typeof openStore>;
  let results: IngestResult[] = [];

  beforeAll(() => {
    process.env["CHITRAGUPTA_STORE_DIR"] = storeDir;
    db = openStore(storeDir);
    results = ingestAll(db, DATA_DIR!);
  }, 240_000);

  afterAll(() => {
    db?.close();
    if (prevStoreEnv === undefined) delete process.env["CHITRAGUPTA_STORE_DIR"];
    else process.env["CHITRAGUPTA_STORE_DIR"] = prevStoreEnv;
  });

  it("discovers and ingests her three accounts with the verified counts and GBP balances", () => {
    const hers = new Map(
      results.filter((r) => r.person === "nikhila").map((r) => [r.account, r]),
    );
    expect([...hers.keys()].sort()).toEqual([
      "Current",
      "Pro",
      "Savings-900000003",
    ]);
    expect(hers.get("Current")).toMatchObject({
      ok: true,
      rowsSeen: 299,
      balanceMinor: 600,
      currency: "GBP",
      file: HER_CURRENT,
    });
    expect(hers.get("Pro")).toMatchObject({
      ok: true,
      rowsSeen: 204,
      balanceMinor: 12192,
      currency: "GBP",
      file: HER_PRO,
    });
    expect(hers.get("Savings-900000003")).toMatchObject({
      ok: true,
      rowsSeen: 322,
      balanceMinor: 255911,
      currency: "GBP",
      file: HER_SAVINGS,
    });
    const counts = db
      .prepare(
        `SELECT account, COUNT(*) AS n FROM transactions
         WHERE person = 'nikhila' GROUP BY account`,
      )
      .all() as { account: string; n: number }[];
    expect(Object.fromEntries(counts.map((c) => [c.account, c.n]))).toEqual({
      Current: 299,
      Pro: 204,
      "Savings-900000003": 322,
    });
    // Her Current keeps its per-currency buckets; nothing is converted.
    const currencies = db
      .prepare(
        `SELECT currency, COUNT(*) AS n FROM transactions
         WHERE person = 'nikhila' AND account = 'Current' GROUP BY currency`,
      )
      .all() as { currency: string; n: number }[];
    expect(
      Object.fromEntries(currencies.map((c) => [c.currency, c.n])),
    ).toEqual({ GBP: 231, SGD: 15, USD: 53 });
    // Her savings export writes dates day-first ("1 Feb 2026",
    // "1 Sept 2026"): every one of her rows must land in a real
    // YYYY-MM bucket, her savings included.
    const malformed = db
      .prepare(
        `SELECT COUNT(*) AS n FROM transactions WHERE person = 'nikhila'
         AND year_month NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'`,
      )
      .get() as { n: number };
    expect(malformed.n).toBe(0);
    const savingsOctober = db
      .prepare(
        `SELECT COUNT(*) AS n FROM transactions
         WHERE person = 'nikhila' AND account = 'Savings-900000003' AND year_month = '2026-10'`,
      )
      .get() as { n: number };
    expect(savingsOctober.n).toBeGreaterThan(0);
  });

  it("leaves Zonito's results identical to the repro baseline", () => {
    const mine = new Map(
      results.filter((r) => r.person === "zonito").map((r) => [r.account, r]),
    );
    expect(mine.get("Main")).toMatchObject({
      rowsSeen: 2770,
      balanceMinor: 14274,
    });
    expect(mine.get("Pro")).toMatchObject({
      rowsSeen: 4265,
      balanceMinor: 15833,
    });
    expect(mine.get("USD-Invest")).toMatchObject({ rowsSeen: 482 });
    expect(mine.get("Joint")).toMatchObject({ rowsSeen: 173, balanceMinor: 0 });
    expect(mine.get("Savings-9000000002")).toMatchObject({
      rowsSeen: 567,
      balanceMinor: 80563,
    });
    expect(mine.get("Savings-9000000001")).toMatchObject({
      rowsSeen: 355,
      balanceMinor: 27164,
    });
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM transactions WHERE person = 'zonito'")
      .get() as { n: number };
    expect(count.n).toBe(8612);
    const october = db
      .prepare(
        `SELECT COALESCE(SUM(spend_minor), 0) AS s FROM month_aggregates
         WHERE person = 'zonito' AND year_month = '2026-10' AND currency = 'GBP'`,
      )
      .get() as { s: number };
    expect(october.s).toBe(195238);
  });

  it("household October 2026 GBP spend is Zonito's plus hers, computed from her CSVs", () => {
    const hersFromCsv = herOctoberGbpSpendFromCsv(DATA_DIR!);
    expect(hersFromCsv).toBeGreaterThan(0);
    const hersStored = db
      .prepare(
        `SELECT COALESCE(SUM(-amount_minor), 0) AS s FROM transactions
         WHERE person = 'nikhila' AND year_month = '2026-10' AND currency = 'GBP'
           AND movement = 'spend' AND amount_minor < 0`,
      )
      .get() as { s: number };
    expect(hersStored.s).toBe(hersFromCsv);
    const household = db
      .prepare(
        `SELECT COALESCE(SUM(spend_minor), 0) AS s FROM month_aggregates
         WHERE person = 'household' AND year_month = '2026-10' AND currency = 'GBP'`,
      )
      .get() as { s: number };
    expect(household.s).toBe(195238 + hersFromCsv);
  });

  it("household aggregates equal the per-person sums in every bucket", () => {
    type Agg = {
      year_month: string;
      category: string;
      currency: string;
      spend_minor: number;
      income_minor: number;
      aside_minor: number;
      txn_count: number;
    };
    const load = (person: string) =>
      new Map(
        (
          db
            .prepare(
              `SELECT year_month, category, currency, spend_minor, income_minor, aside_minor, txn_count
               FROM month_aggregates WHERE person = ?`,
            )
            .all(person) as Agg[]
        ).map((r) => [`${r.year_month}|${r.category}|${r.currency}`, r]),
      );
    const zonito = load("zonito");
    const nikhila = load("nikhila");
    const household = load("household");
    const keys = new Set([...zonito.keys(), ...nikhila.keys()]);
    expect(household.size).toBe(keys.size);
    for (const key of keys) {
      const z = zonito.get(key);
      const n = nikhila.get(key);
      const h = household.get(key)!;
      expect(h, key).toBeTruthy();
      expect(h.spend_minor, key).toBe(
        (z?.spend_minor ?? 0) + (n?.spend_minor ?? 0),
      );
      expect(h.income_minor, key).toBe(
        (z?.income_minor ?? 0) + (n?.income_minor ?? 0),
      );
      expect(h.aside_minor, key).toBe(
        (z?.aside_minor ?? 0) + (n?.aside_minor ?? 0),
      );
      expect(h.txn_count, key).toBe((z?.txn_count ?? 0) + (n?.txn_count ?? 0));
    }
  });

  it("persists every file's assignment in meta, stable across a second ingest", () => {
    const rows = db
      .prepare("SELECT key, value FROM meta WHERE key LIKE 'file_assignment:%'")
      .all() as { key: string; value: string }[];
    expect(rows).toHaveLength(9);
    const hers = Object.fromEntries(
      rows
        .map((r) => [
          r.key.slice("file_assignment:".length),
          JSON.parse(r.value),
        ])
        .filter(([, v]) => (v as { person: string }).person === "nikhila"),
    );
    expect(hers[HER_CURRENT]).toEqual({
      person: "nikhila",
      account: "Current",
    });
    expect(hers[HER_PRO]).toEqual({ person: "nikhila", account: "Pro" });
    expect(hers[HER_SAVINGS]).toEqual({
      person: "nikhila",
      account: "Savings-900000003",
    });
    const second = ingestAll(db, DATA_DIR!);
    const hersSecond = second.filter((r) => r.person === "nikhila");
    expect(hersSecond.map((r) => r.account).sort()).toEqual([
      "Current",
      "Pro",
      "Savings-900000003",
    ]);
    expect(hersSecond.reduce((n, r) => n + r.rowsAdded, 0)).toBe(0);
  }, 240_000);

  it("the snapshot gives Nikhila real accounts, months and transactions, and household totals match the aggregates", () => {
    const snapshot = buildSnapshot();
    expect(snapshot.configured).toBe(true);
    const hers = snapshot.accounts.filter((a) => a.owner === "nikhila");
    expect(hers.map((a) => a.name).sort()).toEqual([
      "Revolut Current",
      "Revolut Pro",
      "Revolut Savings 0003",
    ]);
    // Her Current reaches back to February 2023: real months, not the
    // honest-empty state her view used to be.
    expect(snapshot.months.map((m) => m.key)).toContain("2023-02");
    expect(snapshot.txns.some((t) => t.owner === "nikhila")).toBe(true);
    expect(
      snapshot.txns.some(
        (t) => t.owner === "nikhila" && t.account === "Revolut Pro · Nikhila",
      ),
    ).toBe(true);
    // Household current-month spend in the snapshot equals the stored
    // household aggregate for that month.
    const snapshotSpend = snapshot.txns
      .filter((t) => t.monthKey === snapshot.monthKey && t.kind === "spend")
      .reduce((s, t) => s + Math.round(t.amount * 100), 0);
    const aggregate = db
      .prepare(
        `SELECT COALESCE(SUM(spend_minor), 0) AS s FROM month_aggregates
         WHERE person = 'household' AND year_month = ? AND currency = 'GBP'`,
      )
      .get(snapshot.monthKey) as { s: number };
    expect(snapshotSpend).toBe(aggregate.s);
    // Her typical/spark figures are real too (non-zero somewhere).
    const herSparkTotal = Object.values(snapshot.sparks).reduce(
      (s, per) => s + (per["nikhila"] ?? []).reduce((a, b) => a + b, 0),
      0,
    );
    expect(herSparkTotal).toBeGreaterThan(0);
  });

  it("GET /api/ingest/status distinguishes the two Pro accounts by person", async () => {
    const api = await import("@/lib/api");
    const res = await api.handleChitraguptaApi(
      new Request("http://test/api/ingest/status"),
    );
    const body = (await res!.json()) as {
      ok: boolean;
      accounts: { person: string; account: string }[];
    };
    expect(body.ok).toBe(true);
    const pros = body.accounts.filter((a) => a.account === "Pro");
    expect(pros.map((p) => p.person).sort()).toEqual(["nikhila", "zonito"]);
    const hers = body.accounts.filter((a) => a.person === "nikhila");
    expect(hers.map((a) => a.account).sort()).toEqual([
      "Current",
      "Pro",
      "Savings-900000003",
    ]);
  });
});

// ---------------------------------------------------------------------
// Synthetic discovery behaviour (no fixture needed).

const ACCOUNT_HEADER =
  "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n";

function syntheticDir(extra: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "chitra-discovery-"));
  const originals = join(dir, "Originals");
  mkdirSync(originals, { recursive: true });
  const files: Record<string, string> = {
    "account-statement_2022_f5660e.csv":
      ACCOUNT_HEADER +
      "Card Payment,Current,2026-10-03 10:00:00,2026-10-03 10:00:01,Ocado,-10.00,0.00,GBP,COMPLETED,990.00\n",
    "account-statement_2022_01cac2.csv":
      ACCOUNT_HEADER +
      "Card Payment,Pro,2026-10-02 10:00:00,2026-10-02 10:00:01,Tesco,-5.00,0.00,GBP,COMPLETED,100.00\n",
    "account-statement_2022_2151f7.csv":
      ACCOUNT_HEADER +
      "Card Payment,Invest,2026-10-02 10:00:00,2026-10-02 10:00:01,Netflix,-15.00,0.00,USD,COMPLETED,85.00\n",
    "account-statement_2022_bd9d00.csv":
      ACCOUNT_HEADER +
      "Card Payment,Joint,2026-10-02 10:00:00,2026-10-02 10:00:01,Waitrose,-7.50,0.00,GBP,COMPLETED,50.00\n",
    "savings-9000000002.csv":
      'Date,Description,Money Out,Money In,Balance\n"Oct 5, 2026",Deposit,,100.00,100.00\n',
    "savings-9000000001.csv":
      'Date,Description,Money Out,Money In,Balance\n"Oct 6, 2026",Deposit,,50.00,50.00\n',
    ...extra,
  };
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(originals, name), contents);
  }
  writeFileSync(
    join(dir, "account-identifiers.json"),
    JSON.stringify({ zonito: ["Savings-9000000001", "Savings-9000000002"] }),
  );
  return dir;
}

describe("person-aware discovery (synthetic Originals)", () => {
  it("an unclaimed statement file is discovered as Nikhila's, by its Product", () => {
    const dir = syntheticDir({
      "account-statement_2099_cafe01.csv":
        ACCOUNT_HEADER +
        "Card Payment,Pro,2026-10-02 10:00:00,2026-10-02 10:00:01,Her Tesco,-3.25,0.00,GBP,COMPLETED,42.00\n",
    });
    const db = openStore(
      mkdtempSync(join(tmpdir(), "chitra-discovery-store-")),
    );
    const results = ingestAll(db, dir);
    const hers = results.filter((r) => r.person === "nikhila");
    expect(hers).toHaveLength(1);
    expect(hers[0]).toMatchObject({ account: "Pro", ok: true, rowsSeen: 1 });
    const row = db
      .prepare(
        "SELECT person, account FROM transactions WHERE merchant = 'Her Tesco'",
      )
      .get() as { person: string; account: string };
    expect(row).toEqual({ person: "nikhila", account: "Pro" });
    db.close();
  });

  it("a statement file with two Products fails loudly and ingests nothing", () => {
    const dir = syntheticDir({
      "account-statement_2099_beef02.csv":
        ACCOUNT_HEADER +
        "Card Payment,Pro,2026-10-02 10:00:00,2026-10-02 10:00:01,Mixed One,-3.25,0.00,GBP,COMPLETED,42.00\n" +
        "Card Payment,Current,2026-10-03 10:00:00,2026-10-03 10:00:01,Mixed Two,-1.00,0.00,GBP,COMPLETED,41.00\n",
    });
    const db = openStore(
      mkdtempSync(join(tmpdir(), "chitra-discovery-store-")),
    );
    const results = ingestAll(db, dir);
    const failure = results.find(
      (r) => r.file === "account-statement_2099_beef02.csv",
    );
    expect(failure).toBeTruthy();
    expect(failure!.ok).toBe(false);
    expect(failure!.error).toMatch(/ambiguous/);
    const mixed = db
      .prepare(
        "SELECT COUNT(*) AS n FROM transactions WHERE merchant LIKE 'Mixed %'",
      )
      .get() as { n: number };
    expect(mixed.n).toBe(0);
    // Everyone else still ingested.
    expect(results.filter((r) => r.person === "zonito" && r.ok)).toHaveLength(
      6,
    );
    db.close();
  });
});
