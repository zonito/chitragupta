import { describe, expect, it } from "vitest";
import { DOCS, TXNS, attachReceipt, receiptForTransaction, type Txn } from "@/lib/data";
import { searchRecords } from "@/lib/record-search";

describe("Ask recorded facts", () => {
  it("does not invent a boiler service absent from the sample records", () => {
    expect(searchRecords("When did we last get the boiler serviced?", "household").records).toEqual([]);
  });
  it("finds service metadata and returns the latest actual payment", () => {
    const base = TXNS[0];
    if (!base) throw new Error("Missing fixture");
    const transactions: Txn[] = [10, 22].map((day) => ({ ...base, id: `service-${day}`, day, merchant: "N14 Heating", note: "Boiler service", amount: 95 }));
    const result = searchRecords("When did we last get the boiler serviced?", "household", [], transactions);
    expect(result.records).toHaveLength(2);
    expect(result.latest?.date).toBe("22 Oct 2026");
    expect(result.latest?.amount).toBe(95);
  });
  it("finds the washing machine warranty with its recorded expiry", () => {
    const result = searchRecords("When does the washing machine warranty end?", "nikhila");
    expect(result.latest?.document?.id).toBe("d4");
    expect(result.latest?.document?.warrantyEnds).toBe("Mar 2028");
    expect(result.warrantyQuestion).toBe(true);
    expect(searchRecords("washing machine warranty", "zonito").records).toEqual([]);
  });
  it("combines joint payment and bill, showing the personal share", () => {
    const result = searchRecords("When did we last pay Octopus Energy?", "zonito");
    expect(result.records).toHaveLength(1);
    expect(result.latest?.transaction?.id).toBe("2");
    expect(result.latest?.document?.id).toBe("d2");
    expect(result.latest?.amount).toBe(69);
  });
  it("searches newly attached documents and keeps unmatched files household-only", () => {
    const txn = TXNS.find((t) => t.id === "7");
    if (!txn) throw new Error("Missing Ocado transaction");
    const docs = attachReceipt(DOCS, receiptForTransaction(txn));
    expect(searchRecords("Ocado receipt", "nikhila", docs).latest?.document?.txnId).toBe("7");
    expect(searchRecords("Boots Pharmacy receipt", "household").latest?.document?.id).toBe("d6");
    expect(searchRecords("Boots Pharmacy receipt", "nikhila").records).toEqual([]);
  });
  it("does not answer empty or unsupported questions with arbitrary matches", () => {
    expect(searchRecords("When did we last?", "household").records).toEqual([]);
    expect(searchRecords("boiler washing machine", "household").records).toEqual([]);
  });
});