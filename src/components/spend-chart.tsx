import { useEffect, useMemo, useRef, useState } from "react";
import { categoryColor, gbp, gbpCompact, type Person } from "@/lib/data";
import { Label, Panel } from "@/components/shell";
import {
  categoryTotals,
  CHART_PRESETS,
  fetchDaily,
  presetBuckets,
  presetComparison,
  type ChartBucket,
  type ChartPreset,
  type DailyData,
  type MonthlyRows,
} from "@/lib/timeline";
import {
  chartStateKey,
  restoreChartState,
  serializeChartState,
  type ChartSurface,
} from "@/lib/chart-state";

/**
 * The shared spending-over-time chart (Categories timeline, Home trend,
 * Subscriptions trend): stacked bars per period bucket, one segment per
 * category in its CATEGORY_COLOR token colour, or a stacked area when
 * the buckets are cumulative (the 1Y pace view). Tapping a legend entry
 * isolates that category (tap again to return); tapping a bucket pins
 * its readout under the chart, so every bucket's total — and its split
 * — is readable in text, never colour alone. The legend always carries
 * names + totals in text (WCAG AA), in both themes.
 */

export interface SpendTimelineSectionProps {
  title: string;
  /** Which screen this is: the chart's interactive state (preset +
   * isolated category) persists per surface in localStorage. */
  surface: ChartSurface;
  /** Monthly series the monthly-family presets bucket (snapshot
   * monthly history for Categories/Home; subscription charge months
   * for Subscriptions). */
  monthly: MonthlyRows;
  /** Enables the Daily preset, fetched for this person. Omit on
   * surfaces whose data has no day level (Subscriptions) — the Daily
   * button is then dropped rather than shown empty. */
  dailyPerson?: Person;
  /** Preset subset; default is every preset the data supports. */
  presets?: ChartPreset[];
  compact?: boolean;
  seriesName?: string;
  caption?: string;
  className?: string;
}

/**
 * The chart section shared by Categories, Home and Subscriptions: the
 * preset control, the SpendChart, and the one-line comparison read.
 * Monthly-family presets bucket `monthly` locally (no fetch); only the
 * Daily preset fetches, lazily, the first time it is chosen — 60 days,
 * so the comparison line reads the previous 30 from the same response.
 * "Current" is anchored to the display month throughout (the
 * monthly history's last month).
 */
