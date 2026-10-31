import { useEffect, useMemo, useState } from "react";
import { categoryColor, gbp, type Person } from "@/lib/data";
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
 * "Current" is anchored to the data's latest month throughout.
 */
export function SpendTimelineSection({
  title,
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
  const [preset, setPreset] = useState<ChartPreset>(
    presetIds.includes("monthly") ? "monthly" : (presetIds[0] ?? "monthly"),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [daily, setDaily] = useState<{ person: Person; data: DailyData } | null>(null);
  const [dailyFailed, setDailyFailed] = useState(false);

  useEffect(() => {
    setSelected(null);
  }, [monthly]);

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
        <div className="flex flex-wrap gap-0.5 rounded-full bg-muted p-0.5" role="group" aria-label="Chart period">
          {CHART_PRESETS.filter((p) => presetIds.includes(p.id)).map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={preset === p.id}
              onClick={() => setPreset(p.id)}
              className={`rounded-full px-2.5 py-1 text-caption ${preset === p.id ? "bg-card font-medium shadow-sm" : "text-muted-foreground"}`}
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

const W = 720;

function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * pow;
}

export function SpendChart({
  buckets,
  selected,
  onSelect,
  cumulative = false,
  compact = false,
  seriesName,
}: SpendChartProps) {
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    setActive(null);
  }, [buckets]);

  if (buckets.length === 0) return null;

  const legendTotals = cumulative
    ? Object.entries(buckets[buckets.length - 1]!.values)
        .map(([name, total]) => ({ name, total }))
        .filter((t) => t.total > 0)
        .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
    : categoryTotals(buckets);
  const categories = legendTotals.map((t) => t.name);
  const shown = selected && categories.includes(selected) ? selected : null;

  const activeIdx =
    active !== null && active < buckets.length ? active : buckets.length - 1;
  const activeBucket = buckets[activeIdx]!;

  const H = compact ? 176 : 248;
  // Wide enough for a full "£20,000" tick label at 11px: at 48 the
  // leftmost glyphs fell outside the viewBox and rendered clipped
  // (":20,000").
  const padL = 58;
  const padR = 6;
  const padT = 10;
  const padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const maxValue = Math.max(
    0,
    ...buckets.map((b) => (shown ? (b.values[shown] ?? 0) : b.total)),
  );
  const yMax = niceCeil(maxValue);
  const y = (v: number) => padT + plotH - (v / yMax) * plotH;
  const slot = plotW / buckets.length;
  const barW = Math.min(slot * 0.72, compact ? 30 : 44);
  const labelStep = Math.ceil(buckets.length / (compact ? 6 : 9));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);

  const colourOf = (name: string) =>
    seriesName && name === categories[0] && categories.length === 1
      ? "var(--color-primary)"
      : categoryColor(name);

  const summary = shown
    ? `${shown} spending over time. Highest: ${gbp(Math.max(0, ...buckets.map((b) => b.values[shown] ?? 0)))}.`
    : `Total spending over time. Highest period: ${gbp(Math.max(0, ...buckets.map((b) => b.total)))}.`;

  return (
    <div>
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
                {gbp(t, false)}
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
          buckets.map((b, i) => {
            const x = padL + slot * i + (slot - barW) / 2;
            let cursor = 0;
            const segments = shown
              ? [{ name: shown, v: b.values[shown] ?? 0 }]
              : categories.map((name) => ({ name, v: b.values[name] ?? 0 }));
            return (
              <g key={b.key}>
                {segments.map((s) => {
                  if (s.v <= 0) return null;
                  const yTop = y(cursor + s.v);
                  const height = y(cursor) - yTop;
                  cursor += s.v;
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
            const topPts = buckets.map((b, i) => {
              const base = below.reduce((s, c) => s + (b.values[c] ?? 0), 0);
              const cx = padL + slot * (i + 0.5);
              return `${cx},${y(base + (b.values[name] ?? 0))}`;
            });
            const bottomPts = buckets
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

        {buckets.map((b, i) => (
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
            {(i % labelStep === 0 || i === buckets.length - 1) && (
              <text
                x={padL + slot * (i + 0.5)}
                y={H - 6}
                textAnchor="middle"
                fontSize={11}
                fontWeight={i === buckets.length - 1 ? 700 : undefined}
                className={i === buckets.length - 1 ? "fill-foreground" : "fill-muted-foreground"}
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

      <div className="mt-3 flex flex-wrap gap-1.5">
        {legendTotals.map((t) => {
          const isShown = shown === t.name;
          return (
            <button
              key={t.name}
              type="button"
              aria-pressed={isShown}
              onClick={() => onSelect(isShown ? null : t.name)}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-caption ${
                isShown ? "border-foreground font-medium" : ""
              } ${shown && !isShown ? "opacity-50" : ""}`}
            >
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
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
