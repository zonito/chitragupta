import { gbp, SUBS, type Person } from "./data";

/**
 * Bucketing for the spending-over-time charts (Categories timeline,
 * Home trend, Subscriptions trend share the SpendChart component; this
 * library owns the period maths so every surface buckets identically).
 *
 * Monthly-family presets derive from the snapshot's monthly history —
 * the precomputed month_aggregates — so a bucket total equals the
 * aggregates figure for those months EXACTLY for the same person view.
 * The Daily preset is the one exception: days live only in
 * transactions, so it fetches /api/aggregates/daily, which resolves
 * categories in recomputeAggregates' order. "Current" everywhere is
 * anchored to the store's latest data month, never the wall clock.
 */

export type ChartPreset = "daily" | "monthly" | "quarterly" | "ytd" | "oneyear" | "all";

export const CHART_PRESETS: { id: ChartPreset; label: string }[] = [
  { id: "daily", label: "Daily" },
  { id: "monthly", label: "Monthly" },
  { id: "quarterly", label: "Quarterly" },
  { id: "ytd", label: "YTD" },
  { id: "oneyear", label: "1Y" },
  { id: "all", label: "All" },
];

export interface MonthlyRows {
  months: string[]; // continuous ascending YYYY-MM
  rows: { category: string; series: number[] }[]; // pounds, aligned with months
}

export interface ChartBucket {
  key: string;
  label: string; // "October 2026" / "Q3 2026" / "31 Oct 2026"
  short: string; // axis label: "Oct" / "Q3 26" / "31"
  total: number; // pounds
  values: Record<string, number>; // category → pounds (positive entries only)
  /** A quarter bucket built from fewer than its 3 calendar months
   * (only possible at the very start of the store's history). */
  partial?: boolean;
}

/**
 * System categories are money plumbing, not spending: capital moves
 * ("Moved aside"), transfers between own accounts, interest, fees.
 * They stay in the Categories list and page totals, but the CHART
 * never stacks them as spend on any surface — live aggregates carry
 * e.g. a "Moved aside" row with positive spend_minor in some months
 * (incoming aside money), which stacked as if it were spending.
 */
export const CHART_EXCLUDED_CATEGORIES: ReadonlySet<string> = new Set([
  "Moved aside",
  "Transfer",
  "Interest",
  "Fees",
]);

const monthName = (key: string, style: "long" | "short") =>
  new Intl.DateTimeFormat("en-GB", {
    month: style,
    timeZone: "UTC",
  }).format(new Date(`${key}-02T00:00:00Z`));

