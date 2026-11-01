import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ingestAll, recomputeAggregates } from "@/lib/ingest/ingest";
import { openStore } from "@/lib/ingest/store";

/**
 * Aggregates parity: month_aggregates is a cache of the transactions
 * table, and the two must never disagree. For every (person, month,
 * currency), the income / spend / aside sums and the row count in
 * month_aggregates must equal the same sums computed straight from
 * transactions, using the aggregate build's own movement rules:
 *
 *   income = amount > 0 AND movement = 'income'
 *   spend  = amount < 0 AND movement = 'spend'   (stored positive)
 *   aside  = amount < 0 AND movement = 'aside'   (stored positive)
 *
 * Currency is part of the key on purpose: amounts are never summed
 * across currencies at face value. (The October 2026 "missing income"
 * scare was exactly that mistake made by hand: a $23,171.21 deposit
 * and a $101.00 credit in the USD-Invest account looked lost from the
 * GBP aggregates while sitting, correctly, in the USD bucket.) The
 * synthetic case below pins a USD income row to the USD aggregates so
 * the distinction stays tested, not just documented.
 */

type Sums = { income: number; spend: number; aside: number; n: number };
type Keyed = Map<string, Sums>;

const keyOf = (person: string, month: string, currency: string) =>
  `${person}|${month}|${currency}`;

function empty(): Sums {
  return { income: 0, spend: 0, aside: 0, n: 0 };
}

function add(map: Keyed, key: string, s: Sums): void {
  const cur = map.get(key) ?? empty();
  cur.income += s.income;
  cur.spend += s.spend;
  cur.aside += s.aside;
  cur.n += s.n;
  map.set(key, cur);
}

type Db = ReturnType<typeof openStore>;

function transactionSums(db: Db): Keyed {
  const rows = db
    .prepare(
      `SELECT person, year_month, currency,
         SUM(CASE WHEN amount_minor > 0 AND movement = 'income' THEN amount_minor ELSE 0 END) AS income,
         SUM(CASE WHEN amount_minor < 0 AND movement = 'spend' THEN -amount_minor ELSE 0 END) AS spend,
         SUM(CASE WHEN movement = 'aside' AND amount_minor < 0 THEN -amount_minor ELSE 0 END) AS aside,
         COUNT(*) AS n
       FROM transactions GROUP BY person, year_month, currency`,
    )
    .all() as {
    person: string;
    year_month: string;
    currency: string;
    income: number;
    spend: number;
    aside: number;
    n: number;
  }[];
  const map: Keyed = new Map();
  for (const r of rows) {
    add(map, keyOf(r.person, r.year_month, r.currency), r);
    // Household aggregates are stored sums over both people, so the
    // transaction side of the household key is the same merge.
    add(map, keyOf("household", r.year_month, r.currency), r);
  }
  return map;
}

function aggregateSums(db: Db): Keyed {
  const rows = db
    .prepare(
      `SELECT person, year_month, currency,
         SUM(income_minor) AS income, SUM(spend_minor) AS spend,
         SUM(aside_minor) AS aside, SUM(txn_count) AS n
       FROM month_aggregates GROUP BY person, year_month, currency`,
    )
    .all() as {
    person: string;
    year_month: string;
    currency: string;
    income: number;
    spend: number;
    aside: number;
    n: number;
  }[];
  const map: Keyed = new Map();
  for (const r of rows) add(map, keyOf(r.person, r.year_month, r.currency), r);
  return map;
}

function expectParity(db: Db): void {
  const fromTxns = transactionSums(db);
  const fromAggs = aggregateSums(db);
  const keys = new Set([...fromTxns.keys(), ...fromAggs.keys()]);
  expect(keys.size).toBeGreaterThan(0);
  for (const key of keys) {
    expect(fromAggs.get(key) ?? empty(), key).toEqual(
      fromTxns.get(key) ?? empty(),
    );
  }
}

