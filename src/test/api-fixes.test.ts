import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { recomputeAggregates } from "@/lib/ingest/ingest";
import { openStore } from "@/lib/ingest/store";

const STORE_DIR = mkdtempSync(join(tmpdir(), "chitra-api-"));
process.env["CHITRAGUPTA_STORE_DIR"] = STORE_DIR;

type Api = typeof import("@/lib/api");
let api: Api;

function txn(
  db: ReturnType<typeof openStore>,
  fp: string,
  date: string,
  merchant: string,
  amountMinor: number,
  currency: string,
  movement: string,
) {
  db.prepare(
    `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
      description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
     VALUES (?, 'zonito', 'Main', ?, ?, ?, ?, ?, 0, ?, 0, ?, NULL)`,
  ).run(fp, date, date.slice(0, 7), merchant, merchant, amountMinor, currency, movement);
}

beforeAll(async () => {
  const db = openStore(STORE_DIR);
  // October 2026: GBP salary in, a large USD deposit in, GBP card spend.
  txn(db, "a1", "2026-10-25", "Employer Ltd", 724000, "GBP", "income");
  txn(db, "a2", "2026-10-06", "USD Deposit", 2317121, "USD", "income");
  txn(db, "a3", "2026-10-27", "Ocado", -44365, "GBP", "spend");
  txn(db, "a4", "2026-10-20", "Tesco", -1000, "GBP", "spend");
  recomputeAggregates(db, "zonito");
  db.close();
  api = await import("@/lib/api");
});

describe("currency separation in aggregates (Fix 6)", () => {
  it("keeps a USD inflow out of GBP income and reports it in its own bucket", async () => {
    const res = await api.handleChitraguptaApi(
      new Request("http://local/api/aggregates?month=2026-10&person=zonito"),
    );
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as {
      rows: { income_minor: number; spend_minor: number }[];
      otherCurrencies: {
        currency: string;
        income: number;
      }[];
    };
    const gbpIncome = body.rows.reduce((s, r) => s + r.income_minor, 0);
    const gbpSpend = body.rows.reduce((s, r) => s + r.spend_minor, 0);
    expect(gbpIncome).toBe(724000);
    expect(gbpSpend).toBe(45365);
    expect(body.otherCurrencies).toEqual([
      { currency: "USD", spend: 0, income: 2317121, aside: 0, txns: 1 },
    ]);
  });
});

describe("digest week handling (Fix 6)", () => {
  it("derives the month from the week's Monday, not a string slice", () => {
    expect(api.isoWeekMonday("2026-W44")).toBe("2026-10-26");
    expect(api.isoWeekMonday("2026-W01")).toBe("2025-12-29");
    expect(api.isoWeekMonday("nonsense")).toBeNull();
  });

  it("returns the October byMonth rows for week 2026-W44", async () => {
    const res = await api.handleChitraguptaApi(
      new Request("http://local/api/digest?week=2026-W44"),
    );
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as {
      month: string;
      byMonth: unknown[];
      weekTransactions: { effective_date: string }[];
    };
    expect(body.month).toBe("2026-10");
    expect(body.byMonth.length).toBeGreaterThan(0);
    // W44 runs Mon 26 Oct to Sun 1 Nov: the 27 Oct row is in, 20 Oct is out.
    expect(body.weekTransactions.map((t) => t.effective_date)).toEqual([
      "2026-10-27",
    ]);
  });
});

describe("store durability", () => {
  it("opens the store in WAL mode", () => {
    const db = openStore(mkdtempSync(join(tmpdir(), "chitra-wal-")));
    const mode = db.pragma("journal_mode", { simple: true });
    expect(mode).toBe("wal");
    db.close();
  });
});
