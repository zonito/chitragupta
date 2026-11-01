import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { usePerson, Panel, Label, Sheet, Chip, meta } from "@/components/shell";
import {
  spendTotal,
  typicalTotal,
  biggestChanges,
  asideTotal,
  coachNote,
  currentMonthKey,
  currentMonthName,
  nextMonthName,
  gbp,
  gbpCompact,
  TXNS,
  ALL_TXNS,
  upcomingPanel,
  upcomingShare,
  upcomingDateLabel,
  incomeFor,
  incomeTotal,
  ownerName,
  personLabel,
  categoryColor,
  availableFor,
  appSettings,
  formatMoney,
  dateLabel,
  monthlyHistoryFor,
  flowWindowFor,
  type IncomeEntry,
  type Person,
} from "@/lib/data";
import { smallSpendFact } from "@/lib/calculators";
import { AnimatedBar, CountUpMoney } from "@/components/motion";
import { AccountTile } from "@/components/tiles";
import { SpendTimelineSection } from "@/components/spend-chart";
import { fetchJevCoachOpinion, type JevOpinion } from "@/lib/jev-client";
import {
  forecastFor,
  forecastIsStale,
  type MonthForecast,
} from "@/lib/forecast";

export const Route = createFileRoute("/")({
  head: () =>
    meta(
      "This month",
      "This month at a glance for Zonito and Nikhila: spending, usual month, and a calm coach note.",
    ),
  component: Index,
});

/**
 * React key for a "Money in" row. Every income entry shares owner
 * values (all of Zonito's rows are "zonito"), so owner alone collides;
 * the entry's own label (salary or merchant) plus its date — with the
 * owner kept in — is unique per entry.
 */
export const incomeEntryKey = (entry: IncomeEntry): string =>
  `${entry.type}|${entry.day}|${entry.owner}`;

/**
 * Home "Available" card: the total balance across the current view's
 * accounts (household = everyone's, Joint included; a person's view =
 * their own accounts only), from the balances the latest real ingest
 * runs recorded. Tapping opens the per-account breakdown sheet, so a
 * big planned spend can be checked against what each account holds.
 * With no recorded balance at all the card says so honestly instead
 * of showing a fabricated £0.
 */
/** A threshold figure with pence only when it has them (£11,000 /
 * £10,306.75): a floor the user typed is quoted back exactly. */
const gbpTrim = (n: number) => gbp(n, n % 1 !== 0);

/** The Available floor state for one view: the configured floor (in
 * pounds) and whether the view's GBP headline sits below it. Null
 * floor = no signal anywhere. The comparison uses the very number the
 * card displays, so what you see is what is judged. */
export function floorState(
  person: Person,
): { floor: number; below: boolean } | null {
  const { availableFloorMinor } = appSettings();
  if (availableFloorMinor === null) return null;
  const total = availableFor(person).gbpTotal;
  if (total === null) return null;
  const floor = availableFloorMinor / 100;
  return { floor, below: total < floor };
}

export function AvailableCard({
  person,
  onOpen,
  className,
}: {
  person: Person;
  onOpen: () => void;
  className?: string;
}) {
  const avail = availableFor(person);
  if (avail.gbpTotal === null) {
    return (
      <Panel {...(className ? { className } : {})}>
        <Label>Available</Label>
        <p className="text-body leading-relaxed text-muted-foreground">
          No balances recorded yet — they appear here once a statement import
          records them.
        </p>
      </Panel>
    );
  }
  const known = avail.accounts.filter((a) => a.balanceMinor !== null).length;
  const floor = floorState(person);
  return (
    <Panel {...(className ? { className } : {})}>
      <button
        type="button"
        onClick={onOpen}
        aria-label="Available balance, show breakdown by account"
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <div className="min-w-0">
          <Label>Available</Label>
          <div
            className={`num text-title font-semibold${floor?.below ? " text-destructive" : ""}`}
          >
            <CountUpMoney value={avail.gbpTotal} pence />
          </div>
          {avail.foreign.length > 0 && (
            <p className="num mt-1 text-caption text-muted-foreground">
              plus{" "}
              {avail.foreign
                .map((f) => formatMoney(f.total, f.currency))
                .join(" · ")}{" "}
              in other currencies
            </p>
          )}
          {floor !== null &&
            (floor.below ? (
              <p className="num mt-1 text-caption font-medium text-destructive">
                Below your {gbpTrim(floor.floor)} floor
              </p>
            ) : (
              <p className="num mt-1 text-caption text-muted-foreground">
                Floor {gbpTrim(floor.floor)}
              </p>
            ))}
          <p className="mt-1 text-caption text-muted-foreground">
            Across {known} account{known === 1 ? "" : "s"} · Latest balances ·{" "}
            {dateLabel(avail.asOf)}
          </p>
        </div>
        <ChevronRight
          className="h-5 w-5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
      </button>
    </Panel>
  );
}

