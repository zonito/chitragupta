import { gbp, type Owner, type Sub } from "./data";

/**
 * Subscription detection, pattern-only.
 *
 * A subscription is a recurring AMOUNT CLUSTER: near-identical amounts
 * charged on a regular cadence. That is what separates a subscription
 * from a shop the household happens to visit monthly — groceries, fuel
 * and coffee produce monthly-ish visits at ever-changing amounts and
 * must never appear here. Merchant memory's "Subscriptions" category
 * plays no part: the old category bypass is how noise got in.
 *
 * Amounts are grouped in a 7% spread window, not to the penny: a
 * foreign-priced subscription (bitwarden's $10) lands in GBP at a
 * slightly different amount every year as the exchange rate moves
 * (£8.15, £7.76, £7.65), and an exact-amount rule fragments it into
 * singletons. The cadence test does the real discriminating.
 *
 * One extra guard for the weakest evidence shape: a Yearly cluster of
 * exactly two charges is a single gap, which heavy unrelated spend
 * produces by coincidence (a grocer charging £2.60 twice, a year
 * apart). A two-charge Yearly cluster only counts when it is at least
 * half of everything that merchant ever charged.
 *
 * Charges are grouped by a canonical merchant name first, so one
 * subscription billed under name variants ("Lebara" / "Lebara mobile")
 * merges into a single entry whose cadence is regular once combined.
 */

export interface SubCharge {
  /** Store fingerprint of the transaction this charge came from. */
  id: string;
  merchant: string;
  /** ISO date; a full "YYYY-MM-DD HH:MM:SS" timestamp is tolerated. */
  date: string;
  /** Signed minor units, as stored (spend is negative). */
  amountMinor: number;
  account: string;
  person: string;
}

export type SubFreq = Sub["freq"];

const BANDS: { freq: SubFreq; min: number; max: number }[] = [
  { freq: "Weekly", min: 6, max: 8 },
  { freq: "Monthly", min: 25, max: 35 },
  { freq: "Quarterly", min: 80, max: 100 },
  { freq: "Yearly", min: 335, max: 395 },
];

/**
 * Canonical merchant key: lowercase alphanumerics only, with a trailing
 * "mobile" suffix stripped ("Lebara mobile" → "lebara"). Distinct
 * merchants keep distinct keys ("Google Cloud" vs "Google Endel Sound").
 */
export function canonicalMerchant(name: string): string {
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return key.endsWith("mobile") && key.length > "mobile".length
    ? key.slice(0, -"mobile".length)
    : key;
}

const dayMs = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
const DAY = 86400000;

