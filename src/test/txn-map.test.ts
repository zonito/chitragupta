import { describe, expect, it } from "vitest";
import { apiTxnToTxn, type ApiTxnRow } from "@/lib/txn-map";
import { searchRecords } from "@/lib/record-search";

const row = (over: Partial<ApiTxnRow>): ApiTxnRow => ({
  id: "fp-1",
  person: "zonito",
  account: "Main",
  date: "2026-08-03",
  month: "2026-08",
  description: "Mahavir Sweet Mart",
  merchant: "Mahavir Sweet Mart",
  amountMinor: -2710,
  currency: "GBP",
  movement: "spend",
  category: "Groceries",
  ...over,
});

const mahavirRows: ApiTxnRow[] = [
  row({ id: "fp-aug", date: "2026-08-03", month: "2026-08", amountMinor: -2710 }),
  row({ id: "fp-may", date: "2026-05-11", month: "2026-05", amountMinor: -1800 }),
  row({ id: "fp-dec", date: "2025-12-24", month: "2025-12", amountMinor: -2200 }),
];

describe("apiTxnToTxn", () => {
  it("maps a spend row to the snapshot Txn shape", () => {
    const txn = apiTxnToTxn(mahavirRows[0]!);
    expect(txn).toEqual({
      id: "fp-aug",
      date: "2026-08-03",
      day: 3,
      monthKey: "2026-08",
      merchant: "Mahavir Sweet Mart",
      category: "Groceries",
      amount: 27.1,
      owner: "zonito",
      account: "Revolut Main · Zonito",
      accountId: "Main",
      kind: "spend",
    });
  });

  it("skips rows the snapshot never carries: non-GBP, fees, interest", () => {
    expect(apiTxnToTxn(row({ currency: "USD" }))).toBeNull();
    expect(apiTxnToTxn(row({ movement: "fee" }))).toBeNull();
    expect(apiTxnToTxn(row({ movement: "interest" }))).toBeNull();
  });

  it("maps an income row with the income kind and the incoming flag", () => {
    const txn = apiTxnToTxn(
      row({
        id: "fp-sal",
        merchant: "ACME PAYROLL",
        description: "ACME PAYROLL",
        amountMinor: 300000,
        movement: "income",
        category: "One-off",
      }),
    );
    expect(txn).toEqual({
      id: "fp-sal",
      date: "2026-08-03",
      day: 3,
      monthKey: "2026-08",
      merchant: "ACME PAYROLL",
      category: "One-off",
      amount: 3000,
      owner: "zonito",
      account: "Revolut Main · Zonito",
      accountId: "Main",
      kind: "income",
      incoming: true,
    });
  });

  it("maps internal and aside movements, and Joint accounts to the joint owner", () => {
    const transfer = apiTxnToTxn(row({ movement: "internal", account: "Joint", category: "Transfer" }));
    expect(transfer?.kind).toBe("transfer");
    expect(transfer?.category).toBe("Transfer");
    expect(transfer?.owner).toBe("joint");
    expect(transfer?.account).toBe("Joint Bills · Revolut");
    const aside = apiTxnToTxn(row({ movement: "aside", category: "Moved aside" }));
    expect(aside?.kind).toBe("aside");
    expect(aside?.category).toBe("Moved aside");
  });

  it("falls back to One-off for categories outside the UI whitelist", () => {
    expect(apiTxnToTxn(row({ category: "Fees" }))?.category).toBe("One-off");
  });

  it("keeps a differing description as a note so record search can match it", () => {
    const txn = apiTxnToTxn(row({ merchant: "Trainline", description: "Train ticket to Edinburgh" }));
    expect(txn?.note).toBe("Train ticket to Edinburgh");
  });
});

describe("searchRecords over API-shaped rows", () => {
  it("finds the Aug 2026 Mahavir row as the latest match", () => {
    const txns = mahavirRows
      .map(apiTxnToTxn)
      .filter((t): t is NonNullable<typeof t> => t !== null);
    const result = searchRecords("mahavir sweet mart", "household", [], txns);
    expect(result.records).toHaveLength(3);
    expect(result.latest?.merchant).toBe("Mahavir Sweet Mart");
    expect(result.latest?.date).toBe("3 Aug 2026");
    expect(result.latest?.amount).toBe(27.1);
  });

  it("matches on the description note, the way the API q search does", () => {
    const txns = [apiTxnToTxn(row({ merchant: "Trainline", description: "Train ticket to Edinburgh" }))!];
    const result = searchRecords("edinburgh", "household", [], txns);
    expect(result.records).toHaveLength(1);
  });
});