/** The breakdown sheet behind the Available card: every account in the
 *  view with its own balance (foreign money in its own currency, never
 *  converted), its owner and its last statement date. */
export function AvailableBreakdown({ person }: { person: Person }) {
  const avail = availableFor(person);
  const floor = floorState(person);
  return (
    <div>
      <div className="text-body text-muted-foreground">Available</div>
      <div
        className={`num mb-1 text-title font-semibold${floor?.below ? " text-destructive" : ""}`}
      >
        {avail.gbpTotal !== null ? gbp(avail.gbpTotal) : "—"}
      </div>
      {floor !== null &&
        (floor.below ? (
          <p className="num mb-1 text-caption font-medium text-destructive">
            Below your {gbpTrim(floor.floor)} floor
          </p>
        ) : (
          <p className="num mb-1 text-caption text-muted-foreground">
            Floor {gbpTrim(floor.floor)}
          </p>
        ))}
      <p className="mb-5 text-caption text-muted-foreground">
        {person === "household"
          ? "Every account — yours, Nikhila's and Joint"
          : `${ownerName(person as "zonito" | "nikhila")}'s own accounts`}
        {avail.asOf ? ` · Latest balances · ${dateLabel(avail.asOf)}` : ""}
      </p>
      {avail.accounts.map((a) => (
        <div
          key={`${a.owner}:${a.name}`}
          className="ledger-row flex items-center justify-between gap-3 py-3"
        >
          <div className="flex min-w-0 items-center gap-2">
            <AccountTile account={a.name} />
            <div className="min-w-0">
              <div className="truncate text-body">{a.name}</div>
              <div className="text-caption text-muted-foreground">
                {personLabel(a.owner)} · last upload {dateLabel(a.lastDate)}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {a.stale && <Chip tone="warn">Stale</Chip>}
            {a.balanceSource === "derived" && <Chip>Derived</Chip>}
            <span className="num text-body">
              {a.balanceMinor !== null
                ? formatMoney(a.balanceMinor / 100, a.currency)
                : "Not recorded"}
            </span>
          </div>
        </div>
      ))}
      <div className="mt-4 border-t pt-4">
        <div className="flex items-center justify-between">
          <span className="text-body font-medium">Total available</span>
          <span className="num text-body font-semibold">
            {avail.gbpTotal !== null ? gbp(avail.gbpTotal) : "—"}
          </span>
        </div>
        {avail.foreign.map((f) => (
          <div
            key={f.currency}
            className="num mt-1.5 flex items-center justify-between text-caption text-muted-foreground"
          >
            <span>held in {f.currency}</span>
            <span>{formatMoney(f.total, f.currency)}</span>
          </div>
        ))}
        {avail.asOf && (
          <p className="mt-3 text-caption text-muted-foreground">
            As of {dateLabel(avail.asOf)} — the latest statement across these
            accounts.
          </p>
        )}
      </div>
    </div>
  );
}

const todayIso = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * The forecast's mini chart: the projected end-of-day balance line to
 * month end, drawn in the SpendChart's visual family (same width,
 * axis padding, dashed gridlines and £ tick labels). The floor, when
 * set, is a dashed line across; the low point is dotted and stated in
 * the readout under the chart, never colour alone.
 */