const monthYear = (key: string) =>
  new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${key}-02T00:00:00Z`));

function bucketsFromMonths(data: MonthlyRows, keys: string[]): ChartBucket[] {
  const index = new Map(data.months.map((m, i) => [m, i]));
  return keys.map((key) => {
    const i = index.get(key);
    const values: Record<string, number> = {};
    let total = 0;
    if (i !== undefined) {
      for (const row of data.rows) {
        if (CHART_EXCLUDED_CATEGORIES.has(row.category)) continue;
        const v = row.series[i] ?? 0;
        if (v > 0) {
          values[row.category] = v;
          total += v;
        }
      }
    }
    return { key, label: monthYear(key), short: monthName(key, "short"), total, values };
  });
}

/** The last `count` months of history (fewer when history is shorter). */
export function monthlyBuckets(data: MonthlyRows, count = 12): ChartBucket[] {
  return bucketsFromMonths(data, data.months.slice(-count));
}

interface Quarter {
  key: string; // "2026-Q3"
  label: string;
  short: string;
  months: string[];
}

function quartersOf(months: string[]): Quarter[] {
  const out: Quarter[] = [];
  for (const key of months) {
    const [y, m] = key.split("-").map(Number) as [number, number];
    const q = Math.floor((m - 1) / 3) + 1;
    const qkey = `${y}-Q${q}`;
    const last = out[out.length - 1];
    if (last && last.key === qkey) {
      last.months.push(key);
    } else {
      out.push({
        key: qkey,
        label: `Q${q} ${y}`,
        short: `Q${q} ${String(y).slice(2)}`,
        months: [key],
      });
    }
  }
  return out;
}

function bucketsFromQuarters(data: MonthlyRows, quarters: Quarter[]): ChartBucket[] {
  return quarters.map((q) => {
    const monthBuckets = bucketsFromMonths(data, q.months);
    const values: Record<string, number> = {};
    let total = 0;
    for (const b of monthBuckets) {
      total += b.total;
      for (const [cat, v] of Object.entries(b.values)) {
        values[cat] = (values[cat] ?? 0) + v;
      }
    }
    return {
      key: q.key,
      label: q.label,
      short: q.short,
      total,
      values,
      ...(q.months.length < 3 ? { partial: true } : {}),
    };
  });
}

/** Calendar quarters over the history: the last `count`, or all. */
export function quarterlyBuckets(data: MonthlyRows, count: number | null = 12): ChartBucket[] {
  const quarters = quartersOf(data.months);
  return bucketsFromQuarters(data, count === null ? quarters : quarters.slice(-count));
}

/** Current calendar year by month, Jan → the latest data month. The
 * year is the latest month's year (the store's "now"), so a store
 * whose data ends in March shows Jan–Mar, whatever the wall clock says. */
export function ytdBuckets(data: MonthlyRows): ChartBucket[] {
  const latest = data.months[data.months.length - 1];
  if (!latest) return [];
  const year = latest.slice(0, 4);
  return bucketsFromMonths(data, data.months.filter((m) => m.startsWith(`${year}-`)));
}

/** Running totals across buckets (the 1Y pace-of-spend view). */
export function cumulativeBuckets(buckets: ChartBucket[]): ChartBucket[] {
  const running: Record<string, number> = {};
  let total = 0;
  return buckets.map((b) => {
    const values: Record<string, number> = {};
    for (const [cat, v] of Object.entries(b.values)) {
      running[cat] = (running[cat] ?? 0) + v;
    }
    for (const [cat, v] of Object.entries(running)) {
      if (v > 0) values[cat] = v;
    }
    total += b.total;
    return { ...b, total, values };
  });
}

/** Per-category totals over a bucket window, biggest first. */
export function categoryTotals(buckets: ChartBucket[]): { name: string; total: number }[] {
  const totals = new Map<string, number>();
  for (const b of buckets) {
    for (const [cat, v] of Object.entries(b.values)) {
      totals.set(cat, (totals.get(cat) ?? 0) + v);
    }
  }
  return [...totals.entries()]
    .map(([name, total]) => ({ name, total }))
    .filter((t) => t.total > 0)
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

/** Every YYYY-MM from first to last inclusive (both YYYY-MM keys). */
export function continuousMonths(first: string, last: string): string[] {
  const out: string[] = [];
  const [fy, fm] = first.split("-").map(Number) as [number, number];
  const [ly, lm] = last.split("-").map(Number) as [number, number];
  const total = (ly - fy) * 12 + (lm - fm);
  for (let i = 0; i <= total; i++) {
    const d = new Date(Date.UTC(fy, fm - 1 + i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

/**
 * The Subscriptions trend as MonthlyRows: one series ("Subscriptions")
 * summing the ACTIVE subscriptions' cluster charges per month — the
 * detector's own charge history, filtered to the current person view
 * exactly as the Subscriptions screen filters its cards (household =
 * everyone's, otherwise the owner's). Months run continuously over the
 * visible subs' charge span so a charge-free month reads as a gap in
 * the bill, not a missing bucket.
 */
export function subscriptionMonthlyRows(person: Person): MonthlyRows {
  const visible = SUBS.filter(
    (s) => s.status === "Active" && (person === "household" || s.owner === person),
  );
  const perMonth = new Map<string, number>();
  for (const s of visible) {
    for (const cm of s.chargeMonths ?? []) {
      perMonth.set(cm.month, (perMonth.get(cm.month) ?? 0) + cm.total);
    }
  }
  if (perMonth.size === 0) return { months: [], rows: [] };
  const keys = [...perMonth.keys()].sort();
  const months = continuousMonths(keys[0]!, keys[keys.length - 1]!);
  return {
    months,
    rows: [
      {
        category: "Subscriptions",
        series: months.map((m) => perMonth.get(m) ?? 0),
      },
    ],
  };
}

/* ---------------- Daily (fetched) ---------------- */

export interface DailyData {
  start: string | null;
  end: string | null;
  /** The store's earliest transaction date: a comparison window that
   * starts before this is not fully covered and must be omitted. */
  dataStart: string | null;
  buckets: { date: string; total: number; categories: Record<string, number> }[]; // pounds
}

interface DailyApiBody {
  ok: boolean;
  start: string | null;
  end: string | null;
  dataStart: string | null;
  buckets: { date: string; total_minor: number; categories: Record<string, number> }[];
}

export async function fetchDaily(person: Person, days: number): Promise<DailyData> {
  const res = await fetch(`/api/aggregates/daily?person=${person}&days=${days}`);
  if (!res.ok) throw new Error(`daily aggregates request failed: ${res.status}`);
  const body = (await res.json()) as DailyApiBody;
  if (!body.ok) throw new Error("daily aggregates request failed");
  return {
    start: body.start,
    end: body.end,
    dataStart: body.dataStart,
    buckets: body.buckets.map((b) => ({
      date: b.date,
      total: b.total_minor / 100,
      categories: Object.fromEntries(
        Object.entries(b.categories).map(([k, v]) => [k, v / 100]),
      ),
    })),
  };
}

const dayLabelOf = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00Z`));

/** The last `count` days of a fetched daily window as chart buckets.
 * System categories are dropped (see CHART_EXCLUDED_CATEGORIES) and
 * the bucket total recomputed from what remains, so a day's stacked
 * total still equals the sum of its segments. */
