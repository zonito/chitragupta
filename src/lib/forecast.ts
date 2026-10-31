import {
  ALL_TXNS,
  INCOME_REGULARS,
  SUBS,
  appSettings,
  availableFor,
  currentMonthKey,
  latestDataDate,
  shareOf,
  type IncomeRegular,
  type Owner,
  type Person,
  type Sub,
  type Txn,
} from "./data";
import { canonicalMerchant } from "./subscriptions";

/**
 * Month-end forecast and safe-to-spend: a deterministic projection of
 * the current view's Available balance to the end of the store's
 * current month. No AI and no invented figures — every input is a fact
 * the app already holds:
 *
 * - the start is the Available card's own GBP total for the view;
 * - regulars OUT are the subscription detector's Active subs, landing
 *   on their next expected dates (and stepping by their own cadence
 *   when a weekly regular lands twice in the window);
 * - regulars IN are recurring income streams detected from the store's
 *   income rows by detectIncomeRegulars (below);
 * - everything else is pace: this month's non-regular spend per
 *   elapsed day, projected over the days that remain.
 *
 * Moved-aside flows are neither spend nor income for this model: the
 * pace reads spend rows only, the out-regulars come from the detector
 * (which reads spend charges only), and the in-regulars are detected
 * over movement 'income' rows only. Category budgets never cap the
 * pace — budgets are targets, pace is observed behaviour. Foreign
 * currency stays out, exactly as it does in Available.
 */

const DAY = 86400000;
const dayMs = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
const addDays = (iso: string, days: number): string =>
  new Date(dayMs(iso) + days * DAY).toISOString().slice(0, 10);