export function ForecastChart({ forecast }: { forecast: MonthForecast }) {
  const { series, floor, lowPoint } = forecast;
  const W = 720;
  const H = 168;
  const padL = 58;
  const padR = 8;
  const padT = 10;
  const padB = 20;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const balances = series.map((s) => s.balance);
  let lo = Math.min(...balances, ...(floor !== null ? [floor] : []));
  let hi = Math.max(...balances, ...(floor !== null ? [floor] : []));
  if (hi - lo < 1) {
    hi += 10;
    lo -= 10;
  }
  const pad = (hi - lo) * 0.08;
  lo -= pad;
  hi += pad;
  const x = (i: number) =>
    padL + (series.length <= 1 ? plotW / 2 : (i / (series.length - 1)) * plotW);
  const y = (v: number) => padT + plotH - ((v - lo) / (hi - lo)) * plotH;
  const ticks = [0, 1 / 3, 2 / 3, 1].map((f) => lo + f * (hi - lo));
  const lowIdx = Math.max(
    0,
    series.findIndex((s) => s.date === lowPoint.date),
  );
  const points = series.map((s, i) => `${x(i)},${y(s.balance)}`).join(" ");
  const shortDay = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(new Date(`${iso}T00:00:00Z`));
  return (
    <div className="mt-3">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={`Projected available balance to the end of the month: ends at ${gbp(forecast.projectedEnd)}, lowest ${gbp(lowPoint.amount)} on ${dateLabel(lowPoint.date)}.`}
      >
        {ticks.map((t, i) => (
          <g key={i}>
            <line
              x1={padL}
              x2={W - padR}
              y1={y(t)}
              y2={y(t)}
              className="stroke-border"
              strokeWidth={1}
              strokeDasharray="3 4"
            />
            <text
              x={padL - 6}
              y={y(t) + 4}
              textAnchor="end"
              fontSize={11}
              className="num fill-muted-foreground"
            >
              {gbp(t, false)}
            </text>
          </g>
        ))}
        {floor !== null && (
          <g>
            <line
              x1={padL}
              x2={W - padR}
              y1={y(floor)}
              y2={y(floor)}
              className="stroke-destructive"
              strokeWidth={1.5}
              strokeDasharray="6 4"
            />
            <text
              x={W - padR}
              y={y(floor) - 5}
              textAnchor="end"
              fontSize={11}
              className="fill-destructive"
            >
              floor
            </text>
          </g>
        )}
        <polygon
          points={`${x(0)},${y(lo)} ${points} ${x(series.length - 1)},${y(lo)}`}
          fill="var(--color-primary)"
          opacity={0.07}
        />
        <polyline
          points={points}
          fill="none"
          stroke="var(--color-primary)"
          strokeWidth={2}
        />
        <circle
          cx={x(lowIdx)}
          cy={y(lowPoint.amount)}
          r={4.5}
          className="fill-destructive"
        />
        <circle
          cx={x(series.length - 1)}
          cy={y(forecast.projectedEnd)}
          r={3.5}
          fill="var(--color-primary)"
        />
        <text
          x={padL}
          y={H - 5}
          fontSize={11}
          className="fill-muted-foreground"
        >
          {shortDay(series[0]!.date)}
        </text>
        <text
          x={W - padR}
          y={H - 5}
          textAnchor="end"
          fontSize={11}
          fontWeight={700}
          className="fill-foreground"
        >
          {shortDay(series[series.length - 1]!.date)}
        </text>
      </svg>
      <p
        className="num mt-1 text-caption text-muted-foreground"
        aria-live="polite"
      >
        Lowest point {gbp(lowPoint.amount)} on {dateLabel(lowPoint.date)}
      </p>
    </div>
  );
}

/**
 * "Rest of <Month>": the month-end forecast and safe-to-spend card,
 * stacked directly under Available in row 1. Every figure comes from
 * forecastFor (deterministic: Available's own start, the detector's
 * regulars out, detected income streams in, this month's pace for the
 * rest). With no recorded balance the forecast has no honest start
 * and the card renders nothing — the Available card already says so.
 */
