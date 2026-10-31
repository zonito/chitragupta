import { describe, expect, it } from "vitest";
import { parseAskQuery } from "@/lib/ask-query";

describe("parseAskQuery", () => {
  it("routes a month-and-place question to that month with the place as the term", () => {
    const plan = parseAskQuery("What did we spend in India in August?", "2026-10");
    expect(plan.month).toBe("2026-08");
    expect(plan.terms).toEqual(["india"]);
    expect(plan.apiQuery).toBe("india");
    expect(plan.category).toBeUndefined();
  });

  it("routes the Air India example chip to the merchant, with no month and no 'with' term", () => {
    const plan = parseAskQuery("What did we spend with Air India?", "2026-10");
    expect(plan.month).toBeUndefined();
    expect(plan.terms).toEqual(["air", "india"]);
    expect(plan.apiQuery).toBe("air");
    expect(plan.category).toBeUndefined();
  });

  it("keeps every content term for a merchant question with no month", () => {
    const plan = parseAskQuery("When did we last pay Mahavir Sweet Mart?", "2026-10");
    expect(plan.month).toBeUndefined();
    expect(plan.terms).toEqual(["mahavir", "sweet", "mart"]);
    expect(plan.apiQuery).toBe("mahavir");
  });

  it("infers the previous year for a month after the current month", () => {
    expect(parseAskQuery("What did we spend in December?", "2026-01").month).toBe("2025-12");
    expect(parseAskQuery("What did we spend in November?", "2026-10").month).toBe("2025-11");
  });

  it("keeps the current year for the current month and earlier months", () => {
    expect(parseAskQuery("What did we spend in October?", "2026-10").month).toBe("2026-10");
    expect(parseAskQuery("What did we spend in January?", "2026-01").month).toBe("2026-01");
    expect(parseAskQuery("What did we spend in March?", "2026-10").month).toBe("2026-03");
  });

  it("routes a lone category word to the API category filter", () => {
    const plan = parseAskQuery("How much on groceries this year?", "2026-10");
    expect(plan.month).toBeUndefined();
    expect(plan.category).toBe("Groceries");
    expect(plan.apiQuery).toBe("");
  });

  it("combines a category word with a named month", () => {
    const plan = parseAskQuery("How much on groceries in September?", "2026-10");
    expect(plan.month).toBe("2026-09");
    expect(plan.category).toBe("Groceries");
  });

  it("leaves a month-only question with no content terms", () => {
    const plan = parseAskQuery("What did we spend in August?", "2026-10");
    expect(plan.month).toBe("2026-08");
    expect(plan.terms).toEqual([]);
    expect(plan.apiQuery).toBe("");
  });

  it("does not treat a month name inside another word as a month", () => {
    const plan = parseAskQuery("When did we last pay Mayfield Bakery?", "2026-10");
    expect(plan.month).toBeUndefined();
    expect(plan.terms).toContain("mayfield");
  });
});

describe("parseAskQuery relative periods", () => {
  // Friday 30 Oct 2026: its Monday-to-Sunday week is 26 Oct – 1 Nov.
  const TODAY = "2026-10-30";

  it("routes 'this week' to the Monday-Sunday week containing today", () => {
    const plan = parseAskQuery("Total transport expense this week", "2026-10", TODAY);
    expect(plan.from).toBe("2026-10-26");
    expect(plan.to).toBe("2026-11-01");
    expect(plan.month).toBeUndefined();
    expect(plan.category).toBe("Transport");
    // Framing words never survive as terms.
    expect(plan.terms).toEqual(["transport"]);
  });

  it("gives the same week on its Monday and its Sunday", () => {
    for (const day of ["2026-10-26", "2026-11-01"]) {
      const plan = parseAskQuery("Transport this week", "2026-10", day);
      expect(plan.from).toBe("2026-10-26");
      expect(plan.to).toBe("2026-11-01");
    }
  });

  it("routes 'last week' to the previous Monday-Sunday week", () => {
    const plan = parseAskQuery("How much on transport last week?", "2026-10", TODAY);
    expect(plan.from).toBe("2026-10-19");
    expect(plan.to).toBe("2026-10-25");
    expect(plan.category).toBe("Transport");
  });

  it("routes 'this year' to 1 January through today", () => {
    const plan = parseAskQuery("How much on groceries this year?", "2026-10", TODAY);
    expect(plan.from).toBe("2026-01-01");
    expect(plan.to).toBe("2026-10-30");
    expect(plan.month).toBeUndefined();
    expect(plan.category).toBe("Groceries");
  });

  it("routes 'last month' to the previous calendar month", () => {
    const plan = parseAskQuery("What did we spend last month?", "2026-10", TODAY);
    expect(plan.month).toBe("2026-09");
    expect(plan.from).toBeUndefined();
    expect(plan.terms).toEqual([]);
  });

  it("routes 'this month' to the current calendar month", () => {
    const plan = parseAskQuery("What did we spend this month?", "2026-10", TODAY);
    expect(plan.month).toBe("2026-10");
    expect(plan.terms).toEqual([]);
  });

  it("routes 'last 30 days' to the 30 days ending today", () => {
    const plan = parseAskQuery("How much on transport in the last 30 days?", "2026-10", TODAY);
    expect(plan.from).toBe("2026-10-01");
    expect(plan.to).toBe("2026-10-30");
    expect(plan.category).toBe("Transport");
    expect(plan.terms).toEqual(["transport"]);
  });
});