function monthParts(key: string): { year: number; month: number } {
  const [year = 0, month = 0] = key.split("-").map(Number);
  return { year, month };
}
export function daysInMonth(key: string): number {
  const { year, month } = monthParts(key);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
export function monthEndOf(key: string): string {
  const { year, month } = monthParts(key);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}
function shiftMonthKey(key: string, delta: number): string {
  const { year, month } = monthParts(key);
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ---------------------------------------------------------------------------
// Recurring income detection — the spend detector's mirror, kept minimal:
// the same canonical grouping, the same 7% amount-cluster window and the
// same cadence discipline, restricted to the Monthly band (25–35 day
// gaps), because the forecast needs salary-like streams, not a second
// subscription detector. Two landings a month apart are enough evidence
// here (the spend side demands three charges, but two matched salary
// payments plus an in-band gap are a pattern, not a coincidence), and a
// stream counts as still landing when its last payment is within 1.5
// cadences of the store's latest date — the detector's own rule.
//
// A salary also escapes the 7% window legitimately: pay varies with
// bonuses, overtime and tax-code changes by far more than a bill does.
// So a merchant the cluster search cannot see gets a second, wider
// look — the median band: at least three landings on the same monthly
// cadence whose amounts sit within ±35% of their own median, projected
// at that median. The union is deduplicated by merchant (the tighter
// cluster reading wins where both fire). The SPEND detector is
// untouched: bills do not vary like pay, so 7% stays right there.
// ---------------------------------------------------------------------------

export interface IncomeCharge {
  merchant: string;
  /** ISO date; a full "YYYY-MM-DD HH:MM:SS" timestamp is tolerated. */
  date: string;
  /** Signed minor units, as stored (income is positive). */
  amountMinor: number;
  account: string;
  person: string;
}

const MONTHLY_BAND = { min: 25, max: 35 };

/**
 * The cadence discipline shared by both income readings: the median
 * gap inside the Monthly band and at least 60% of gaps in band.
 * Returns the median gap, or null when the dates are not a monthly
 * stream.
 */
function monthlyCadence(dates: string[]): number | null {
  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    gaps.push((dayMs(dates[i]!) - dayMs(dates[i - 1]!)) / DAY);
  }
  if (gaps.length === 0) return null;
  const medianGap = medianOf(gaps);
  if (medianGap < MONTHLY_BAND.min || medianGap > MONTHLY_BAND.max) {
    return null;
  }
  const inBand = gaps.filter(
    (g) => g >= MONTHLY_BAND.min && g <= MONTHLY_BAND.max,
  ).length;
  return inBand / gaps.length >= 0.6 ? medianGap : null;
}

/**
 * The median band for one merchant's charges: at least three
 * landings on a monthly cadence, amounts within ±35% of their
 * median. Wild outliers (a one-off bonus far outside the band) are
 * simply not members; the stream is what recurs.
 */
function medianBandStream(group: IncomeCharge[]): {
  charges: IncomeCharge[];
  medianGap: number;
  medianAmount: number;
} | null {
  if (group.length < 3) return null;
  const sorted = [...group].sort((a, b) => dayMs(a.date) - dayMs(b.date));
  const medianAmount = medianOf(sorted.map((c) => Math.abs(c.amountMinor)));
  if (medianAmount <= 0) return null;
  const members = sorted.filter((c) => {
    const a = Math.abs(c.amountMinor);
    return a >= medianAmount * 0.65 && a <= medianAmount * 1.35;
  });
  if (members.length < 3) return null;
  const medianGap = monthlyCadence(members.map((c) => c.date));
  if (medianGap === null) return null;
  return { charges: members, medianGap, medianAmount };
}

export function detectIncomeRegulars(
  charges: IncomeCharge[],
  latestDate: string,
): IncomeRegular[] {
  const groups = new Map<string, IncomeCharge[]>();
  for (const charge of charges) {
    if (charge.amountMinor <= 0) continue;
    const key = canonicalMerchant(charge.merchant);
    const list = groups.get(key) ?? [];
    list.push(charge);
    groups.set(key, list);
  }

  const regulars: IncomeRegular[] = [];
  for (const group of groups.values()) {
    const amounts = [...new Set(group.map((c) => Math.abs(c.amountMinor)))].sort(
      (a, b) => a - b,
    );
    let best: { charges: IncomeCharge[]; medianGap: number } | null = null;
    for (const low of amounts) {
      const members = group
        .filter((c) => {
          const a = Math.abs(c.amountMinor);
          return a >= low && a <= low * 1.07;
        })
        .sort((a, b) => dayMs(a.date) - dayMs(b.date));
      if (members.length < 2) continue;
      const gaps: number[] = [];
      for (let i = 1; i < members.length; i++) {
        gaps.push((dayMs(members[i]!.date) - dayMs(members[i - 1]!.date)) / DAY);
      }
      const medianGap = medianOf(gaps);
      if (medianGap < MONTHLY_BAND.min || medianGap > MONTHLY_BAND.max) continue;
      const inBand = gaps.filter(
        (g) => g >= MONTHLY_BAND.min && g <= MONTHLY_BAND.max,
      ).length;
      if (inBand / gaps.length < 0.6) continue;
      if (
        !best ||
        members.length > best.charges.length ||
        (members.length === best.charges.length &&
          dayMs(members[members.length - 1]!.date) >
            dayMs(best.charges[best.charges.length - 1]!.date))
      ) {
        best = { charges: members, medianGap };
      }
    }
    // The union, deduplicated by merchant: the tight 7% cluster
    // reading where it fired (projected at its latest amount), else
    // the median band (projected at the median).
    let chosen: {
      charges: IncomeCharge[];
      medianGap: number;
      amountMinor: number;
    } | null = null;
    if (best) {
      chosen = {
        charges: best.charges,
        medianGap: best.medianGap,
        amountMinor: Math.abs(
          best.charges[best.charges.length - 1]!.amountMinor,
        ),
      };
    } else {
      const band = medianBandStream(group);
      if (band) {
        chosen = {
          charges: band.charges,
          medianGap: band.medianGap,
          amountMinor: band.medianAmount,
        };
      }
    }
    if (!chosen) continue;

    const cluster = chosen.charges;
    const last = cluster[cluster.length - 1]!;
    const lastDate = last.date.slice(0, 10);
    // Still landing? The detector's rule: the last charge within
    // 1.5 cadences of the store's latest date.
    if ((dayMs(latestDate) - dayMs(lastDate)) / DAY > chosen.medianGap * 1.5) {
      continue;
    }

    // Display name: the variant with the most charges; ties go to the
    // variant of the most recent charge (the detector's rule).
    const variantCounts = new Map<string, number>();
    for (const c of group) {
      variantCounts.set(c.merchant, (variantCounts.get(c.merchant) ?? 0) + 1);
    }
    const name = [...variantCounts.entries()].sort(
      (a, b) =>
        b[1] - a[1] ||
        (a[0] === last.merchant ? -1 : b[0] === last.merchant ? 1 : 0),
    )[0]![0];

    regulars.push({
      name,
      amount: chosen.amountMinor / 100,
      owner: (last.account === "Joint" ? "joint" : last.person) as Owner,
      nextExpected: addDays(lastDate, Math.round(chosen.medianGap)),
      periodDays: Math.round(chosen.medianGap),
    });
  }
  regulars.sort((a, b) => b.amount - a.amount);
  return regulars;
}

// ---------------------------------------------------------------------------
// The projection model.
// ---------------------------------------------------------------------------

/** Nominal cadence (days) per detector frequency, for hand-built subs
 * that carry no measured periodDays. */
const FREQ_PERIOD_DAYS: Record<Sub["freq"], number> = {
  Weekly: 7,
  Monthly: 30,
  Quarterly: 91,
  Yearly: 365,
};

/** The view's share of one regular, the shareOf / upcomingShare rule:
 * household takes it whole, a person takes their own whole and half
 * of Joint. */
function shareOfRegular(amount: number, owner: Owner, person: Person): number {
  if (person === "household") return amount;
  if (owner === "joint") return amount / 2;
  return owner === person ? amount : 0;
}

/** Every charge that belongs to a detected subscription cluster, any
 * status: regular by nature, so never part of the variable pace. Only
 * Active subs are projected forward as events. */
export function regularChargeIds(subs: readonly Sub[]): Set<string> {
  const ids = new Set<string>();
  for (const sub of subs) for (const id of sub.chargeIds) ids.add(id);
  return ids;
}

export interface PaceResult {
  /** Non-regular spend per day for the view, pounds. */
  dailyRate: number;
  elapsedDays: number;
  remainingDays: number;
  /** True when a young month (< 5 elapsed days) blended 50/50 with
   * the previous complete month's daily rate. */
  blended: boolean;
}

/**
 * The variable pace: the current month's non-regular spend — spend
 * rows in no subscription cluster, one-offs excluded (a one-off is
 * tagged precisely so it never skews a run rate) — per elapsed day,
 * elapsed being the days from the month's start to the latest data
 * date. Under 5 elapsed days the month's own rate is mostly noise, so
 * it blends 50/50 with the previous complete month's daily
 * non-regular rate (same exclusions, over that month's full length).
 */
export function paceFor(
  person: Person,
  monthKey: string,
  asOf: string,
  txns: readonly Txn[],
  regularIds: ReadonlySet<string>,
): PaceResult {
  const elapsedDays = Number(asOf.slice(8, 10));
  const remainingDays = daysInMonth(monthKey) - elapsedDays;
  const nonRegular = (key: string) =>
    txns
      .filter(
        (t) =>
          t.monthKey === key &&
          t.kind === "spend" &&
          t.category !== "One-off" &&
          !regularIds.has(t.id),
      )
      .reduce((sum, t) => sum + shareOf(t, person), 0);
  const ownRate = elapsedDays > 0 ? nonRegular(monthKey) / elapsedDays : 0;
  let dailyRate = ownRate;
  let blended = false;
  if (elapsedDays < 5) {
    const prevKey = shiftMonthKey(monthKey, -1);
    const prevTotal = nonRegular(prevKey);
    if (prevTotal > 0) {
      dailyRate = (ownRate + prevTotal / daysInMonth(prevKey)) / 2;
      blended = true;
    }
  }
  return { dailyRate, elapsedDays, remainingDays, blended };
}

/** One dated cash movement in the walk: signed pounds at the view's
 * share (negative out, positive in). */
export interface ForecastEvent {
  date: string;
  name: string;
  amount: number;
}

/**
 * The regulars landing in the rest of the month, per view: Active subs
 * stepping from their next expected date by their own cadence, and
 * detected income streams likewise. An expected date the data has
 * already passed steps forward by whole cadences first — the stream
 * has not stopped, the statement just has not caught up.
 */
export function forecastEvents(
  person: Person,
  subs: readonly Sub[],
  incomeRegulars: readonly IncomeRegular[],
  asOf: string,
  monthEnd: string,
): {
  events: ForecastEvent[];
  outTotal: number;
  inTotal: number;
  /** Any income stream detected for this view at all, whether or not
   * a landing falls inside this month's remaining days. */
  hasIncome: boolean;
} {
  const events: ForecastEvent[] = [];
  let outTotal = 0;
  let inTotal = 0;
  const step = (
    first: string,
    periodDays: number,
    emit: (date: string) => void,
  ) => {
    // A hand-built regular could carry a zero period; never step by
    // less than a day (the guard caps the damage regardless).
    const period = Math.max(1, Math.round(periodDays) || 1);
    let date = first;
    let guard = 0;
    while (date <= asOf && guard++ < 400) date = addDays(date, period);
    while (date <= monthEnd && guard++ < 800) {
      emit(date);
      date = addDays(date, period);
    }
  };
  for (const sub of subs) {
    if (sub.status !== "Active" || sub.nextExpected === null) continue;
    const share = shareOfRegular(sub.amount, sub.owner, person);
    if (share <= 0) continue;
    step(sub.nextExpected, sub.periodDays ?? FREQ_PERIOD_DAYS[sub.freq], (date) => {
      events.push({ date, name: sub.name, amount: -share });
      outTotal += share;
    });
  }
  let hasIncome = false;
  for (const regular of incomeRegulars) {
    const share = shareOfRegular(regular.amount, regular.owner, person);
    if (share <= 0) continue;
    hasIncome = true;
    step(regular.nextExpected, regular.periodDays, (date) => {
      events.push({ date, name: regular.name, amount: share });
      inTotal += share;
    });
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
  return { events, outTotal, inTotal, hasIncome };
}

export interface MonthForecast {
  monthKey: string;
  /** The latest data date: the walk starts from the end of this day. */
  asOf: string;
  monthEnd: string;
  /** The view's Available (GBP) today — the Available card's figure. */
  start: number;
  paceDaily: number;
  paceBlended: boolean;
  elapsedDays: number;
  remainingDays: number;
  regularsOutTotal: number;
  regularsInTotal: number;
  hasIncome: boolean;
  projectedEnd: number;
  lowPoint: { date: string; amount: number };
  /** End-of-day balances from asOf (the start) to month end. */
  series: { date: string; balance: number }[];
  /** The view's configured Available floor (pounds), or null. */
  floor: number | null;
  /** lowPoint − floor when the floor is set and never breached. */
  headroom: number | null;
  /** Headroom per remaining week, rounded down to whole pounds. */
  perWeek: number | null;
  /** Set when the low point dips below the floor: the shortfall, the
   * low point's date, and the regular that dominates that day's drop
   * when one does (at least half of it) — otherwise no culprit, the
   * dip is pace, not an event. */
  breach: {
    shortfall: number;
    date: string;
    culprit: { name: string; amount: number } | null;
  } | null;
}

export interface ProjectInput {
  start: number;
  asOf: string;
  monthEnd: string;
  paceDaily: number;
  events: readonly ForecastEvent[];
  floor: number | null;
}

/**
 * The day-by-day walk: from the day after the latest data date to
 * month end, accrue the pace daily and land each regular on its date.
 * The low point is the minimum end-of-day balance across the walk,
 * today included. Pure arithmetic over its inputs — the fixture test
 * re-derives the same walk from SQL and compares.
 */
export function projectMonth(input: ProjectInput): {
  series: { date: string; balance: number }[];
  projectedEnd: number;
  lowPoint: { date: string; amount: number };
  breach: MonthForecast["breach"];
  headroom: number | null;
  perWeek: number | null;
} {
  const { start, asOf, monthEnd, paceDaily, events, floor } = input;
  const byDate = new Map<string, ForecastEvent[]>();
  for (const event of events) {
    const list = byDate.get(event.date) ?? [];
    list.push(event);
    byDate.set(event.date, list);
  }
  const series = [{ date: asOf, balance: start }];
  let balance = start;
  let lowPoint = { date: asOf, amount: start };
  let lowPointCulprit: { name: string; amount: number } | null = null;
  let date = asOf;
  while (date < monthEnd) {
    const previous = balance;
    date = addDays(date, 1);
    balance -= paceDaily;
    for (const event of byDate.get(date) ?? []) balance += event.amount;
    series.push({ date, balance });
    if (balance < lowPoint.amount) {
      lowPoint = { date, amount: balance };
      // The day's story, judged while the day is in hand: name a
      // culprit only when one regular is at least half of the drop
      // from yesterday's close to this low.
      const drop = previous - balance;
      const biggest = (byDate.get(date) ?? [])
        .filter((e) => e.amount < 0)
        .sort((a, b) => a.amount - b.amount)[0];
      lowPointCulprit =
        biggest && drop > 0 && -biggest.amount >= drop / 2
          ? { name: biggest.name, amount: -biggest.amount }
          : null;
    }
  }
  const remainingDays = series.length - 1;
  let breach: MonthForecast["breach"] = null;
  let headroom: number | null = null;
  let perWeek: number | null = null;
  if (floor !== null) {
    if (lowPoint.amount < floor) {
      breach = {
        shortfall: floor - lowPoint.amount,
        date: lowPoint.date,
        // Null when the low point is today's own starting balance:
        // no landing caused a dip that was never there.
        culprit: lowPointCulprit,
      };
    } else if (remainingDays > 0) {
      headroom = lowPoint.amount - floor;
      const weeks = Math.max(remainingDays / 7, 1);
      perWeek = Math.floor(headroom / weeks);
    }
  }
  return { series, projectedEnd: balance, lowPoint, breach, headroom, perWeek };
}

/**
 * The forecast for the view on screen, composed from the hydrated
 * snapshot exactly as Home's other cards compose theirs: Available's
 * figure for the start, the detector's subs and the detected income
 * streams for the regulars, the loaded two months for the pace, and
 * Settings' floor for safe-to-spend. Null when the view has no
 * recorded balance or no current month — the card then renders
 * nothing, rather than projecting from an invented start.
 */
export function forecastFor(person: Person): MonthForecast | null {
  const monthKey = currentMonthKey();
  if (!monthKey) return null;
  const asOf = latestDataDate();
  if (!asOf || asOf.slice(0, 7) !== monthKey) return null;
  const start = availableFor(person).gbpTotal;
  if (start === null) return null;
  const monthEnd = monthEndOf(monthKey);
  const pace = paceFor(person, monthKey, asOf, ALL_TXNS, regularChargeIds(SUBS));
  const { events, outTotal, inTotal, hasIncome } = forecastEvents(
    person,
    SUBS,
    INCOME_REGULARS,
    asOf,
    monthEnd,
  );
  const floorMinor = appSettings().availableFloorMinor;
  const floor = floorMinor === null ? null : floorMinor / 100;
  const walk = projectMonth({
    start,
    asOf,
    monthEnd,
    paceDaily: pace.dailyRate,
    events,
    floor,
  });
  return {
    monthKey,
    asOf,
    monthEnd,
    start,
    paceDaily: pace.dailyRate,
    paceBlended: pace.blended,
    elapsedDays: pace.elapsedDays,
    remainingDays: pace.remainingDays,
    regularsOutTotal: outTotal,
    regularsInTotal: inTotal,
    hasIncome,
    projectedEnd: walk.projectedEnd,
    lowPoint: walk.lowPoint,
    series: walk.series,
    floor,
    headroom: walk.headroom,
    perWeek: walk.perWeek,
    breach: walk.breach,
  };
}

/**
 * The card's provenance stamp is only as fresh as the statements
 * behind it: more than 7 days between the latest data date and today
 * earns the stamp its "figures may have moved since" suffix.
 */
export function forecastIsStale(asOf: string, today: string): boolean {
  return (dayMs(today) - dayMs(asOf)) / DAY > 7;
}