function addDays(iso: string, days: number): string {
  return new Date(dayMs(iso) + days * DAY).toISOString().slice(0, 10);
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

interface Cluster {
  freq: SubFreq;
  charges: SubCharge[]; // ascending by date
  medianGap: number;
}

/** Test one amount cluster's dates against the cadence bands. */
function testCluster(charges: SubCharge[]): Cluster | null {
  if (charges.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < charges.length; i++) {
    gaps.push((dayMs(charges[i]!.date) - dayMs(charges[i - 1]!.date)) / DAY);
  }
  const medianGap = medianOf(gaps);
  const band = BANDS.find((b) => medianGap >= b.min && medianGap <= b.max);
  if (!band) return null;
  const inBand = gaps.filter((g) => g >= band.min && g <= band.max).length;
  if (inBand / gaps.length < 0.6) return null;
  const minSize = band.freq === "Yearly" ? 2 : 3;
  if (charges.length < minSize) return null;
  return { freq: band.freq, charges, medianGap };
}

/**
 * Candidate amount clusters: for each distinct amount, the window of
 * amounts within a 7% spread above it, and the charges in that window.
 * Overlapping windows that select the same charges are returned once.
 */
function amountClusters(charges: SubCharge[]): SubCharge[][] {
  const amounts = [
    ...new Set(charges.map((c) => Math.abs(c.amountMinor))),
  ].sort((a, b) => a - b);
  const seen = new Set<string>();
  const clusters: SubCharge[][] = [];
  for (const low of amounts) {
    const set = new Set(amounts.filter((a) => a >= low && a <= low * 1.07));
    const members = charges
      .filter((c) => set.has(Math.abs(c.amountMinor)))
      .sort((a, b) => dayMs(a.date) - dayMs(b.date));
    const key = members.map((c) => `${c.date}:${c.amountMinor}`).join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    clusters.push(members);
  }
  return clusters;
}

export interface DetectFormat {
  /** "5 Oct 2026" style label for an ISO date. */
  dateLabel: (iso: string) => string;
  /** UI label for a store account name, for the person who holds it. */
  accountLabel: (account: string, person: string) => string;
}

/**
 * Detect subscriptions from spend charges. `latestDate` is the store's
 * latest transaction date (ISO); a subscription is Active when its last
 * cluster charge falls within 1.5× its cadence period of that date.
 */
export function detectSubscriptions(
  charges: SubCharge[],
  latestDate: string,
  format: DetectFormat,
): Sub[] {
  const groups = new Map<string, SubCharge[]>();
  for (const charge of charges) {
    const key = canonicalMerchant(charge.merchant);
    const list = groups.get(key) ?? [];
    list.push(charge);
    groups.set(key, list);
  }

  const subs: Sub[] = [];
  for (const group of groups.values()) {
    let best: Cluster | null = null;
    for (const clusterCharges of amountClusters(group)) {
      const candidate = testCluster(clusterCharges);
      if (!candidate) continue;
      // A two-charge Yearly cluster inside heavy unrelated spend is a
      // coincidence, not a subscription (see the header note).
      if (
        candidate.freq === "Yearly" &&
        candidate.charges.length === 2 &&
        candidate.charges.length * 2 < group.length
      ) {
        continue;
      }
      if (
        !best ||
        candidate.charges.length > best.charges.length ||
        (candidate.charges.length === best.charges.length &&
          dayMs(candidate.charges[candidate.charges.length - 1]!.date) >
            dayMs(best.charges[best.charges.length - 1]!.date))
      ) {
        best = candidate;
      }
    }
    if (!best) continue;

    const cluster = best.charges;
    const last = cluster[cluster.length - 1]!;
    const prev = cluster[cluster.length - 2];
    const lastDate = last.date.slice(0, 10);

    // Display name: the variant with the most charges in the group; ties
    // go to the variant of the most recent charge.
    const variantCounts = new Map<string, number>();
    for (const c of group) {
      variantCounts.set(c.merchant, (variantCounts.get(c.merchant) ?? 0) + 1);
    }
    const variants = [...variantCounts.keys()].sort();
    const name = [...variantCounts.entries()].sort(
      (a, b) =>
        b[1] - a[1] ||
        (a[0] === last.merchant ? -1 : b[0] === last.merchant ? 1 : 0),
    )[0]![0];

    const active =
      (dayMs(latestDate) - dayMs(lastDate)) / DAY <= best.medianGap * 1.5;
    const lastAmount = Math.abs(last.amountMinor);
    const note =
      prev && lastAmount > Math.abs(prev.amountMinor)
        ? `${gbp(Math.abs(prev.amountMinor) / 100)} → ${gbp(lastAmount / 100)}`
        : undefined;

    subs.push({
      name,
      amount: lastAmount / 100,
      freq: best.freq,
      last: format.dateLabel(lastDate),
      card: format.accountLabel(last.account, last.person),
      owner: (last.account === "Joint" ? "joint" : last.person) as Owner,
      status: active ? "Active" : "Ended",
      charges: cluster.length,
      chargeIds: cluster.map((c) => c.id),
      nextExpected: active
        ? addDays(lastDate, Math.round(best.medianGap))
        : null,
      periodDays: Math.round(best.medianGap),
      variants,
      ...(note ? { note } : {}),
    });
  }
  subs.sort((a, b) => b.amount - a.amount);
  return subs;
}

/**
 * Human overrides on top of the pattern-only detector, keyed by
 * canonical merchant (the subscription_overrides table):
 * - suppress: the merchant never appears (kills detector false
 *   positives, e.g. a yearly cluster that is really just shopping);
 * - cancelled: the sub stays visible with status "Cancelled" — a
 *   label distinct from the detector's own "Ended" — and, like Ended,
 *   it drops out of Active totals, Coach and Coming up;
 * - force: the merchant appears as an Active subscription even with
 *   no detected pattern, derived from its charges (below).
 * With no overrides the detector's output passes through untouched.
 */
export type SubscriptionOverrideMode = "force" | "suppress" | "cancelled";

const FREQ_PERIOD_DAYS: Record<SubFreq, number> = {
  Weekly: 7,
  Monthly: 30,
  Quarterly: 91,
  Yearly: 365,
};

/** The cadence band most of the gaps fall in; Monthly when none do. */
function mostCommonFreq(gaps: number[]): SubFreq {
  const counts = new Map<SubFreq, number>();
  for (const gap of gaps) {
    const band = BANDS.find((b) => gap >= b.min && gap <= b.max);
    if (band) counts.set(band.freq, (counts.get(band.freq) ?? 0) + 1);
  }
  let best: SubFreq = "Monthly";
  let bestCount = 0;
  // Monthly is also the fallback, so it wins ties.
  for (const freq of [
    "Monthly",
    "Weekly",
    "Quarterly",
    "Yearly",
  ] as SubFreq[]) {
    const count = counts.get(freq) ?? 0;
    if (count > bestCount) {
      best = freq;
      bestCount = count;
    }
  }
  return best;
}

/**
 * A forced subscription, derived from ALL of the merchant's spend
 * charges: the amount is its latest charge, the cadence its most
 * common charge interval (Monthly fallback), first/last from the
 * charges themselves, status Active.
 */
function forcedSub(group: SubCharge[], format: DetectFormat): Sub {
  const sorted = [...group].sort((a, b) => dayMs(a.date) - dayMs(b.date));
  const last = sorted[sorted.length - 1]!;
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push((dayMs(sorted[i]!.date) - dayMs(sorted[i - 1]!.date)) / DAY);
  }
  const freq = mostCommonFreq(gaps);
  const step =
    gaps.length > 0 ? Math.round(medianOf(gaps)) : FREQ_PERIOD_DAYS[freq];
  const variantCounts = new Map<string, number>();
  for (const c of sorted) {
    variantCounts.set(c.merchant, (variantCounts.get(c.merchant) ?? 0) + 1);
  }
  const variants = [...variantCounts.keys()].sort();
  const name = [...variantCounts.entries()].sort(
    (a, b) =>
      b[1] - a[1] ||
      (a[0] === last.merchant ? -1 : b[0] === last.merchant ? 1 : 0),
  )[0]![0];
  const lastDate = last.date.slice(0, 10);
  return {
    name,
    amount: Math.abs(last.amountMinor) / 100,
    freq,
    last: format.dateLabel(lastDate),
    card: format.accountLabel(last.account, last.person),
    owner: (last.account === "Joint" ? "joint" : last.person) as Owner,
    status: "Active",
    charges: sorted.length,
    chargeIds: sorted.map((c) => c.id),
    nextExpected: addDays(lastDate, step),
    periodDays: step,
    variants,
  };
}