describe("aggregates parity (synthetic store)", () => {
  const dir = mkdtempSync(join(tmpdir(), "chitra-parity-synth-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("transactions and month_aggregates agree per person, month and currency", () => {
    const db = openStore(dir);
    const insert = db.prepare(
      `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
         description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?)`,
    );
    // [person, account, date, merchant, amount, currency, movement, category]
    const rows: [string, string, string, string, number, string, string, string][] = [
      // Zonito, October 2026, GBP: a mixed month.
      ["zonito", "Main", "2026-10-05", "Employer Ltd", 650000, "GBP", "income", "One-off"],
      ["zonito", "Main", "2026-10-06", "Ocado", -12050, "GBP", "spend", "Groceries"],
      ["zonito", "Main", "2026-10-07", "Pocket", -20000, "GBP", "aside", "Moved aside"],
      ["zonito", "Main", "2026-10-08", "Pocket", 5000, "GBP", "aside", "Moved aside"], // aside credit: counted in n, in no sum
      ["zonito", "Main", "2026-10-09", "Bank", 1234, "GBP", "interest", "Interest"], // interest: n only
      ["zonito", "Pro", "2026-10-10", "Cashback", 260, "GBP", "income", "One-off"],
      // Zonito, October 2026, USD: the live scare's exact shape — a big
      // USD deposit and a small USD credit in the USD account. These
      // must land in the USD aggregates and nowhere else.
      ["zonito", "USD-Invest", "2026-10-05", "Deposit", 2317121, "USD", "income", "One-off"],
      ["zonito", "USD-Invest", "2026-10-02", "LOVE SHARMA", 10100, "USD", "income", "One-off"],
      ["zonito", "USD-Invest", "2026-10-11", "Broker", -5000, "USD", "spend", "Fees"],
      // Zonito, September 2026.
      ["zonito", "Main", "2026-09-15", "Ocado", -9999, "GBP", "spend", "Groceries"],
      ["zonito", "Barclays Current", "2026-09-30", "Employer Ltd", 1244006, "GBP", "income", "One-off"],
      // Nikhila, October 2026.
      ["nikhila", "Pro", "2026-10-01", "Cashback", 260, "GBP", "income", "One-off"],
      ["nikhila", "Pro", "2026-10-03", "UNIQLO", -4990, "GBP", "spend", "Shopping"],
      ["nikhila", "Current", "2026-10-04", "Transfer In", 10000, "GBP", "internal", "Transfer"], // internal: n only
    ];
    rows.forEach((r, i) =>
      insert.run(
        `fp${i}`,
        r[0],
        r[1],
        r[2],
        r[2].slice(0, 7),
        r[3],
        r[3],
        r[4],
        r[5],
        r[6],
        r[7],
      ),
    );
    recomputeAggregates(db, "zonito");
    recomputeAggregates(db, "nikhila");
    recomputeAggregates(db, "household");

    expectParity(db);

    // The USD income is real income — in its own currency bucket.
    const usd = aggregateSums(db).get(keyOf("household", "2026-10", "USD"));
    expect(usd).toEqual({ income: 2327221, spend: 5000, aside: 0, n: 3 });
    const gbp = aggregateSums(db).get(keyOf("household", "2026-10", "GBP"));
    expect(gbp?.income).toBe(650000 + 260 + 260);
    db.close();
  });
});

const DATA_DIR = process.env["CHITRAGUPTA_DATA_DIR"]?.trim() || null;

describe.skipIf(!DATA_DIR)("aggregates parity (ingested fixture store)", () => {
  const dir = mkdtempSync(join(tmpdir(), "chitra-parity-fixture-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("holds for every month the fixture ingest produces", () => {
    const db = openStore(dir);
    const results = ingestAll(db, DATA_DIR!);
    expect(results.every((r) => r.ok)).toBe(true);
    expectParity(db);
    db.close();
  });
});
