import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingestAccount, recomputeAggregates } from "@/lib/ingest/ingest";
import { setMerchant } from "@/lib/ingest/merchants";
import { openStore } from "@/lib/ingest/store";

/**
 * Phase B / B1: category corrections persist, learn, and promote.
 *
 * (a)/(b) exercise POST /api/merchants end to end against a throwaway
 * store: a "user" source is recorded in merchant memory and promotes the
 * merchant's outgoing moved-aside rows to spend; the default source
 * stays "molang" and promotes nothing.
 * (c) exercises ingest learning: a fresh ingest stores a new outgoing
 * transfer to a user-corrected merchant as spend, and as aside without
 * the correction — on both the statement and the savings paths.
 */

const STORE_DIR = mkdtempSync(join(tmpdir(), "chitra-corr-"));
const prevStoreEnv = process.env["CHITRAGUPTA_STORE_DIR"];
process.env["CHITRAGUPTA_STORE_DIR"] = STORE_DIR;

type Api = typeof import("@/lib/api");
let api: Api;

function txn(
  db: ReturnType<typeof openStore>,
  fp: string,
  merchant: string,
  amountMinor: number,
  movement: string,
) {
  db.prepare(
    `INSERT INTO transactions (fingerprint, person, account, effective_date, year_month,
      description, merchant, amount_minor, fee_minor, currency, balance_minor, movement, category)
     VALUES (?, 'zonito', 'Main', '2026-10-05', '2026-10', ?, ?, ?, 0, 'GBP', 0, ?, NULL)`,
  ).run(fp, merchant, merchant, amountMinor, movement);
}

function readStore() {
  return openStore(STORE_DIR);
}

async function postMerchant(body: Record<string, unknown>) {
  const res = await api.handleChitraguptaApi(
    new Request("http://local/api/merchants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return res!;
}

beforeAll(async () => {
  const db = openStore(STORE_DIR);
  // "User Tutor": outgoing aside rows, an incoming aside row, an internal
  // row and an ordinary spend row.
  txn(db, "u-out-1", "User Tutor", -5000, "aside");
  txn(db, "u-out-2", "User Tutor", -3000, "aside");
  txn(db, "u-in-1", "User Tutor", 2000, "aside");
  txn(db, "u-int-1", "User Tutor", -4000, "internal");
  txn(db, "u-spend-1", "User Tutor", -1000, "spend");
  // "Default Tutor": one outgoing aside row, corrected without a source.
  txn(db, "d-out-1", "Default Tutor", -7000, "aside");
  // "Bogus Tutor": one outgoing aside row, corrected with a bad source.
  txn(db, "b-out-1", "Bogus Tutor", -9000, "aside");
  recomputeAggregates(db, "zonito");
  db.close();
  api = await import("@/lib/api");
});

afterAll(() => {
  if (prevStoreEnv === undefined) delete process.env["CHITRAGUPTA_STORE_DIR"];
  else process.env["CHITRAGUPTA_STORE_DIR"] = prevStoreEnv;
  rmSync(STORE_DIR, { recursive: true, force: true });
});

describe("POST /api/merchants source handling and promotion", () => {
  it("(a) source 'user' records memory as 'user' and promotes outgoing aside rows only", async () => {
    const res = await postMerchant({
      merchant: "User Tutor",
      category: "School",
      source: "user",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });

    const db = readStore();
    const memory = db
      .prepare(
        "SELECT category, source FROM merchant_memory WHERE merchant = ?",
      )
      .get("User Tutor") as { category: string; source: string };
    expect(memory).toEqual({ category: "School", source: "user" });

    const rows = db
      .prepare(
        "SELECT fingerprint, movement, category FROM transactions WHERE merchant = ?",
      )
      .all("User Tutor") as {
      fingerprint: string;
      movement: string;
      category: string;
    }[];
    const byFp = new Map(rows.map((r) => [r.fingerprint, r]));
    // Outgoing aside rows are promoted to spend under the category.
    expect(byFp.get("u-out-1")).toMatchObject({
      movement: "spend",
      category: "School",
    });
    expect(byFp.get("u-out-2")).toMatchObject({
      movement: "spend",
      category: "School",
    });
    // The incoming aside row and the internal row keep their movement.
    expect(byFp.get("u-in-1")!.movement).toBe("aside");
    expect(byFp.get("u-int-1")!.movement).toBe("internal");
    expect(byFp.get("u-spend-1")!.movement).toBe("spend");

    // Aggregates follow: School spend is the two promoted rows plus the
    // row that was already spend.
    const agg = db
      .prepare(
        `SELECT spend_minor FROM month_aggregates
         WHERE person = 'zonito' AND year_month = '2026-10' AND category = 'School' AND currency = 'GBP'`,
      )
      .get() as { spend_minor: number };
    expect(agg.spend_minor).toBe(9000);
    db.close();
  });

  it("(b) no source keeps memory at 'molang' and does NOT promote", async () => {
    const res = await postMerchant({
      merchant: "Default Tutor",
      category: "Home",
    });
    expect(res.status).toBe(200);

    const db = readStore();
    const memory = db
      .prepare(
        "SELECT category, source FROM merchant_memory WHERE merchant = ?",
      )
      .get("Default Tutor") as { category: string; source: string };
    expect(memory).toEqual({ category: "Home", source: "molang" });
    const row = db
      .prepare(
        "SELECT movement, category FROM transactions WHERE fingerprint = 'd-out-1'",
      )
      .get() as { movement: string; category: string };
    // The blanket category update still lands; the movement does not move.
    expect(row).toEqual({ movement: "aside", category: "Home" });
    const agg = db
      .prepare(
        `SELECT spend_minor, aside_minor FROM month_aggregates
         WHERE person = 'zonito' AND year_month = '2026-10' AND category = 'Home' AND currency = 'GBP'`,
      )
      .get() as { spend_minor: number; aside_minor: number };
    expect(agg).toEqual({ spend_minor: 0, aside_minor: 7000 });
    db.close();
  });

  it("an unrecognised source falls back to 'molang' and does NOT promote", async () => {
    const res = await postMerchant({
      merchant: "Bogus Tutor",
      category: "Transport",
      source: "nonsense",
    });
    expect(res.status).toBe(200);

    const db = readStore();
    const memory = db
      .prepare("SELECT source FROM merchant_memory WHERE merchant = ?")
      .get("Bogus Tutor") as { source: string };
    expect(memory.source).toBe("molang");
    const row = db
      .prepare(
        "SELECT movement FROM transactions WHERE fingerprint = 'b-out-1'",
      )
      .get() as { movement: string };
    expect(row.movement).toBe("aside");
    db.close();
  });
});

const ACCOUNT_HEADER =
  "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n";

function dataDirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "chitra-learn-"));
  const originals = join(dir, "Originals");
  mkdirSync(originals, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(originals, name), text);
  }
  writeFileSync(
    join(dir, "account-identifiers.json"),
    JSON.stringify({ zonito: ["Savings-9000000001", "Savings-9000000002"] }),
  );
  return dir;
}