export function ForecastCard({
  person,
  className,
}: {
  person: Person;
  className?: string;
}) {
  const forecast = useMemo(() => forecastFor(person), [person]);
  if (!forecast) return null;
  const month = currentMonthName();
  const stale = forecastIsStale(forecast.asOf, todayIso());
  const stamp = (
    <p className="mt-3 text-caption text-muted-foreground">
      Projected from statements to {dateLabel(forecast.asOf)}
      {stale ? " — figures may have moved since" : ""}
    </p>
  );
  if (forecast.remainingDays === 0) {
    return (
      <Panel {...(className ? { className } : {})}>
        <Label>Rest of {month}</Label>
        <p className="text-heading font-semibold leading-relaxed">
          {month} is complete in your statements — it ended at{" "}
          <span className="num">{gbp(forecast.start)}</span> available.
        </p>
        {stamp}
      </Panel>
    );
  }
  const { breach, headroom, perWeek, floor } = forecast;
  return (
    <Panel {...(className ? { className } : {})}>
      <Label>Rest of {month}</Label>
      <p className="text-heading font-semibold leading-relaxed">
        On course to end {month} at{" "}
        <span className="num">{gbp(forecast.projectedEnd)}</span>
      </p>
      <ForecastChart forecast={forecast} />
      <div className="mt-3 space-y-1.5 text-body leading-relaxed">
        {forecast.regularsOutTotal > 0 || forecast.regularsInTotal > 0 ? (
          <p className="num">
            {forecast.regularsOutTotal > 0 && (
              <>
                {gbp(forecast.regularsOutTotal, false)} of regulars still to go
                out
              </>
            )}
            {forecast.regularsOutTotal > 0 &&
              forecast.regularsInTotal > 0 &&
              " · "}
            {forecast.regularsInTotal > 0 && (
              <>
                {gbp(forecast.regularsInTotal, false)} of regular income still
                to come in
              </>
            )}
          </p>
        ) : (
          <p>No regulars left this month — the rest is day-to-day spending.</p>
        )}
        {breach && floor !== null && (
          <p className="font-medium text-destructive">
            Dips <span className="num">{gbp(breach.shortfall, false)}</span>{" "}
            below your {gbpTrim(floor)} floor on {dateLabel(breach.date)}
            {breach.culprit
              ? `, the day ${breach.culprit.name} ${gbp(breach.culprit.amount)} lands`
              : ""}
            .
          </p>
        )}
        {!breach && headroom !== null && perWeek !== null && floor !== null && (
          <p>
            <span className="num">{gbp(headroom)}</span> of headroom above your{" "}
            {gbpTrim(floor)} floor at the tightest point — about{" "}
            <span className="num">{gbp(perWeek, false)}</span> a week safe to
            spend for the rest of the month.
          </p>
        )}
        {!forecast.hasIncome && (
          <p className="text-muted-foreground">
            No regular income detected — outgoings and pace only.
          </p>
        )}
      </div>
      <p className="mt-3 text-caption text-muted-foreground">
        Regulars land on their usual dates; other spending runs at{" "}
        <span className="num">{gbp(forecast.paceDaily)}</span> a day, this
        month&rsquo;s pace so far
        {forecast.paceBlended ? ", steadied against last month" : ""}.
      </p>
      {stamp}
    </Panel>
  );
}

/**
 * Jev's second opinion on the Coach card: a separated, labelled block
 * under the deterministic Coach note, showing the two choices Jev
 * picked — verbatim, with no figures of its own. Fetched after render
 * (the server caches per view per day and fails open), so the card
 * never waits on Jev; when Jev is off, down, or has never answered,
 * this renders nothing and the card is exactly the pre-Jev card.
 */
