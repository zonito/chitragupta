import type { Category, Person } from "./data";

/**
 * Browser-safe helpers for the Categories period selector. A scope value
 * is one string — "month:YYYY-MM", "year:YYYY" or "all" — so the single
 * <select> on the screen carries every period kind. Anything other than
 * the current month is fetched from the scoped GET /api/aggregates (see
 * aggregatesScope in api.ts), which computes weighted GBP spend from
 * transactions server-side; the current month keeps the snapshot path.
 */

export interface ScopeOption {
  value: string;
  label: string;
}

export type ScopeSelection =
  | { kind: "month"; month: string }
  | { kind: "year"; year: string }
  | { kind: "all" };

export function parseScope(value: string): ScopeSelection {
  if (value === "all") return { kind: "all" };
  if (value.startsWith("year:")) return { kind: "year", year: value.slice(5) };
  if (value.startsWith("month:"))
    return { kind: "month", month: value.slice(6) };
  return { kind: "all" };
}

/** Options for the one period control: every month in the store (newest
 * first, as monthOptions returns them), then each year as a whole-year
 * option, then All time. */
export function scopeOptions(
  months: { key: string; label: string }[],
): ScopeOption[] {
  const options: ScopeOption[] = months.map((m) => ({
    value: `month:${m.key}`,
    label: m.label,
  }));
  const years: string[] = [];
  for (const m of months) {
    const year = m.key.slice(0, 4);
    if (!years.includes(year)) years.push(year);
  }
  for (const year of years) {
    options.push({ value: `year:${year}`, label: `${year} (whole year)` });
  }
  options.push({ value: "all", label: "All time" });
  return options;
}

/** The phrase after the headline total: "March 2026", "2025", "all time". */
export function scopeLabel(
  value: string,
  months: { key: string; label: string }[],
): string {
  const scope = parseScope(value);
  if (scope.kind === "all") return "all time";
  if (scope.kind === "year") return scope.year;
  return months.find((m) => m.key === scope.month)?.label ?? scope.month;
}

export interface CategoryScopeRow {
  category: Category;
  amount: number; // pounds
  typical: number | null; // pounds; null when the scope has no "usually"
  series: number[]; // pounds, aligned with seriesLabels
}

export interface CategoryScopeData {
  total: number; // pounds
  rows: CategoryScopeRow[];
  seriesLabels: string[];
}

interface ApiScopeRow {
  category: string;
  spend_minor: number;
  typical_minor: number | null;
  series: number[];
}

interface ApiScopeBody {
  ok: boolean;
  total_minor: number;
  seriesLabels: string[];
  rows: ApiScopeRow[];
  merchants?: { merchant: string; spend_minor: number }[];
}

function scopeParams(value: string, person: Person): URLSearchParams {
  const scope = parseScope(value);
  const params = new URLSearchParams({ person, scope: scope.kind });
  if (scope.kind === "month") params.set("month", scope.month);
  if (scope.kind === "year") params.set("year", scope.year);
  return params;
}

async function fetchScope(
  value: string,
  person: Person,
  category?: string,
): Promise<ApiScopeBody> {
  const params = scopeParams(value, person);
  if (category) params.set("category", category);
  const res = await fetch(`/api/aggregates?${params.toString()}`);
  if (!res.ok) throw new Error(`aggregates request failed: ${res.status}`);
  const body = (await res.json()) as ApiScopeBody;
  if (!body.ok) throw new Error("aggregates request failed");
  return body;
}

export async function fetchCategoryScope(
  value: string,
  person: Person,
): Promise<CategoryScopeData> {
  const body = await fetchScope(value, person);
  return {
    total: body.total_minor / 100,
    seriesLabels: body.seriesLabels,
    rows: body.rows.map((r) => ({
      category: r.category as Category,
      amount: r.spend_minor / 100,
      typical: r.typical_minor === null ? null : r.typical_minor / 100,
      series: r.series.map((v) => v / 100),
    })),
  };
}

export async function fetchCategoryMerchants(
  value: string,
  person: Person,
  category: string,
): Promise<{ merchant: string; amount: number }[]> {
  const body = await fetchScope(value, person, category);
  return (body.merchants ?? []).map((m) => ({
    merchant: m.merchant,
    amount: m.spend_minor / 100,
  }));
}
