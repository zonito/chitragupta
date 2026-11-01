import { describe, it, expect } from "vitest";
import { TXNS, type Txn } from "@/lib/data";
import {
  calculatorDefaults,
  restoreCalculators,
  costPerUse,
  habitTotals,
  subscriptionTotals,
  priceRise,
  costPerDay,
  smallSpendFact,
} from "@/lib/calculators";
import { weekdayLunchFact } from "@/lib/data";

describe("Money calculators", () => {
  it("divides £240 by 60 uses", () => {
    expect(costPerUse(240, 60)).toBe(4);
    expect(costPerUse(240, 0)).toBeNull();
  });
  it("annualises £4.50 five times weekly using 52 weeks", () => {
    expect(habitTotals(4.5, 5)).toEqual({
      month: 97.5,
      year: 1170,
      fiveYears: 5850,
    });
  });
  it("totals a £18.99 monthly subscription", () => {
    const result = subscriptionTotals(18.99);
    expect(result.year).toBeCloseTo(227.88);
    expect(result.fiveYears).toBeCloseTo(1139.4);
  });
  it("illustrates 4% annual savings over five years with month-end deposits", () => {
    expect(subscriptionTotals(18.99).savings).toBeCloseTo(1256.74, 2);
  });
  it("calculates the monthly price rise and annual extra", () => {
    expect(priceRise(10, 12)).toEqual({ percent: 20, month: 2, year: 24 });
    expect(priceRise(0, 12).percent).toBeNull();
  });
  it("spreads a £600 purchase over five years", () => {
    const result = costPerDay(600, 5);
    expect(result.day).toBeCloseTo(600 / 1825);
    expect(result.month).toBe(10);
  });
  it("counts household spends strictly under £10", () => {
    const fact = smallSpendFact(TXNS);
    expect(fact.count).toBe(5);
    expect(fact.total).toBeCloseTo(41.33, 2);
  });
  it("excludes £10 spends, transfers and savings from the small-spend fact", () => {
    const base = TXNS[0];
    if (!base) throw new Error("Missing sample transaction");
    const rows: Txn[] = [
      { ...base, amount: 9.99 },
      { ...base, amount: 10 },
      { ...base, amount: 4, kind: "transfer" },
      { ...base, amount: 2, kind: "aside" },
    ];
    expect(smallSpendFact(rows)).toEqual({ count: 1, total: 9.99 });
  });
  it("restores all calculator inputs and ignores malformed saved data", () => {
    const saved = {
      usePrice: 100,
      uses: 20,
      habit: 8,
      frequency: 3,
      subscription: 12,
      oldPrice: 5,
      newPrice: 7,
      dayPrice: 1000,
      years: 10,
    };
    expect(restoreCalculators(JSON.stringify(saved))).toEqual(saved);
    expect(restoreCalculators("invalid")).toEqual(calculatorDefaults);
    expect(restoreCalculators('{"uses":0,"habit":25,"years":0}')).toMatchObject(
      { uses: 1, habit: 20, years: 1 },
    );
  });
  it("adds up the weekday Pret lunches as a plain fact", () => {
    const fact = weekdayLunchFact();
    expect(fact.count).toBe(3);
    expect(fact.each).toBe(7.45);
    expect(fact.total).toBeCloseTo(22.35, 2);
    expect(fact.year).toBe(268);
  });
});