const MAIN_WITH_TUTOR =
  ACCOUNT_HEADER +
  "Transfer,Current,2026-10-05 10:00:00,2026-10-05 10:00:01,To Learn Tutor,-50.00,0.00,GBP,COMPLETED,950.00\n" +
  "Card Payment,Current,2026-10-06 10:00:00,2026-10-06 10:00:01,Ocado,-10.00,0.00,GBP,COMPLETED,940.00\n";

const SAVINGS_WITH_IBKR =
  'Date,Description,Money Out,Money In,Balance\n"Oct 5, 2026",To IBKR LLC,50.00,,950.00\n';

function movementOf(
  db: ReturnType<typeof openStore>,
  merchant: string,
): string {
  const row = db
    .prepare("SELECT movement FROM transactions WHERE merchant = ?")
    .get(merchant) as { movement: string };
  return row.movement;
}

describe("(c) ingest learning from user corrections", () => {
  it("statement path: a new outgoing transfer to a user-corrected merchant ingests as spend", () => {
    const db = openStore(mkdtempSync(join(tmpdir(), "chitra-store-")));
    setMerchant(db, "Learn Tutor", "School", { source: "user" });
    const dir = dataDirWith({
      "account-statement_2022_f5660e.csv": MAIN_WITH_TUTOR,
    });
    ingestAccount(db, "zonito", "Main", dir);
    expect(movementOf(db, "Learn Tutor")).toBe("spend");
    expect(movementOf(db, "Ocado")).toBe("spend");
    db.close();
  });

  it("statement path: without the correction the same transfer stays aside", () => {
    const db = openStore(mkdtempSync(join(tmpdir(), "chitra-store-")));
    const dir = dataDirWith({
      "account-statement_2022_f5660e.csv": MAIN_WITH_TUTOR,
    });
    ingestAccount(db, "zonito", "Main", dir);
    expect(movementOf(db, "Learn Tutor")).toBe("aside");
    db.close();
  });

  it("statement path: a 'molang' correction does not teach ingest", () => {
    const db = openStore(mkdtempSync(join(tmpdir(), "chitra-store-")));
    setMerchant(db, "Learn Tutor", "School", { source: "molang" });
    const dir = dataDirWith({
      "account-statement_2022_f5660e.csv": MAIN_WITH_TUTOR,
    });
    ingestAccount(db, "zonito", "Main", dir);
    expect(movementOf(db, "Learn Tutor")).toBe("aside");
    db.close();
  });

  it("savings path: a user-corrected merchant ingests as spend, aside without it", () => {
    const dir = dataDirWith({
      "savings-9000000002.csv": SAVINGS_WITH_IBKR,
    });
    const corrected = openStore(mkdtempSync(join(tmpdir(), "chitra-store-")));
    setMerchant(corrected, "IBKR LLC", "Home", { source: "user" });
    ingestAccount(corrected, "zonito", "Savings-9000000002", dir);
    expect(movementOf(corrected, "IBKR LLC")).toBe("spend");
    corrected.close();

    const plain = openStore(mkdtempSync(join(tmpdir(), "chitra-store-")));
    ingestAccount(plain, "zonito", "Savings-9000000002", dir);
    expect(movementOf(plain, "IBKR LLC")).toBe("aside");
    plain.close();
  });
});