export function JevCoachOpinion({ person }: { person: Person }) {
  const enabled = appSettings().jevEnabled;
  const [opinion, setOpinion] = useState<JevOpinion | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      const next = await fetchJevCoachOpinion(person);
      if (!cancelled) setOpinion(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [person, enabled]);

  if (!enabled || !opinion) return null;
  const posture = opinion.answers["posture"];
  const lever = opinion.answers["lever"];
  if (!posture && !lever) return null;
  return (
    <div className="mt-3 border-t border-foreground/10 pt-3">
      <div className="text-caption font-semibold tracking-wide text-muted-foreground uppercase">
        Jev&rsquo;s second opinion
      </div>
      {posture && (
        <p className="mt-1 text-body leading-relaxed">
          Posture: <span className="font-medium">{posture}</span>
        </p>
      )}
      {lever && (
        <p className="text-body leading-relaxed">
          Lever: <span className="font-medium">{lever}</span>
        </p>
      )}
      <p className="num mt-1 text-caption text-muted-foreground">
        {dateLabel(opinion.at.slice(0, 10))}
      </p>
    </div>
  );
}

const flowMonthShort = (key: string) =>
  new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" }).format(
    new Date(`${key}-02T00:00:00Z`),
  );
const flowMonthLong = (key: string) =>
  new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${key}-02T00:00:00Z`));

/**
 * "Income vs spending": this view's money in against money out for
 * the current month, and the gap between them — the control figure
 * for the household. Income is movement 'income' and spend movement
 * 'spend' from the precomputed aggregates (see flowWindowFor in
 * data.ts); moved-aside money and transfers between own accounts
 * count as NEITHER, so the gap never punishes saving. Below the
 * headline, paired bars for the last six months make the pattern
 * visible; a month with no data renders an honest empty pair, never
 * a skipped month. The gap follows the Activity direction
 * conventions — signed, green (--good via text-good) when the month
 * is ahead, red (--destructive via text-destructive) when behind —
 * the same token pair the .amount-in/.amount-out classes use.
 */
export function IncomeSpendingCard({
  person,
  className,
}: {
  person: Person;
  className?: string;
}) {
  const rows = useMemo(() => flowWindowFor(person), [person]);
  if (rows.length === 0) return null;
  const current = rows[rows.length - 1]!;
  const max = Math.max(...rows.flatMap((r) => [r.income, r.spend]), 0);
  const signedGap = (gap: number) =>
    `${gap >= 0 ? "+" : "−"}${gbp(Math.abs(gap))}`;
  // Bar fill height as a plain percentage of the window max; a
  // positive value also carries a 2px minimum-height class so a
  // small-but-real month (a few pounds against a five-figure one)
  // still shows a sliver of bar instead of vanishing.
  const barPct = (v: number) => (v > 0 && max > 0 ? (v / max) * 100 : 0);
  return (
    <Panel {...(className ? { className } : {})}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label>Income vs spending</Label>
        <div
          className="flex gap-3 text-caption text-muted-foreground"
          aria-hidden="true"
        >
          <span className="flex items-center gap-1.5">
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: "var(--good)" }}
            />
            In
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: "var(--destructive)" }}
            />
            Out
          </span>
        </div>
      </div>
      <p className="num mt-1 text-heading font-semibold leading-relaxed">
        In {gbp(current.income)} · Out {gbp(current.spend)} · Gap{" "}
        <span
          className={`whitespace-nowrap ${current.gap >= 0 ? "text-good" : "text-destructive"}`}
        >
          {signedGap(current.gap)}
        </span>
      </p>
      <div className="mt-4 flex items-end gap-2">
        {rows.map((r) => {
          const figures = `${flowMonthLong(r.month)}: in ${gbp(r.income)}, out ${gbp(r.spend)}, gap ${signedGap(r.gap)}`;
          return (
            <div
              key={r.month}
              className="flex min-w-0 flex-1 flex-col items-center"
              title={figures}
            >
              <span className="sr-only">{figures}</span>
              <div
                className="flex h-24 w-full items-end justify-center gap-1"
                aria-hidden="true"
              >
                <div className="flex h-full w-3.5 items-end rounded-sm bg-muted/60">
                  <div
                    className={`w-full rounded-sm ${r.income > 0 ? "min-h-[2px]" : ""}`}
                    style={{
                      height: `${barPct(r.income)}%`,
                      backgroundColor: "var(--good)",
                    }}
                  />
                </div>
                <div className="flex h-full w-3.5 items-end rounded-sm bg-muted/60">
                  <div
                    className={`w-full rounded-sm ${r.spend > 0 ? "min-h-[2px]" : ""}`}
                    style={{
                      height: `${barPct(r.spend)}%`,
                      backgroundColor: "var(--destructive)",
                    }}
                  />
                </div>
              </div>
              <div className="mt-1.5 text-micro text-muted-foreground">
                {flowMonthShort(r.month)}
              </div>
              {/* The net under each pair: full figure where the
                  column can hold it, compact (£14.8k) at phone
                  widths — six full "−£14,775.49" texts in ~55px
                  columns overlapped each other. The exact figure
                  always remains in the group's title + sr-only text. */}
              <div
                className={`num ${r.gap >= 0 ? "text-good" : "text-destructive"}`}
                aria-hidden="true"
              >
                <span className="hidden text-caption sm:inline">
                  {signedGap(r.gap)}
                </span>
                <span className="text-micro sm:hidden">
                  {`${r.gap >= 0 ? "+" : "−"}${gbpCompact(Math.abs(r.gap))}`}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-caption leading-relaxed text-muted-foreground">
        Transfers between your own accounts and money moved aside count as
        neither in nor out.
      </p>
    </Panel>
  );
}

export function Index() {
  const { person } = usePerson();
  const [availableOpen, setAvailableOpen] = useState(false);
  // The spend trend under the summary: the shared timeline section in
  // its compact form, over the same snapshot monthly history the
  // Categories chart reads (person-view aware, no fetch but Daily).
  const monthly = useMemo(() => monthlyHistoryFor(person), [person]);
  // No data at all: one honest empty state instead of five £0 panels
  // and captions with a dangling month ("Spent in ", "Coming up · ").
  // The month-interpolating captions below only render past this guard.
  // The guard reads ALL_TXNS (the whole loaded window), not TXNS: in a
  // display month that has begun but has no statements yet, the
  // display month's own list is legitimately empty while the app has
  // plenty of data — that is a £0 month, not the empty state.
  if (!currentMonthKey() || ALL_TXNS.length === 0) {
    return (
      <Panel>
        <Label>Home</Label>
        <p className="text-heading font-semibold">No statements imported yet</p>
        <p className="mt-2 text-body leading-relaxed text-muted-foreground">
          Once statements are imported, this screen shows the month at a glance.
          Head to{" "}
          <Link
            to="/import"
            className="font-medium text-primary underline underline-offset-4"
          >
            Import
          </Link>{" "}
          to add the first ones.
        </p>
      </Panel>
    );
  }
  const coming = upcomingPanel(person);
  const total = spendTotal(person);
  const usual = typicalTotal(person);
  const diff = total - usual;
  const small = smallSpendFact(TXNS, person);
  // Overall monthly budget (Settings): a slim progress line under the
  // hero's own bars. Null = no budget, and the hero is exactly as it
  // was. Judged on this view's current-month spend total.
  const { overallMonthlyBudgetMinor } = appSettings();
  const overallBudget =
    overallMonthlyBudgetMinor !== null ? overallMonthlyBudgetMinor / 100 : null;
  const overBudget = overallBudget !== null && total > overallBudget;
  return (
    <>
      {/* Home is bands of two independent stacks, ordered by value,
        highest first. Within a band each column is a vertical stack
        of natural-height cards, so a short card never shares a row
        with a taller row-mate: the only unevenness a band can show
        is at its own bottom, where its shorter column ends. Band 1
        pairs the hero with Biggest changes on the left and Available
        with the month-end forecast on the right (the forecast is
        about the Available money, so they sit together); the trend
        chart is a full-width divider, with the Income vs spending
        card full-width directly under it; band 3 pairs Coming up
        with Small spends against Coach over Money in; Moved aside
        is a slim strip last. On mobile the band and stack wrappers
        collapse (display: contents), every card becomes a direct
        item of the outer column, and each card's order class
        restores the single-column value order: hero, Available,
        forecast, trend, income vs spending, Coming up, Biggest
        changes, Coach, Money in, Small spends, Moved aside. (The
        band wrappers carry order classes of their own, 1 and 6,
        purely to sequence the desktop bands around the chart's 4,
        the flow card's 5 and the strip's 11; on mobile the wrappers
        have no box, so only the cards' order classes act.) */}
      <div className="flex flex-col gap-5 lg:gap-6">
        <div className="contents order-1 lg:flex lg:gap-6">
          <div className="contents lg:flex lg:min-w-0 lg:flex-1 lg:flex-col lg:gap-6">
            <div className="hero-panel order-1 rounded-xl p-5">
              <div className="hero-label mb-2 text-micro font-medium uppercase tracking-[0.08em]">
                Spent in {currentMonthName()}
              </div>
              <div className="hero-number font-display num text-hero">
                <CountUpMoney value={total} />
              </div>
              <p className="hero-comparison num mt-2 text-caption">
                {gbp(Math.abs(diff), false)} {diff >= 0 ? "more" : "less"} than
                a typical month ({gbp(usual, false)})
              </p>
              <div
                className="mt-3 space-y-1.5"
                role="img"
                aria-label={`${currentMonthName()} ${gbp(total, false)}; typical month ${gbp(usual, false)}`}
              >
                {[
                  {
                    name: currentMonthName(),
                    value: total,
                    colour: "bg-accent",
                  },
                  {
                    name: "Typical",
                    value: usual,
                    colour: "bg-hero-foreground/35",
                  },
                ].map((bar) => (
                  <div
                    key={bar.name}
                    className="flex items-center gap-2"
                    aria-hidden="true"
                  >
                    <span className="w-10 shrink-0 text-micro text-hero-foreground">
                      {bar.name}
                    </span>
                    <div className="hero-track h-1.5 flex-1 rounded-lg">
                      <AnimatedBar
                        percent={(bar.value / Math.max(total, usual, 1)) * 100}
                        className={bar.colour}
                      />
                    </div>
                  </div>
                ))}
              </div>
              {overallBudget !== null && (
                <div className="mt-3">
                  <div
                    className="hero-track h-1.5 rounded-lg"
                    role="img"
                    aria-label={`${gbp(total, false)} of ${gbp(overallBudget, false)} monthly budget${overBudget ? `; ${gbp(total - overallBudget, false)} over budget` : ""}`}
                  >
                    <AnimatedBar
                      percent={
                        overallBudget > 0
                          ? (total / overallBudget) * 100
                          : total > 0
                            ? 100
                            : 0
                      }
                      className={overBudget ? "" : "bg-accent"}
                      {...(overBudget
                        ? { colour: "var(--danger-on-hero)" }
                        : {})}
                    />
                  </div>
                  <p className="hero-comparison num mt-2 text-caption">
                    {gbp(total, false)} of {gbp(overallBudget, false)} budget
                    {overBudget && (
                      <>
                        {" · "}
                        <span className="hero-danger font-medium">
                          {gbp(total - overallBudget, false)} over budget
                        </span>
                      </>
                    )}
                  </p>
                </div>
              )}
            </div>

            <Panel className="order-7">
              <Label>Biggest changes</Label>
              {biggestChanges(person).map((c) => (
                <div
                  key={c.category}
                  className="ledger-row flex items-center justify-between py-3"
                >
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: categoryColor(c.category) }}
                    />
                    {c.category}
                  </span>
                  <span className="num text-body text-foreground">
                    {c.diff > 0 ? "+" : "−"}
                    {gbp(Math.abs(c.diff), false)}
                  </span>
                </div>
              ))}
            </Panel>
          </div>

          <div className="contents lg:flex lg:min-w-0 lg:flex-1 lg:flex-col lg:gap-6">
            <AvailableCard
              person={person}
              onOpen={() => setAvailableOpen(true)}
              className="order-2"
            />
            <ForecastCard person={person} className="order-3" />
          </div>
        </div>

        <SpendTimelineSection
          title="Spending trend"
          surface="home"
          monthly={monthly}
          dailyPerson={person}
          compact
          className="order-4"
        />

        <IncomeSpendingCard person={person} className="order-5" />

        <div className="contents order-6 lg:flex lg:gap-6">
          <div className="contents lg:flex lg:min-w-0 lg:flex-1 lg:flex-col lg:gap-6">
            <Panel className="order-6">
              <Label>Coming up · {nextMonthName()}</Label>
              <p className="text-heading font-semibold leading-relaxed">
                <span className="num">{gbp(coming.total, false)}</span> of
                regulars already known
              </p>
              <div className="mt-3">
                {coming.visible.map((payment) => (
                  <div
                    key={payment.name}
                    className="ledger-row flex items-center justify-between gap-3 py-2.5 text-body"
                  >
                    <div className="min-w-0">
                      <div>{payment.name}</div>
                      <div className="mt-0.5 text-caption text-muted-foreground">
                        {upcomingDateLabel(payment.date)}
                      </div>
                    </div>
                    <span className="num shrink-0">
                      {gbp(upcomingShare(payment, person))}
                    </span>
                  </div>
                ))}
                {coming.restCount > 0 && (
                  <div className="ledger-row py-2.5 text-body text-muted-foreground">
                    and {coming.restCount} more ·{" "}
                    <span className="num">{gbp(coming.restTotal)}</span>
                  </div>
                )}
              </div>
              <p className="mt-3 text-caption leading-relaxed text-muted-foreground">
                The regulars we already know about. One-offs and day-to-day
                spending are on top.
              </p>
            </Panel>

            <Panel className="order-10">
              <Label>Small spends</Label>
              <p className="num text-body leading-relaxed">
                Spends under £10 added up to {gbp(small.total)} this month
                across {small.count} spends.
                {small.total >= 40 && " That is roughly a family day out."}
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5" aria-hidden="true">
                {Array.from({ length: small.count }, (_, i) => (
                  <span
                    key={i}
                    className="h-1.5 w-1.5 rounded-full bg-primary/60"
                  />
                ))}
              </div>
              <div
                className="mt-2 h-1 rounded-lg bg-muted"
                role="img"
                aria-label={`${gbp(small.total)} in small spends out of ${gbp(total)} spent in ${currentMonthName()}`}
              >
                <AnimatedBar
                  percent={total > 0 ? (small.total / total) * 100 : 0}
                  className="bg-primary/60"
                />
              </div>
            </Panel>
          </div>

          <div className="contents lg:flex lg:min-w-0 lg:flex-1 lg:flex-col lg:gap-6">
            <Link to="/coach" className="order-8 block">
              <Panel className="bg-accent/8!">
                <Label>Coach</Label>
                <p className="num text-body leading-relaxed">
                  {coachNote(person)}
                </p>
                <JevCoachOpinion person={person} />
              </Panel>
            </Link>

            <Panel className="order-9">
              <Label>Money in · {currentMonthName()}</Label>
              <div className="num text-title font-semibold text-good">
                <CountUpMoney value={incomeTotal(person)} />
              </div>
              <div className="mt-3">
                {incomeFor(person).map((entry) => (
                  <div
                    key={incomeEntryKey(entry)}
                    className="ledger-row flex items-center justify-between gap-3 py-2 text-body"
                  >
                    <span>
                      {entry.type} · {personLabel(entry.owner)}
                    </span>
                    <span className="num shrink-0">
                      {gbp(entry.amount, false)}
                    </span>
                  </div>
                ))}
              </div>
              {asideTotal(person) > 0 && (
                <p className="num mt-3 text-caption text-muted-foreground">
                  Of this, {gbp(asideTotal(person), false)} was moved aside.
                </p>
              )}
            </Panel>
          </div>
        </div>

        {/* Moved aside is context, not a headline: a slim one-line strip
          (label, amount, what it is), not a full card. The label is a
          span here, not <Label>: the strip is a single flex line and
          Label's block margin would misalign it. */}
        <Panel className="order-11 flex flex-wrap items-center gap-x-3 gap-y-1 py-3!">
          <span className="text-micro font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Moved aside
          </span>
          <span className="num text-heading font-semibold text-aside">
            {gbp(asideTotal(person), false)}
          </span>
          <span className="text-caption text-muted-foreground">
            Savings & investments, not spending
          </span>
        </Panel>
      </div>
      <Sheet open={availableOpen} onClose={() => setAvailableOpen(false)}>
        <AvailableBreakdown person={person} />
      </Sheet>
    </>
  );
}
