import { useEffect, useState } from "react";
import { categoryColor, gbp } from "@/lib/data";
import { categoryTotals, type ChartBucket } from "@/lib/timeline";

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
  const padL = 48;
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

        {/* Active bucket highlight, behind the data. */}
        <rect
          x={padL + slot * activeIdx}
          y={padT}
          width={slot}
          height={plotH}
          fill="var(--accent)"
          opacity={0.4}
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
                className="fill-muted-foreground"
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
