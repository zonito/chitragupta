/**
 * Activity period presets: ranges anchored to the store's latest
 * data month (never the wall clock, so fixtures and quiet weeks
 * behave). A preset resolves to an inclusive month range; the server
 * expresses it with from/to month params and the client merges the
 * fetched months with any snapshot months inside the range,
 * fingerprint-keyed, so overlaps never duplicate.
 */

export type PeriodPreset = "quarter" | "ytd" | "last12";

export const PERIOD_PRESETS: { id: PeriodPreset; label: string }[] = [
  { id: "quarter", label: "This quarter" },
  { id: "ytd", label: "Year to date" },
  { id: "last12", label: "Last 12 months" },
];

const PRESET_IDS: ReadonlySet<string> = new Set(PERIOD_PRESETS.map((p) => p.id));

/** Select value for a preset ("preset:last12"), distinct from month keys. */
export const presetValue = (id: PeriodPreset): string => `preset:${id}`;

export function parsePreset(value: string): PeriodPreset | null {
  if (!value.startsWith("preset:")) return null;
  const id = value.slice("preset:".length);
  return PRESET_IDS.has(id) ? (id as PeriodPreset) : null;
}

const fmt = (year: number, month: number): string =>
  `${year}-${String(month).padStart(2, "0")}`;

/** Absolute month index (year * 12 + month - 1) for range arithmetic. */
const toIndex = (key: string): number => {
  const [y, m] = key.split("-").map(Number);
  return (y ?? 0) * 12 + ((m ?? 1) - 1);
};
const fromIndex = (index: number): string =>
  fmt(Math.floor(index / 12), (index % 12) + 1);

/** Every month key from `from` to `to`, inclusive, ascending. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let i = toIndex(from); i <= toIndex(to); i++) out.push(fromIndex(i));
  return out;
}

export interface PeriodRange {
  from: string;
  to: string;
  months: string[];
}

/**
 * The month range a preset covers when anchored at `anchor` (the
 * store's latest data month, YYYY-MM):
 * - quarter: the calendar quarter containing the anchor, from its
 *   first month to the anchor (Oct 2026 → Oct only, the quarter so far)
 * - ytd: January of the anchor's year to the anchor
 * - last12: the trailing 12 months including the anchor
 * Short histories simply yield the months that exist; the caller
 * lists whatever the range returns.
 */
export function rangeForPreset(preset: PeriodPreset, anchor: string): PeriodRange {
  const [year, month] = anchor.split("-").map(Number);
  const y = year ?? 2026;
  const m = month ?? 1;
  let from: string;
  if (preset === "ytd") {
    from = fmt(y, 1);
  } else if (preset === "quarter") {
    from = fmt(y, m - ((m - 1) % 3));
  } else {
    from = fromIndex(toIndex(anchor) - 11);
  }
  return { from, to: anchor, months: monthsBetween(from, anchor) };
}