export function applySubscriptionOverrides(
  detected: Sub[],
  charges: SubCharge[],
  overrides: ReadonlyMap<string, SubscriptionOverrideMode>,
  format: DetectFormat,
): Sub[] {
  if (overrides.size === 0) return detected;
  const out: Sub[] = [];
  const detectedKeys = new Set<string>();
  for (const sub of detected) {
    const key = canonicalMerchant(sub.name);
    detectedKeys.add(key);
    const mode = overrides.get(key);
    if (mode === "suppress") continue;
    if (mode === "cancelled") {
      out.push({ ...sub, status: "Cancelled", nextExpected: null });
      continue;
    }
    out.push(sub);
  }
  const forcedGroups = new Map<string, SubCharge[]>();
  for (const charge of charges) {
    const key = canonicalMerchant(charge.merchant);
    if (overrides.get(key) !== "force" || detectedKeys.has(key)) continue;
    const list = forcedGroups.get(key) ?? [];
    list.push(charge);
    forcedGroups.set(key, list);
  }
  for (const group of forcedGroups.values()) out.push(forcedSub(group, format));
  out.sort((a, b) => b.amount - a.amount);
  return out;
}

/**
 * Presentation order within a cadence section of the Subscriptions
 * page: soonest next charge first, by the detector's own nextExpected
 * ISO date (ISO dates order chronologically as strings). Equal dates
 * fall back to name so the order is total and stable; a sub with no
 * future expectation — the detector never emits one for an Active
 * sub, but overrides and hand-built subs can carry null — sorts last.
 */
export function compareSubsByNextExpected(a: Sub, b: Sub): number {
  if (a.nextExpected && b.nextExpected && a.nextExpected !== b.nextExpected) {
    return a.nextExpected < b.nextExpected ? -1 : 1;
  }
  if (a.nextExpected && !b.nextExpected) return -1;
  if (!a.nextExpected && b.nextExpected) return 1;
  return a.name.localeCompare(b.name);
}

/** A sorted copy; the detector's own order in the input is untouched. */
export function sortSubsByNextExpected(subs: Sub[]): Sub[] {
  return [...subs].sort(compareSubsByNextExpected);
}
