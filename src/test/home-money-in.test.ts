import { describe, expect, it } from "vitest";
import { incomeEntryKey } from "@/routes/index";
import type { IncomeEntry } from "@/lib/data";

/**
 * G20c: Home's "Money in" rows all share owner values (every Zonito row
 * is "zonito"), so keying by owner produced duplicate React keys. Keys
 * are built from the entry's label (merchant/salary) and date instead.
 */
describe("Home Money in keys (G20c)", () => {
  const entry = (over: Partial<IncomeEntry>): IncomeEntry => ({
    day: 25,
    amount: 7240,
    owner: "zonito",
    type: "Salary",
    ...over,
  });

  it("gives two same-owner entries different keys", () => {
    const salary = entry({});
    const refund = entry({ day: 26, amount: 50, type: "Trainline" });
    expect(salary.owner).toBe(refund.owner);
    expect(incomeEntryKey(salary)).not.toBe(incomeEntryKey(refund));
  });

  it("separates the same label on different dates and different owners", () => {
    const keys = new Set([
      incomeEntryKey(entry({})),
      incomeEntryKey(entry({ day: 28, owner: "nikhila", amount: 4860 })),
      incomeEntryKey(entry({ owner: "nikhila" })),
    ]);
    expect(keys.size).toBe(3);
  });
});
