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
  const amounts = [...new Set(charges.map((c) => Math.abs(c.amountMinor)))].sort(
    (a, b) => a - b,
  );
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
  /** "5 Oct" style label for an ISO date. */
  dateLabel: (iso: string) => string;
  /** UI label for a store account name. */
  accountLabel: (account: string) => string;
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
      card: format.accountLabel(last.account),
      owner: (last.account === "Joint" ? "joint" : last.person) as Owner,
      status: active ? "Active" : "Ended",
      charges: cluster.length,
      nextExpected: active ? addDays(lastDate, Math.round(best.medianGap)) : null,
      variants,
      ...(note ? { note } : {}),
    });
  }
  subs.sort((a, b) => b.amount - a.amount);
  return subs;
}
