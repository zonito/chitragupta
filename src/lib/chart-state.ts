import type { ChartPreset } from "./timeline";

/**
 * Persisted interactive state for the shared spend chart (chosen
 * preset + isolated category), one localStorage key PER SURFACE so
 * Categories, Home and Subscriptions each remember their own last
 * view. Follows the app's persisted-preference pattern (theme,
 * calculators): the component restores after mount and saves only
 * after restoration, so SSR and first paint always show the defaults
 * and never mismatch. This lib owns the parse/validate maths so it is
 * testable without rendering.
 */

export type ChartSurface = "categories" | "home" | "subscriptions";

export const chartStateKey = (surface: ChartSurface): string =>
  `chitragupta.chart.${surface}`;

export interface ChartState {
  preset: ChartPreset;
  selected: string | null;
}

/**
 * Validate a stored state against what the surface can show NOW:
 * the preset must be one the surface offers, and the isolated
 * category must be present in that preset's current legend (via
 * `legendFor`, computed by the caller from current data). Each piece
 * falls back independently — a stale category drops the isolation
 * but keeps a valid preset; a stale preset drops to the surface
 * default with no isolation.
 */
export function restoreChartState(
  raw: string | null,
  validPresets: ChartPreset[],
  fallbackPreset: ChartPreset,
  legendFor: (preset: ChartPreset) => string[],
): ChartState {
  const fallback: ChartState = { preset: fallbackPreset, selected: null };
  if (!raw) return fallback;
  let parsed: Partial<ChartState>;
  try {
    parsed = JSON.parse(raw) as Partial<ChartState>;
  } catch {
    return fallback;
  }
  const preset =
    typeof parsed.preset === "string" &&
    validPresets.includes(parsed.preset as ChartPreset)
      ? (parsed.preset as ChartPreset)
      : fallbackPreset;
  const selected =
    preset === parsed.preset &&
    typeof parsed.selected === "string" &&
    legendFor(preset).includes(parsed.selected)
      ? parsed.selected
      : null;
  return { preset, selected };
}

export function serializeChartState(state: ChartState): string {
  return JSON.stringify(state);
}