export function SpendTimelineSection({
  title,
  surface,
  monthly,
  dailyPerson,
  presets,
  compact = false,
  seriesName,
  caption,
  className,
}: SpendTimelineSectionProps) {
  const presetIds = (presets ?? CHART_PRESETS.map((p) => p.id)).filter(
    (id) => id !== "daily" || dailyPerson !== undefined,
  );
  const defaultPreset: ChartPreset = presetIds.includes("monthly")
    ? "monthly"
    : (presetIds[0] ?? "monthly");
  const [preset, setPreset] = useState<ChartPreset>(defaultPreset);
  const [selected, setSelected] = useState<string | null>(null);
  const [daily, setDaily] = useState<{ person: Person; data: DailyData } | null>(null);
  const [dailyFailed, setDailyFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setSelected(null);
  }, [monthly]);

  // Restore this surface's saved chart state after mount (the theme /
  // calculators pattern: SSR and first paint render the defaults, so
  // nothing mismatches; saving is gated on `loaded` so the defaults
  // never overwrite the stored state before it is read). A stored
  // value is restored only when still valid against current data:
  // the preset must exist on this surface and the isolated category
  // must be in that preset's current legend. For Daily the day
  // buckets are a subset of the all-history categories, which is the
  // legend proxy (SpendChart also guards at render).
  useEffect(() => {
    try {
      const restored = restoreChartState(
        localStorage.getItem(chartStateKey(surface)),
        presetIds,
        defaultPreset,
        (p) =>
          categoryTotals(
            presetBuckets(p === "daily" ? "all" : p, monthly, null),
          ).map((t) => t.name),
      );
      setPreset(restored.preset);
      setSelected(restored.selected);
    } catch {
      /* Storage is optional: defaults stand. */
    }
    setLoaded(true);
    // Mount-only: presetIds/monthly are the mount-time surface shape.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(
        chartStateKey(surface),
        serializeChartState({ preset, selected }),
      );
    } catch {
      /* Storage is optional. */
    }
  }, [loaded, preset, selected, surface]);

  useEffect(() => {
    if (preset !== "daily" || !dailyPerson || daily?.person === dailyPerson || dailyFailed) return;
    let cancelled = false;
    fetchDaily(dailyPerson, 60)
      .then((data) => {
        if (!cancelled) setDaily({ person: dailyPerson, data });
      })
      .catch(() => {
        if (!cancelled) setDailyFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [preset, dailyPerson, daily, dailyFailed]);

  const dailyData = dailyPerson && daily?.person === dailyPerson ? daily.data : null;
  const buckets = useMemo(
    () => presetBuckets(preset, monthly, dailyData),
    [preset, monthly, dailyData],
  );
  const comparison = useMemo(
    () => presetComparison(preset, monthly, dailyData),
    [preset, monthly, dailyData],
  );
  const dailyPending = preset === "daily" && !dailyData && !dailyFailed;

  return (
    <Panel {...(className ? { className } : {})}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label>{title}</Label>
        {/* One tidy segmented line at every width: the six presets
            never wrap into a blob — if a very narrow screen cannot
            fit them, the row scrolls with no visible scrollbar (the
            app's no-scrollbar utility, as on the Activity filters). */}
        <div className="no-scrollbar flex flex-nowrap gap-0.5 overflow-x-auto rounded-full bg-muted p-0.5" role="group" aria-label="Chart period">
          {CHART_PRESETS.filter((p) => presetIds.includes(p.id)).map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={preset === p.id}
              onClick={() => setPreset(p.id)}
              className={`shrink-0 whitespace-nowrap rounded-full px-2 py-1 text-caption ${preset === p.id ? "bg-card font-medium shadow-sm" : "text-muted-foreground"}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {monthly.months.length === 0 ? (
        <p className="mt-3 text-body text-muted-foreground">
          Not enough history yet — the chart appears once statements cover a few months.
        </p>
      ) : dailyPending ? (
        <p className="mt-3 text-body text-muted-foreground">Loading…</p>
      ) : preset === "daily" && dailyFailed ? (
        <p className="mt-3 text-body text-muted-foreground">Could not load daily spending just now.</p>
      ) : (
        <>
          <div className="mt-3">
            <SpendChart
              buckets={buckets}
              selected={selected}
              onSelect={setSelected}
              cumulative={preset === "oneyear"}
              compact={compact}
              {...(seriesName ? { seriesName } : {})}
            />
          </div>
          {comparison && <p className="num mt-3 text-body">{comparison}</p>}
          {caption && (
            <p className="mt-2 text-caption text-muted-foreground">{caption}</p>
          )}
        </>
      )}
    </Panel>
  );
}

export interface SpendChartProps {
  buckets: ChartBucket[];
  selected: string | null;
  onSelect: (category: string | null) => void;
  /** Buckets carry running totals: render stacked areas, and the
   * legend total for a category is its final cumulative value. */
  cumulative?: boolean;
  compact?: boolean;
  /** Legend name override for single-series charts (e.g. the
   * Subscriptions trend, whose one series is not a category). */
  seriesName?: string;
}

function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * pow;
}

/**
 * Narrow-width display merging: consecutive buckets grouped so the
 * bars keep a legible width on a phone (30 hairline day bars become
 * ~15 two-day bars). Totals and per-category values are preserved
 * exactly — groups sum — so the legend, readout and aria summary
 * state the same figures as the unmerged chart; only the label
 * spans the group ("28 Oct 2026 – 29 Oct 2026", axis "28–29"). For
 * cumulative buckets the group's value is its last bucket's running
 * total, which is what the area at that point already reads.
 */
function mergeBuckets(
  buckets: ChartBucket[],
  maxCount: number,
  cumulative: boolean,
): ChartBucket[] {
  if (buckets.length <= maxCount) return buckets;
  const size = Math.ceil(buckets.length / maxCount);
  const out: ChartBucket[] = [];
  for (let i = 0; i < buckets.length; i += size) {
    const group = buckets.slice(i, i + size);
    const first = group[0]!;
    const last = group[group.length - 1]!;
    if (group.length === 1) {
      out.push(first);
      continue;
    }
    const values: Record<string, number> = {};
    if (cumulative) {
      Object.assign(values, last.values);
    } else {
      for (const b of group) {
        for (const [name, v] of Object.entries(b.values)) {
          values[name] = (values[name] ?? 0) + v;
        }
      }
    }
    out.push({
      key: `${first.key}~${last.key}`,
      label: first.label === last.label ? first.label : `${first.label} – ${last.label}`,
      short: first.short === last.short ? first.short : `${first.short}–${last.short}`,
      total: cumulative ? last.total : group.reduce((s, b) => s + b.total, 0),
      values,
      ...(last.partial ? { partial: true } : {}),
    });
  }
  return out;
}

/** Below this rendered width the chart switches to its narrow
 * rendering (see SpendChart). */
const NARROW_MAX = 560;

export function SpendChart({
  buckets,
  selected,
  onSelect,
  cumulative = false,
  compact = false,
  seriesName,
}: SpendChartProps) {
  const [active, setActive] = useState<number | null>(null);
  // The chart's own rendered width, measured after mount (the chart
  // state pattern: SSR and first paint use the desktop geometry, so
  // nothing mismatches; environments without ResizeObserver — tests
  // included — keep the desktop rendering). Width, not viewport, is
  // the signal: it is the bar slots' real size that decides legibility.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Narrow rendering (phones): the viewBox becomes the true pixel
  // width so text renders at its real size instead of being halved
  // by the 720-wide scale-down, dense bucket runs are merged into
  // legible bars (mergeBuckets), tick labels go compact (£5k), and
  // a lone outlier is capped (below) so ordinary periods stay
  // visible. Desktop geometry and figures are untouched.
  const narrow = width !== null && width < NARROW_MAX;
  const W = narrow ? Math.max(Math.round(width), 280) : 720;
  // Desktop padL 58 is wide enough for a full "£20,000" tick label
  // at 11px: at 48 the leftmost glyphs fell outside the viewBox and
  // rendered clipped (":20,000"). Narrow labels are compact (£20k),
  // so 42 suffices there.
  const padL = narrow ? 42 : 58;
  const padR = 6;
  const view = useMemo(() => {
    if (!narrow) return buckets;
    const target = Math.max(6, Math.floor((W - padL - padR) / 20));
    return mergeBuckets(buckets, target, cumulative);
  }, [buckets, narrow, cumulative, W, padL]);

  useEffect(() => {
    setActive(null);
  }, [view]);

  if (buckets.length === 0) return null;

  const legendTotals = cumulative
    ? Object.entries(view[view.length - 1]!.values)
        .map(([name, total]) => ({ name, total }))
        .filter((t) => t.total > 0)
        .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
    : categoryTotals(view);
  const categories = legendTotals.map((t) => t.name);
  const shown = selected && categories.includes(selected) ? selected : null;

  const activeIdx =
    active !== null && active < view.length ? active : view.length - 1;
  const activeBucket = view[activeIdx]!;

  const H = compact ? 176 : 248;
  const padB = 22;
  const plottedOf = (b: ChartBucket) => (shown ? (b.values[shown] ?? 0) : b.total);
  const maxValue = Math.max(0, ...view.map(plottedOf));
  // Outlier cap, narrow only: when one bucket towers over the rest
  // (a £3.9k mortgage day among £50 days), the axis stops just above
  // the second-largest bucket and the tower is drawn to the cap with
  // its stack's proportions preserved, break marks across its top
  // and its exact total labelled above it — the same figure its
  // <title> and the readout line carry. Ordinary bars keep a linear,
  // honest scale; nothing is hidden, the axis simply declines to
  // flatten everything else for one day.
  const descending = view
    .map(plottedOf)
    .filter((v) => v > 0)
    .sort((a, b) => b - a);
  let cap = Number.POSITIVE_INFINITY;
  if (narrow && !cumulative && descending.length >= 2 && descending[0]! > 2.5 * descending[1]!) {
    cap = niceCeil(descending[1]! * 1.2);
  }
  const yMax = Math.min(niceCeil(maxValue), cap);
  const clipped = maxValue > yMax;
  // Room above the plot for a clipped bar's value label.
  const padT = clipped ? 24 : 10;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const y = (v: number) => padT + plotH - (v / yMax) * plotH;
  const slot = plotW / view.length;
  const barW = Math.min(slot * 0.72, compact ? 30 : 44);
  const labelStep = Math.ceil(view.length / (compact ? 6 : 9));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const tickLabel = (t: number) => (narrow ? gbpCompact(t) : gbp(t, false));

  const colourOf = (name: string) =>
    seriesName && name === categories[0] && categories.length === 1
      ? "var(--color-primary)"
      : categoryColor(name);

  const summary = shown
    ? `${shown} spending over time. Highest: ${gbp(Math.max(0, ...view.map((b) => b.values[shown] ?? 0)))}.`
    : `Total spending over time. Highest period: ${gbp(Math.max(0, ...view.map((b) => b.total)))}.`;

  return (
    <div ref={wrapRef}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={summary}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={padL}
              x2={W - padR}
              y1={y(t)}
              y2={y(t)}
              className="stroke-border"
              strokeWidth={1}
              strokeDasharray={t === 0 ? undefined : "3 4"}
            />
            {t > 0 && (
              <text
                x={padL - 6}
                y={y(t) + 4}
                textAnchor="end"
                fontSize={11}
                className="num fill-muted-foreground"
              >
                {tickLabel(t)}
              </text>
            )}
          </g>
        ))}

        {/* Active bucket highlight, behind the data: a FAINT tint —
            at 0.4 the saturated band drowned the current month's bar;
            the current period is carried by its bold axis label. */}
        <rect
          x={padL + slot * activeIdx}
          y={padT}
          width={slot}
          height={plotH}
          fill="var(--accent)"
          opacity={0.12}
        />

        {!cumulative &&
          view.map((b, i) => {
            const x = padL + slot * i + (slot - barW) / 2;
            // A clipped (capped) bar: its stack is scaled to the cap
            // with segment proportions preserved.
            const plotted = plottedOf(b);
            const scale = plotted > yMax ? yMax / plotted : 1;
            let cursor = 0;
            const segments = shown
              ? [{ name: shown, v: b.values[shown] ?? 0 }]
              : categories.map((name) => ({ name, v: b.values[name] ?? 0 }));
            return (
              <g key={b.key}>
                {segments.map((s) => {
                  if (s.v <= 0) return null;
                  const sv = s.v * scale;
                  const yTop = y(cursor + sv);
                  const height = y(cursor) - yTop;
                  cursor += sv;
                  return (
                    <rect
                      key={s.name}
                      x={x}
                      y={yTop}
                      width={barW}
                      height={height}
                      fill={colourOf(s.name)}
                    />
                  );
                })}
                {scale < 1 && (
                  <>
                    {/* Axis-break marks across the bar's top, and the
                        bar's exact total above it (also in its
                        <title> and the readout line). */}
                    <line
                      x1={x + 1.5}
                      y1={y(yMax) + 7}
                      x2={x + barW - 1.5}
                      y2={y(yMax) + 2.5}
                      stroke="var(--background)"
                      strokeWidth={2}
                    />
                    <line
                      x1={x + 1.5}
                      y1={y(yMax) + 11.5}
                      x2={x + barW - 1.5}
                      y2={y(yMax) + 7}
                      stroke="var(--background)"
                      strokeWidth={2}
                    />
                    <text
                      x={Math.min(Math.max(x + barW / 2, padL + 26), W - padR - 26)}
                      y={padT - 8}
                      textAnchor="middle"
                      fontSize={10}
                      fontWeight={600}
                      className="num fill-foreground"
                    >
                      {gbp(plotted)}
                    </text>
                  </>
                )}
              </g>
            );
          })}

        {cumulative &&
          (shown ? [shown] : [...categories].reverse()).map((name) => {
            // Stacked area: this category's band sits on the cumulative
            // sum of the categories below it (legend order, biggest at
            // the bottom). A single shown category sits on zero.
            const below = shown
              ? categories.slice(0, 0)
              : categories.slice(0, categories.indexOf(name));
            const topPts = view.map((b, i) => {
              const base = below.reduce((s, c) => s + (b.values[c] ?? 0), 0);
              const cx = padL + slot * (i + 0.5);
              return `${cx},${y(base + (b.values[name] ?? 0))}`;
            });
            const bottomPts = view
              .map((b, i) => {
                const base = below.reduce((s, c) => s + (b.values[c] ?? 0), 0);
                const cx = padL + slot * (i + 0.5);
                return `${cx},${y(base)}`;
              })
              .reverse();
            return (
              <polygon
                key={name}
                points={[...topPts, ...bottomPts].join(" ")}
                fill={colourOf(name)}
                opacity={0.85}
              />
            );
          })}

        {view.map((b, i) => (
          <g key={`hit-${b.key}`}>
            <rect
              x={padL + slot * i}
              y={padT}
              width={slot}
              height={plotH}
              fill="transparent"
              className="cursor-pointer"
              onClick={() => setActive(i)}
            >
              <title>
                {b.label}: {gbp(shown ? (b.values[shown] ?? 0) : b.total)}
                {shown ? ` (${shown})` : cumulative ? " so far" : ""}
              </title>
            </rect>
            {(i % labelStep === 0 || i === view.length - 1) && (
              <text
                x={padL + slot * (i + 0.5)}
                y={H - 6}
                textAnchor="middle"
                fontSize={11}
                fontWeight={i === view.length - 1 ? 700 : undefined}
                className={i === view.length - 1 ? "fill-foreground" : "fill-muted-foreground"}
              >
                {b.short}
              </text>
            )}
          </g>
        ))}
      </svg>

      <p className="num mt-1 text-caption text-muted-foreground" aria-live="polite">
        {activeBucket.label} — {gbp(shown ? (activeBucket.values[shown] ?? 0) : activeBucket.total)}
        {shown
          ? ` on ${shown}`
          : cumulative
            ? " spent so far"
            : activeBucket.total > 0
              ? `: ${categories
                  .filter((c) => (activeBucket.values[c] ?? 0) > 0)
                  .slice(0, 3)
                  .map((c) => `${seriesName && categories.length === 1 ? seriesName : c} ${gbp(activeBucket.values[c]!)}`)
                  .join(" · ")}`
              : ""}
      </p>

      <div className="mt-3 flex flex-wrap gap-1">
        {legendTotals.map((t) => {
          const isShown = shown === t.name;
          return (
            <button
              key={t.name}
              type="button"
              aria-pressed={isShown}
              onClick={() => onSelect(isShown ? null : t.name)}
              className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-micro ${
                isShown ? "border-foreground font-medium" : ""
              } ${shown && !isShown ? "opacity-50" : ""}`}
            >
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-sm"
                style={{ background: colourOf(t.name) }}
              />
              {/* Name + total as ONE text node: the Categories list
                  below carries the same category names as tile text,
                  and the two must stay distinguishable to text queries. */}
              <span className="num">
                {`${seriesName && categories.length === 1 ? seriesName : t.name} · ${gbp(t.total)}`}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
