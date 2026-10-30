import { shareOf, type Person, type Txn } from "@/lib/data";

export const calculatorDefaults = {
  usePrice: 240, uses: 60,
  habit: 4.5, frequency: 5,
  subscription: 18.99,
  oldPrice: 17.99, newPrice: 18.99,
  dayPrice: 600, years: 5,
};
export type CalculatorState = typeof calculatorDefaults;
export const CALCULATOR_STORAGE_KEY = "chitragupta.calculators.v1";

export function restoreCalculators(raw: string | null): CalculatorState {
  const state = { ...calculatorDefaults };
  try {
    const saved: unknown = JSON.parse(raw ?? "null");
    if (!saved || typeof saved !== "object") return state;
    for (const key of Object.keys(state) as (keyof CalculatorState)[]) {
      const value = (saved as Record<string, unknown>)[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
      state[key] = key === "uses" ? Math.max(1, Math.round(value))
        : key === "years" ? Math.min(30, Math.max(1, value))
        : key === "habit" ? Math.min(20, Math.max(1, value))
        : key === "frequency" ? Math.min(50, Math.round(value)) : value;
    }
  } catch { /* Unavailable or old saved data uses the sample defaults. */ }
  return state;
}

export const costPerUse = (price: number, uses: number) => uses > 0 ? price / uses : null;
export function habitTotals(amount: number, weekly: number) {
  const year = amount * weekly * 52;
  return { month: year / 12, year, fiveYears: year * 5 };
}
export function subscriptionTotals(monthly: number) {
  // 4% effective annual return, deposits at the end of each month for five years.
  const monthlyRate = Math.pow(1.04, 1 / 12) - 1;
  return { year: monthly * 12, fiveYears: monthly * 60,
    savings: monthly * (Math.pow(1 + monthlyRate, 60) - 1) / monthlyRate };
}
export function priceRise(oldPrice: number, newPrice: number) {
  const month = newPrice - oldPrice;
  return { percent: oldPrice > 0 ? month / oldPrice * 100 : null, month, year: month * 12 };
}
export function costPerDay(price: number, years: number) {
  return { day: years > 0 ? price / (years * 365) : null,
    month: years > 0 ? price / (years * 12) : null };
}
export function smallSpendFact(transactions: Txn[], person: Person = "household") {
  const spends = transactions.filter(t => t.kind === "spend" && shareOf(t, person) > 0 && shareOf(t, person) < 10);
  return { count: spends.length, total: spends.reduce((sum, t) => sum + shareOf(t, person), 0) };
}