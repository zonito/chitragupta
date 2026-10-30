import { describe, expect, it } from "vitest";
import { DOCS, TXNS, attachReceipt, detachReceipt, docFor, isMatched, receiptForTransaction, shareOf } from "@/lib/data";

function transaction(id: string) {
  const txn = TXNS.find((t) => t.id === id);
  if (!txn) throw new Error("Missing sample transaction");
  return txn;
}

describe("Transaction receipts and shares", () => {
  it("generates a matched Ocado receipt using the full transaction date and amount", () => {
    const receipt = receiptForTransaction(transaction("7"));
    const documents = attachReceipt(DOCS, receipt);
    expect(docFor("7", documents)?.path).toBe("PersonalFinance/Documents/Receipts/2026/2026-10/2026-10-03_Ocado_£112.40.pdf");
    expect(documents).toHaveLength(7);
    expect(isMatched(receipt)).toBe(true);
  });
  it("replaces the attachment without duplicating the matched document", () => {
    const documents = attachReceipt(DOCS, receiptForTransaction(transaction("2"), "png"));
    expect(documents).toHaveLength(6);
    expect(documents.filter((d) => d.txnId === "2")).toHaveLength(1);
    expect(docFor("2", documents)?.path).toContain("2026-10-01_OctopusEnergy_£138.00.png");
  });
  it("removes the transaction link and retains the document as unmatched", () => {
    const documents = detachReceipt(DOCS, "2");
    expect(docFor("2", documents)).toBeUndefined();
    const doc = documents.find((d) => d.id === "d2");
    expect(doc).toBeDefined();
    if (!doc) throw new Error("Missing detached document");
    expect(isMatched(doc)).toBe(false);
    expect(docFor("2", DOCS)?.id).toBe("d2");
  });
  it("shows £69 of the £138 joint bill in either person's view and £138 for Household", () => {
    const txn = transaction("2");
    expect(shareOf(txn, "zonito")).toBe(69);
    expect(shareOf(txn, "nikhila")).toBe(69);
    expect(shareOf(txn, "household")).toBe(138);
  });
  it("reattaches a removed mock receipt without creating a duplicate file", () => {
    const receipt = receiptForTransaction(transaction("7"));
    const detached = detachReceipt(attachReceipt(DOCS, receipt), "7");
    const documents = attachReceipt(detached, receipt);
    expect(documents).toHaveLength(7);
    expect(documents.filter((d) => d.id === receipt.id)).toHaveLength(1);
    expect(docFor("7", documents)?.id).toBe(receipt.id);
  });
});