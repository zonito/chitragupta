import { describe, expect, it } from "vitest";
import { DOCS, TXNS, attachReceipt, detachReceipt, documentOwner, documentsFor, ocadoAnswer, receiptForTransaction, weekdayLunchFact, weeklySpend, type Person, type Txn } from "@/lib/data";
import { smallSpendFact } from "@/lib/calculators";

describe("Person-aware facts", () => {
  it.each<[Person, number, number]>([["household", 5, 41.33], ["zonito", 3, 22.35], ["nikhila", 2, 18.98]])("counts small spending shares for %s", (person, count, total) => {
    expect(smallSpendFact(TXNS, person).count).toBe(count);
    expect(smallSpendFact(TXNS, person).total).toBeCloseTo(total, 2);
  });
  it("uses the share, not the full joint bill, and excludes zero, £10, transfers and savings", () => {
    const base = TXNS[0];
    if (!base) throw new Error("Missing sample transaction");
    const rows: Txn[] = [{ ...base, amount: 18 }, { ...base, amount: 20 }, { ...base, amount: 0 }, { ...base, amount: 4, kind: "transfer" }, { ...base, amount: 4, kind: "aside" }];
    expect(smallSpendFact(rows, "zonito")).toEqual({ count: 1, total: 9 });
  });
  it("includes Pret lunches for Zonito and Household but none for Nikhila", () => {
    expect(weekdayLunchFact("zonito")).toEqual({ count: 3, each: 7.45, total: 22.35, year: 268 });
    expect(weekdayLunchFact("household")).toEqual(weekdayLunchFact("zonito"));
    expect(weekdayLunchFact("nikhila").count).toBe(0);
  });
  it.each<[Person, number, number]>([["household", 347.55, 713.98], ["zonito", 71.15, 237.09], ["nikhila", 276.4, 476.89]])("sums actual 23–29 and 16–22 October spending for %s", (person, current, previous) => {
    expect(weeklySpend(person).thisWeek).toBeCloseTo(current, 2);
    expect(weeklySpend(person).lastWeek).toBeCloseTo(previous, 2);
  });
  it("counts all five actual Ocado orders and uses a household fallback only for Zonito", () => {
    for (const person of ["household", "zonito", "nikhila"] as const) {
      const answer = ocadoAnswer(person);
      expect(answer.orders).toHaveLength(5);
      expect(answer.total).toBeCloseTo(530.15, 2);
      expect(answer.fallback).toBe(person === "zonito");
      expect(answer.answerPerson).toBe(person === "zonito" ? "household" : person);
    }
  });
  it("filters documents by matched owners and shows unmatched files only to Household", () => {
    expect(documentsFor(DOCS, "household").map((d) => d.id)).toEqual(["d1", "d2", "d3", "d4", "d5", "d6"]);
    expect(documentsFor(DOCS, "zonito").map((d) => d.id)).toEqual(["d1", "d2", "d3"]);
    expect(documentsFor(DOCS, "nikhila").map((d) => d.id)).toEqual(["d2", "d4", "d5"]);
    expect(DOCS.map(documentOwner)).toEqual(["zonito", "joint", "zonito", "nikhila", "nikhila", undefined]);
  });
  it("resolves newly attached documents through their transaction and hides detached files from personal views", () => {
    const txn = TXNS.find((t) => t.id === "7");
    if (!txn) throw new Error("Missing Ocado transaction");
    const attached = attachReceipt(DOCS, receiptForTransaction(txn));
    expect(documentsFor(attached, "nikhila")).toHaveLength(4);
    expect(documentsFor(attached, "zonito")).toHaveLength(3);
    const removed = detachReceipt(attached, "7");
    expect(documentsFor(removed, "nikhila")).toHaveLength(3);
    expect(documentsFor(removed, "household")).toHaveLength(7);
  });
});