export function dailyBuckets(daily: DailyData, count = 30): ChartBucket[] {
  return daily.buckets.slice(-count).map((b) => {
    const values = Object.fromEntries(
      Object.entries(b.categories).filter(([name]) => !CHART_EXCLUDED_CATEGORIES.has(name)),
    );
    return {
      key: b.date,
      label: dayLabelOf(b.date),
      short: String(Number(b.date.slice(8, 10))),
      total: Object.values(values).reduce((s, v) => s + v, 0),
      values,
    };
  });
}

/* ---------------- Presets + comparison ---------------- */

/** The buckets a preset renders (1Y is the trailing 12 months made
 * cumulative; All is the whole history by quarter). */
export function presetBuckets(
  preset: ChartPreset,
  monthly: MonthlyRows,
  daily: DailyData | null,
): ChartBucket[] {
  switch (preset) {
    case "daily":
      return daily ? dailyBuckets(daily, 30) : [];
    case "monthly":
      return monthlyBuckets(monthly, 12);
    case "quarterly":
      return quarterlyBuckets(monthly, 12);
    case "ytd":
      return ytdBuckets(monthly);
    case "oneyear":
      return cumulativeBuckets(monthlyBuckets(monthly, 12));
    case "all":
      return quarterlyBuckets(monthly, null);
  }
}

function totalsByCategory(buckets: ChartBucket[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const b of buckets) {
    for (const [cat, v] of Object.entries(b.values)) {
      totals.set(cat, (totals.get(cat) ?? 0) + v);
    }
  }
  return totals;
}

/**
 * The one-line control read under a chart: the biggest riser vs the
 * previous equivalent period, or the biggest faller when nothing rose.
 * Returns null when the comparison window is not fully covered by the
 * data or the biggest move is under £1 — an omitted line, never an
 * invented one.
 */
export function comparisonText(
  current: ChartBucket[],
  previous: ChartBucket[] | null,
  phrase: string,
): string | null {
  if (!previous || previous.length === 0 || current.length === 0) return null;
  const cur = totalsByCategory(current);
  const prev = totalsByCategory(previous);
  const names = [...new Set([...cur.keys(), ...prev.keys()])].sort(
    (a, b) => (cur.get(b) ?? 0) - (cur.get(a) ?? 0),
  );
  let riser: { name: string; delta: number } | null = null;
  let faller: { name: string; delta: number } | null = null;
  for (const name of names) {
    const delta = (cur.get(name) ?? 0) - (prev.get(name) ?? 0);
    if (delta > 0 && (!riser || delta > riser.delta)) riser = { name, delta };
    if (delta < 0 && (!faller || delta < faller.delta)) faller = { name, delta };
  }
  // Whole pounds: the line is a headline ("Groceries up £84 vs
  // previous 30 days"); the chart itself carries the exact figures.
  if (riser && riser.delta >= 1) {
    return `${riser.name} up ${gbp(riser.delta, false)} vs ${phrase}`;
  }
  if (faller && faller.delta <= -1) {
    return `${faller.name} down ${gbp(-faller.delta, false)} vs ${phrase}`;
  }
  return null;
}

/** The comparison line for a preset, with each preset's own previous
 * equivalent period. Coverage is strict: the previous window must lie
 * fully inside the data (for quarters, its first quarter must be a
 * complete calendar quarter), else the line is omitted. */
export function presetComparison(
  preset: ChartPreset,
  monthly: MonthlyRows,
  daily: DailyData | null,
): string | null {
  if (preset === "daily") {
    if (!daily || !daily.dataStart || daily.buckets.length < 60) return null;
    const prev = dailyBuckets({ ...daily, buckets: daily.buckets.slice(0, -30) }, 30);
    if (prev.length < 30 || prev[0]!.key < daily.dataStart) return null;
    return comparisonText(dailyBuckets(daily, 30), prev, "previous 30 days");
  }
  if (preset === "quarterly") {
    const quarters = quarterlyBuckets(monthly, null);
    if (quarters.length < 24) return null;
    const prev = quarters.slice(-24, -12);
    if (prev[0]!.partial) return null;
    return comparisonText(quarters.slice(-12), prev, "previous 12 quarters");
  }
  if (preset === "ytd") {
    const cur = ytdBuckets(monthly);
    const latest = monthly.months[monthly.months.length - 1];
    if (!latest || cur.length === 0) return null;
    const prevYear = String(Number(latest.slice(0, 4)) - 1);
    const prevKeys = cur.map((b) => `${prevYear}${b.key.slice(4)}`);
    if (!monthly.months.includes(prevKeys[0]!)) return null;
    return comparisonText(cur, bucketsFromMonths(monthly, prevKeys), "the same months last year");
  }
  // monthly, oneyear and all compare the trailing 12 months with the
  // 12 before them (for the cumulative and all-history views that is
  // the year-over-year read their shapes call for).
  if (monthly.months.length < 24) return null;
  const cur = monthlyBuckets(monthly, 12);
  const prev = bucketsFromMonths(monthly, monthly.months.slice(-24, -12));
  const phrase = preset === "monthly" ? "previous 12 months" : "the year before";
  return comparisonText(cur, prev, phrase);
}
