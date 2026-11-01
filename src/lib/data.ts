/**
 * UI data layer.
 *
 * This module holds NO sample data. A DataSnapshot built on the server from
 * the real store (see snapshot.server.ts) is hydrated into module state by
 * the root route loader before any screen renders; every export below reads
 * that state. Before hydration (or with no store configured) the state is
 * honestly empty and screens render their empty states.
 *
 * The pure helpers (shareOf, spendTotal, byCategory, the Ask answers, the
 * document attach/detach functions) keep the shapes the screens and tests
 * were built against — they just run over whatever snapshot is loaded.
 */

export type Person = "household" | "zonito" | "nikhila";
export type Owner = "zonito" | "nikhila" | "joint";
export type Kind = "spend" | "transfer" | "aside" | "income";

export const CATEGORIES = [
  "Groceries",
  "Eating out",
  "Transport",
  "School",
  "Home",
  "Subscriptions",
  "Holidays",
  "Shopping",
  "One-off",
] as const;
export type Category = (typeof CATEGORIES)[number] | "Transfer" | "Moved aside";
export const CATEGORY_COLOR: Record<(typeof CATEGORIES)[number], string> = {
  Groceries: "var(--cat-groceries)",
  "Eating out": "var(--cat-eating-out)",
  Transport: "var(--cat-transport)",
  School: "var(--cat-school)",
  Home: "var(--cat-home)",
  Subscriptions: "var(--cat-subscriptions)",
  Holidays: "var(--cat-holidays)",
  Shopping: "var(--cat-shopping)",
  "One-off": "var(--cat-one-off)",
};
/** Text ink for CategoryChip: same hues as CATEGORY_COLOR, darkened in
 *  the light theme (via the --cat-*-ink tokens) so chip text clears
 *  4.5:1 on its 12% tint; identical to CATEGORY_COLOR in dark. */
export const CATEGORY_INK: Record<(typeof CATEGORIES)[number], string> = {
  Groceries: "var(--cat-groceries-ink)",
  "Eating out": "var(--cat-eating-out-ink)",
  Transport: "var(--cat-transport-ink)",
  School: "var(--cat-school-ink)",
  Home: "var(--cat-home-ink)",
  Subscriptions: "var(--cat-subscriptions-ink)",
  Holidays: "var(--cat-holidays-ink)",
  Shopping: "var(--cat-shopping-ink)",
  "One-off": "var(--cat-one-off-ink)",
};

/**
 * The live category list: the snapshot's categories (built-ins +
 * user-created, from the store) once hydrated, the built-in defs
 * before that. Every surface that enumerates categories — chips,
 * dropdowns, the Categories screen — goes through these helpers, so a
 * custom category gets its colour and icon everywhere automatically.
 */
export function categoryDefs(): CategoryDef[] {
  return CATEGORY_DEFS.length > 0 ? [...CATEGORY_DEFS] : BUILTIN_CATEGORY_DEFS;
}
export function categoryNames(): string[] {
  return categoryDefs().map((d) => d.name);
}
export function categoryColor(name: string): string {
  return (
    categoryDefs().find((d) => d.name === name)?.colour ??
    CATEGORY_COLOR[name as (typeof CATEGORIES)[number]] ??
    "var(--cat-one-off)"
  );
}
export function categoryInk(name: string): string {
  return CATEGORY_INK[name as (typeof CATEGORIES)[number]] ?? categoryColor(name);
}
export function categoryIcon(name: string): string {
  return categoryDefs().find((d) => d.name === name)?.icon ?? "tag";
}

export interface Txn {
  id: string;
  date: string; // ISO YYYY-MM-DD
  day: number; // day of month, within monthKey
  monthKey: string; // YYYY-MM
  merchant: string;
  category: Category;
  amount: number;
  owner: Owner;
  account: string;
  /** Store account name behind the display label ("Pro", "Joint",
   * "Savings-9000000002") — the label alone is not unique (two savings
   * accounts share one) and repeats across people (both hold a Pro),
   * so account-scoped views key on this plus the owner. Set by both
   * transaction mappers; absent on hand-built fixture rows. */
  accountId?: string;
  kind: Kind;
  fx?: string;
  /** The statement description, when it adds anything beyond the
   * merchant name (set by both transaction mappers). Not the user's
   * own note — that is userNote. */
  note?: string;
  /** The user's own note on this transaction (txn_notes, keyed by
   * fingerprint), carried by the snapshot and /api/transactions when
   * one exists. Searchable in Activity. */
  userNote?: string;
  /** Money flowing IN (the store row's amount_minor was positive):
   * a transfer in, an investment withdrawal landing back, a refund.
   * Amounts on Txn are absolute, so this flag is the only direction
   * signal; set by both transaction mappers. */
  incoming?: boolean;
  /** The exact time of day as recorded on the stored timestamp,
   * "HH:MM". Absent when the row is date-only or carries the 00:00
   * date-only placeholder (see timeOfDay in txn-map); shown verbatim
   * in the detail sheet, never timezone-converted. */
  time?: string;
}

export interface UpcomingPayment {
  name: string;
  day: number; // day of month of `date`
  /** ISO YYYY-MM-DD of the next expected charge (the subscription
   *  detector's nextExpected). Sorting and labels use this, not `day`:
   *  the window can span the end of the current month and the next. */
  date: string;
  amount: number;
  owner: Owner;
}
export interface IncomeEntry {
  day: number;
  amount: number;
  owner: Exclude<Owner, "joint">;
  type: "Salary" | (string & {});
}
/** A recurring income stream detected server-side from the store's
 * income rows (see forecast.ts detectIncomeRegulars): a near-identical
 * amount landing on a monthly-ish cadence — salary-like. Amount is
 * pounds, positive; nextExpected is the ISO date of the next expected
 * landing and periodDays the median gap the forecast steps by. Only
 * streams still landing (last seen within 1.5 cadences of the store's
 * latest date) are carried. Moved-aside flows are never income here:
 * detection reads movement 'income' rows only. */
export interface IncomeRegular {
  name: string;
  amount: number;
  owner: Owner;
  nextExpected: string;
  periodDays: number;
}
export interface Sub {
  name: string; amount: number; freq: "Weekly" | "Monthly" | "Quarterly" | "Yearly"; last: string; card: string;
  /** "Cancelled" is a human override label, distinct from the
   * detector's own "Ended"; it behaves like Ended everywhere totals
   * and Coming up are computed. */
  owner: Owner; status: "Active" | "Ended" | "Cancelled"; note?: string;
  /** Number of charges in the recurring amount cluster that defines this sub. */
  charges: number;
  /** Store fingerprints of those cluster charges, in charge order. The
   *  detail view fetches exactly these rows, so its count always matches
   *  `charges` and unrelated same-merchant purchases never appear. */
  chargeIds: string[];
  /** The cluster charges summed per calendar month (pounds), ascending
   *  — the Subscriptions trend chart's raw material. Derived from the
   *  same charge rows the detail view shows; absent on hand-built subs. */
  chargeMonths?: { month: string; total: number }[];
  /** ISO date of the next expected charge; Active subs only, else null. */
  nextExpected: string | null;
  /** Median gap in days between the cluster's charges, rounded — the
   * cadence the forecast steps future occurrences by. Absent on
   * hand-built subs, whose readers fall back to the freq's nominal
   * period. */
  periodDays?: number;
  /** Store merchant names grouped into this sub (name variants). */
  variants: string[];
}
export interface CardItem {
  label: string; type: "Virtual" | "Physical"; last4: string; owner: Owner;
  status: "Active" | "Frozen" | "Replaced"; issued: string; frozen?: string; replacedBy?: string; account: string;
}
/** One GET /api/review-queue item, as fetched by the Settings sheet. */
export interface ReviewQueueItem {
  merchant: string;
  count: number;
  examples: string[];
  detail: string;
  suggestion: string | null;
}
export interface AccountInfo {
  name: string;
  owner: Owner;
  last: string;
  /** ISO date (YYYY-MM-DD) behind `last`, from the same selected ingest
   *  run — lets a view take the latest statement date across accounts. */
  lastDate: string;
  added: number;
  stale: boolean;
  /** Balance in minor units recorded by the selected ingest run, or
   *  null when that run recorded none (older stores, failed runs). A
   *  null balance is unknown — never render it as £0.00. When the
   *  selected run recorded none but the account has a balance anchor
   *  (see ingest/balance-anchors.ts), this carries the DERIVED
   *  balance instead and balanceSource says so. */
  balanceMinor: number | null;
  /** Currency of balanceMinor; null exactly when balanceMinor is null. */
  currency: string | null;
  /** Where balanceMinor came from: "statement" (recorded by the
   *  selected ingest run), "derived" (walked forward from a balance
   *  anchor), or null when there is no balance at all. Absent on
   *  hand-built fixtures. */
  balanceSource?: "statement" | "derived" | null;
  /** For a derived balance, the date it is as of: the account's
   *  latest transaction date, or the anchor date when no row
   *  postdates the anchor. Absent for statement balances, whose
   *  as-of is `lastDate`. */
  balanceAsOf?: string;
  /** Store identity behind the display name: the ingest account name
   * ("Pro", "Savings-9000000002") and the store person who holds it
   * ("zonito" | "nikhila"; Joint's rows are stored under "zonito").
   * Set by the snapshot builder; absent on hand-built fixtures. */
  accountId?: string;
  person?: string;
}
/** One spending category, built-in or user-created. Colour and icon are
 * the values every surface renders (theme token, hex or oklch colour;
 * an icon name from the shared set). System movement labels (Moved
 * aside, Fees, Interest, Transfer) are never categories. */
export interface CategoryDef { name: string; colour: string; icon: string; builtin: boolean }
/** The 9 built-in categories with the colour token and icon each has
 * always had. The server seeds its categories table from this list;
 * the client uses it as the fallback when a snapshot carries none. */
export const BUILTIN_CATEGORY_DEFS: CategoryDef[] = [
  { name: "Groceries", colour: "var(--cat-groceries)", icon: "shopping-basket", builtin: true },
  { name: "Eating out", colour: "var(--cat-eating-out)", icon: "utensils-crossed", builtin: true },
  { name: "Transport", colour: "var(--cat-transport)", icon: "bus", builtin: true },
  { name: "School", colour: "var(--cat-school)", icon: "graduation-cap", builtin: true },
  { name: "Home", colour: "var(--cat-home)", icon: "home", builtin: true },
  { name: "Subscriptions", colour: "var(--cat-subscriptions)", icon: "repeat", builtin: true },
  { name: "Holidays", colour: "var(--cat-holidays)", icon: "plane", builtin: true },
  { name: "Shopping", colour: "var(--cat-shopping)", icon: "shopping-bag", builtin: true },
  { name: "One-off", colour: "var(--cat-one-off)", icon: "receipt", builtin: true },
];
export type DocType = "Receipt" | "Bill" | "Invoice" | "Warranty";
export interface Doc {
  id: string; merchant: string; date: string; amount: number; type: DocType;
  txnId?: string; matchedLine?: string; path: string; warrantyEnds?: string; owner?: Owner;
}
export interface NewMerchant { merchant: string; category: Category; amount: number; date: string }

/** Full monthly spend history per category, from the precomputed
 * month_aggregates (GBP rows): the Categories timeline chart and the
 * Home trend read it straight from the snapshot, no fetch. `months` is
 * a continuous ascending YYYY-MM range; each series aligns with it. */
export interface MonthlyHistory {
  months: string[];
  series: Record<string, Partial<Record<Person, number[]>>>; // pounds
}

/** Monthly moved-aside totals (outgoing aside only, pounds) per person
 * view, from month_aggregates.aside_minor summed across categories,
 * aligned to the same month range as MonthlyHistory. Coach's floor
 * pace and typical-aside figures read this. Household follows the
 * stored-rows rule: the stored 'household' aggregates when they
 * exist, else the two people's rows summed — never both. */
export interface MonthlyAside {
  months: string[];
  totals: Partial<Record<Person, number[]>>; // pounds, aligned to months
}

/** Monthly money flow per person view, from the precomputed
 * month_aggregates (GBP rows): each month's total income (movement
 * 'income') and total spend (movement 'spend'), summed across
 * categories and aligned to the same month range as MonthlyHistory.
 * Moved-aside and internal transfers are separate movements and count
 * as NEITHER — money moved to savings is not income, and a transfer
 * between own accounts is not spending. Household follows the
 * stored-rows rule: the stored 'household' aggregates when they
 * exist, else the two people's rows summed — never both. */
export interface MonthlyFlow {
  months: string[];
  income: Partial<Record<Person, number[]>>; // pounds, aligned to months
  spend: Partial<Record<Person, number[]>>; // pounds, aligned to months
}

/** A human correction to subscription detection (subscription_overrides),
 * keyed by canonical merchant; label is the name as acted on, for display. */
export interface SubOverride {
  merchant: string;
  label: string;
  mode: "force" | "suppress" | "cancelled";
}

/** The household's own thresholds, configured in Settings and stored
 * server-side (see ingest/settings.ts): an Available floor to stay
 * above, an overall monthly budget, and a monthly budget per spending
 * category. Every value is optional — null / absent means no floor
 * and no budget, and the surfaces render exactly as they did before
 * thresholds existed. Amounts are minor units (pence). Thresholds are
 * always judged against the numbers of the view on screen. */
export interface AppSettings {
  availableFloorMinor: number | null;
  overallMonthlyBudgetMinor: number | null;
  categoryBudgets: Record<string, number>; // category name -> minor units
  /** Jev second opinions: on unless the household switched them off
   * in Settings (a missing stored value reads as on). */
  jevEnabled: boolean;
  /** The app's most recent live Jev call, for the Settings status
   * line; null until the first call is made. Cache serves never
   * update it — no call happened. */
  jevLastOutcome: { status: "ok" | "unavailable"; at: string } | null;
}
export const EMPTY_SETTINGS: AppSettings = {
  availableFloorMinor: null,
  overallMonthlyBudgetMinor: null,
  categoryBudgets: {},
  jevEnabled: true,
  jevLastOutcome: null,
};

export interface DataSnapshot {
  configured: boolean;
  monthKey: string; // current month, YYYY-MM ("" when no data)
  /** ISO date of the store's latest transaction, when the snapshot builder knows it. */
  latestDate?: string;
  months: { key: string; label: string }[]; // every month with transactions in the store, newest first
  txns: Txn[]; // current + previous month only; older months load on demand via /api/transactions
  income: IncomeEntry[]; // current month
  incomeRegulars: IncomeRegular[]; // detected recurring income streams, all history
  upcoming: UpcomingPayment[];
  subs: Sub[];
  subOverrides: SubOverride[];
  cards: CardItem[];
  migration: { moved: { name: string; seen: string }[]; waiting: { name: string; seen: string }[] };
  reviewTotal: number; // TRUE review-queue size; the sheet fetches the items itself from /api/review-queue
  accounts: AccountInfo[];
  categories: CategoryDef[]; // built-ins + user-created, from the store's categories table
  settings: AppSettings; // floors & budgets from the store's settings table
  docs: Doc[];
  typical: Record<string, Partial<Record<Person, number>>>;
  sparks: Record<string, Partial<Record<Person, number[]>>>;
  monthly: MonthlyHistory;
  asideMonthly: MonthlyAside;
  flowMonthly: MonthlyFlow;
  months6: string[];
  newMerchants: NewMerchant[];
  biggestOneOff: Partial<Record<Person, { merchant: string; amount: number; date: string }>>;
}

export const EMPTY_SNAPSHOT: DataSnapshot = {
  configured: false,
  monthKey: "",
  months: [],
  txns: [],
  income: [],
  incomeRegulars: [],
  upcoming: [],
  subs: [],
  subOverrides: [],
  cards: [],
  migration: { moved: [], waiting: [] },
  reviewTotal: 0,
  accounts: [],
  categories: [],
  settings: EMPTY_SETTINGS,
  docs: [],
  typical: {},
  sparks: {},
  monthly: { months: [], series: {} },
  asideMonthly: { months: [], totals: {} },
  flowMonthly: { months: [], income: {}, spend: {} },
  months6: [],
  newMerchants: [],
  biggestOneOff: {},
};

let snapshot: DataSnapshot = EMPTY_SNAPSHOT;

// Live arrays: contents are replaced by hydrateData, identity never changes,
// so every importer of these names sees the loaded snapshot.
export const TXNS: Txn[] = [];
export const ALL_TXNS: Txn[] = [];
export const INCOME: IncomeEntry[] = [];
export const INCOME_REGULARS: IncomeRegular[] = [];
export const UPCOMING: UpcomingPayment[] = [];
export const SUBS: Sub[] = [];
export const SUB_OVERRIDES: SubOverride[] = [];
export const CARDS: CardItem[] = [];
export const ACCOUNTS: AccountInfo[] = [];
export const CATEGORY_DEFS: CategoryDef[] = [];
export const DOCS: Doc[] = [];
export const MONTHS6: string[] = [];
export let MIGRATION: DataSnapshot["migration"] = { moved: [], waiting: [] };
export let MONTHLY_HISTORY: MonthlyHistory = { months: [], series: {} };
export let MONTHLY_ASIDE: MonthlyAside = { months: [], totals: {} };
export let MONTHLY_FLOW: MonthlyFlow = { months: [], income: {}, spend: {} };

function replace<T>(target: T[], next: T[]): void {
  target.length = 0;
  target.push(...next);
}

export function hydrateData(next: DataSnapshot): void {
  snapshot = next;
  replace(ALL_TXNS, next.txns);
  replace(TXNS, next.txns.filter((t) => t.monthKey === next.monthKey));
  replace(INCOME, next.income);
  replace(INCOME_REGULARS, next.incomeRegulars ?? []);
  replace(UPCOMING, next.upcoming);
  replace(SUBS, next.subs);
  replace(SUB_OVERRIDES, next.subOverrides ?? []);
  replace(CARDS, next.cards);
  replace(ACCOUNTS, next.accounts);
  replace(CATEGORY_DEFS, next.categories ?? []);
  replace(DOCS, next.docs);
  replace(MONTHS6, next.months6);
  MIGRATION = next.migration;
  MONTHLY_HISTORY = next.monthly ?? { months: [], series: {} };
  MONTHLY_ASIDE = next.asideMonthly ?? { months: [], totals: {} };
  MONTHLY_FLOW = next.flowMonthly ?? { months: [], income: {}, spend: {} };
}

export function getSnapshot(): DataSnapshot {
  return snapshot;
}
/**
 * The latest data date: the snapshot's recorded store maximum when it
 * carries one, otherwise the newest loaded transaction date ("" when
 * there is no data). Dates that fall before this are in the past as far
 * as the household's data is concerned.
 */
export const latestDataDate = (): string =>
  snapshot.latestDate ||
  ALL_TXNS.reduce((max, t) => (t.date > max ? t.date : max), "");
export const isConfigured = () => snapshot.configured;
export const currentMonthKey = () => snapshot.monthKey;
export const monthOptions = () => snapshot.months;
export const newMerchants = () => snapshot.newMerchants;
export const reviewTotal = () => snapshot.reviewTotal;
/** The configured floors & budgets (all unset by default). Defensive
 * fallback: a hand-built snapshot without the field reads as unset. */
export const appSettings = (): AppSettings => snapshot.settings ?? EMPTY_SETTINGS;
export const biggestOneOff = (p: Person) => snapshot.biggestOneOff[p] ?? null;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
function monthParts(key: string): { year: number; month: number } {
  const m = key.match(/^(\d{4})-(\d{2})$/);
  if (m) return { year: Number(m[1]), month: Number(m[2]) };
  return { year: 2026, month: 10 }; // display fallback only
}
export function currentMonthName(): string {
  if (!snapshot.monthKey) return "";
  return MONTH_NAMES[monthParts(snapshot.monthKey).month - 1] ?? "";
}
export function currentMonthLabel(): string {
  if (!snapshot.monthKey) return "No data yet";
  const { year, month } = monthParts(snapshot.monthKey);
  return `${MONTH_NAMES[month - 1]} ${year}`;
}
export function nextMonthName(): string {
  if (!snapshot.monthKey) return "";
  const { month } = monthParts(snapshot.monthKey);
  return MONTH_NAMES[month % 12] ?? "";
}

// Zonito's share of joint bills
const JOINT_SHARE = 0.5;

export function shareOf(txn: Txn, p: Person): number {
  if (p === "household") return txn.amount;
  if (txn.owner === "joint") return txn.amount * JOINT_SHARE;
  return txn.owner === p ? txn.amount : 0;
}

export function upcomingShare(payment: UpcomingPayment, person: Person): number {
  if (person === "household") return payment.amount;
  if (payment.owner === "joint") return payment.amount * JOINT_SHARE;
  return payment.owner === person ? payment.amount : 0;
}
export function upcomingFor(person: Person): UpcomingPayment[] {
  return UPCOMING.filter((payment) => upcomingShare(payment, person) > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || a.day - b.day);
}
export function upcomingTotal(person: Person): number {
  return UPCOMING.reduce((sum, payment) => sum + upcomingShare(payment, person), 0);
}

/** How many rows the Home "Coming up" panel lists before summarising. */
export const UPCOMING_PANEL_LIMIT = 5;
/**
 * What the Home "Coming up" panel accounts for: the first
 * UPCOMING_PANEL_LIMIT payments, plus the count and total share of the
 * rest. Invariant: visible shares + restTotal === total, so the rows
 * on screen (including the "and N more" summary row) always add up to
 * the headline total — never a silently sliced subset.
 */
export function upcomingPanel(person: Person): {
  visible: UpcomingPayment[];
  restCount: number;
  restTotal: number;
  total: number;
} {
  const all = upcomingFor(person);
  const visible = all.slice(0, UPCOMING_PANEL_LIMIT);
  const rest = all.slice(UPCOMING_PANEL_LIMIT);
  return {
    visible,
    restCount: rest.length,
    restTotal: rest.reduce((sum, payment) => sum + upcomingShare(payment, person), 0),
    total: upcomingTotal(person),
  };
}
export const upcomingDateLabel = (date: string) => {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short", day: "numeric", month: "short", timeZone: "UTC",
  }).format(d).replace(",", "");
};

export function txnsFor(p: Person) {
  return TXNS.filter((x) => shareOf(x, p) > 0);
}
export function txnsInMonth(monthKey: string): Txn[] {
  return ALL_TXNS.filter((t) => t.monthKey === monthKey);
}
export function spendTotal(p: Person) {
  return TXNS.filter((x) => x.kind === "spend").reduce((s, x) => s + shareOf(x, p), 0);
}
export function spendTotalInMonth(p: Person, monthKey: string) {
  return txnsInMonth(monthKey)
    .filter((x) => x.kind === "spend")
    .reduce((s, x) => s + shareOf(x, p), 0);
}
export function asideTotal(p: Person) {
  return TXNS.filter((x) => x.kind === "aside").reduce((s, x) => s + shareOf(x, p), 0);
}
export function incomeFor(person: Person): IncomeEntry[] {
  return INCOME.filter((entry) => person === "household" || entry.owner === person);
}
export function incomeTotal(person: Person): number {
  return incomeFor(person).reduce((sum, entry) => sum + entry.amount, 0);
}
export function byCategory(p: Person) {
  const m: Record<string, number> = {};
  for (const x of TXNS) if (x.kind === "spend") m[x.category] = (m[x.category] ?? 0) + shareOf(x, p);
  return categoryNames().map((c) => ({ category: c as Category, amount: m[c] ?? 0 })).filter((c) => c.amount > 0).sort((a, b) => b.amount - a.amount);
}

export function typicalFor(c: string, p: Person) {
  return snapshot.typical[c]?.[p] ?? 0;
}
export function typicalTotal(p: Person) {
  return categoryNames().reduce((s, c) => s + typicalFor(c, p), 0);
}
export function biggestChanges(p: Person) {
  const cur = Object.fromEntries(byCategory(p).map((c) => [c.category, c.amount]));
  return categoryNames().map((c) => ({ category: c as Category, now: cur[c] ?? 0, usual: typicalFor(c, p), diff: (cur[c] ?? 0) - typicalFor(c, p) }))
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
    .slice(0, 3);
}

export function sparkFor(c: string, p: Person): number[] {
  return snapshot.sparks[c]?.[p] ?? [];
}

/** The snapshot's monthly history shaped for the timeline charts: the
 * continuous month range plus one aligned series per category for this
 * person view. Series are padded/truncated to the range defensively;
 * the builder already emits them aligned. */
export function monthlyHistoryFor(p: Person): {
  months: string[];
  rows: { category: string; series: number[] }[];
} {
  const months = MONTHLY_HISTORY.months;
  const rows = Object.entries(MONTHLY_HISTORY.series)
    .map(([category, byPerson]) => {
      const raw = byPerson[p] ?? [];
      const series = months.map((_, i) => raw[i] ?? 0);
      return { category, series };
    })
    .filter((r) => r.series.some((v) => v > 0));
  rows.sort(
    (a, b) =>
      b.series.reduce((s, v) => s + v, 0) - a.series.reduce((s, v) => s + v, 0),
  );
  return { months, rows };
}

const PER_YEAR: Record<Sub["freq"], number> = { Weekly: 52, Monthly: 12, Quarterly: 4, Yearly: 1 };
export const yearlyOf = (s: Sub) => s.amount * PER_YEAR[s.freq];
export const monthlyOf = (s: Sub) => yearlyOf(s) / 12;

export const gbp = (n: number, dp = true) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: dp ? 2 : 0, maximumFractionDigits: dp ? 2 : 0 }).format(n);

/** Compact pounds for tight spaces (chart ticks, per-month net
 * figures at phone width): whole pounds under £1,000, then £k with
 * one decimal, trimmed ("£300", "£2.3k", "£14.8k", "£250k"). The
 * magnitude only — callers add any sign, and the exact figure always
 * remains available in full wherever this is used. */
export const gbpCompact = (n: number) => {
  const a = Math.abs(n);
  if (a < 1000) return gbp(a, false);
  const k = a / 1000;
  return `£${Number(k.toFixed(k >= 100 ? 0 : 1))}k`;
};

const WD = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const dayLabel = (d: number, long = false, monthKey?: string) => {
  const { year, month } = monthParts(monthKey ?? snapshot.monthKey);
  const w = WD[new Date(Date.UTC(year, month - 1, d)).getUTCDay()] ?? "";
  const mon = (MONTH_NAMES[month - 1] ?? "").slice(0, 3);
  return long ? `${w} ${d} ${MONTH_NAMES[month - 1]}` : `${w.slice(0, 3)} ${d} ${mon}`;
};
/** "3 Oct 2026" for an ISO date — used where a transaction's own month matters. */
export const dateLabel = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(d);
};

export const ownerName = (o: Owner) => (o === "joint" ? "Joint" : o === "zonito" ? "Zonito" : "Nikhila");

/**
 * The one place person/owner labels get their emoji: chrome and
 * labelling only, applied at render. 🏠 All (household) · 👨 Zonito ·
 * 👩 Nikhila · 🤝 Joint. Prose sentences keep using ownerName, and
 * data-bound strings (statement labels, store account names, API
 * payloads) never carry emoji.
 */
export const PERSON_CHIP: Record<Person | Owner, { emoji: string; label: string }> = {
  household: { emoji: "🏠", label: "All" },
  zonito: { emoji: "👨", label: "Zonito" },
  nikhila: { emoji: "👩", label: "Nikhila" },
  joint: { emoji: "🤝", label: "Joint" },
};

/** "🏠 All" / "👨 Zonito" / "👩 Nikhila" / "🤝 Joint". */
export const personLabel = (p: Person | Owner): string => {
  const chip = PERSON_CHIP[p];
  return `${chip.emoji} ${chip.label}`;
};

/** Format an amount in its own currency: gbp() for GBP (and for a
 *  missing code), Intl currency formatting otherwise. Foreign money is
 *  displayed in its own currency, never converted into GBP. */
export function formatMoney(amount: number, currency: string | null): string {
  if (!currency || currency === "GBP") return gbp(amount);
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

export interface CurrencyTotal { currency: string; total: number }
export interface AvailableSummary {
  /** Accounts in this view, ordered for the breakdown sheet: GBP
   *  accounts by balance descending (unknown balances last), then
   *  foreign accounts by currency and balance. */
  accounts: AccountInfo[];
  /** Sum of the view's GBP balances, or null when no included account
   *  has any recorded balance at all — "no data", distinct from a true
   *  £0 (balances exist, just none of them in GBP). */
  gbpTotal: number | null;
  /** Non-GBP balances summed per currency, non-zero totals only. */
  foreign: CurrencyTotal[];
  /** Latest statement date (ISO) across the included accounts, "" when
   *  the view has no accounts. */
  asOf: string;
}

/**
 * What is available to spend, per person view, from the snapshot's
 * account balances (each recorded by that account's latest real ingest
 * run, or derived from a balance anchor when no run could record one —
 * balanceSource on the account says which, and a derived balance counts
 * exactly like a recorded one). Household includes every account, Joint included; an
 * individual's view is their own accounts only — Joint money is the
 * household's, so it never inflates one person's headline. Accounts
 * whose balance is unknown are listed in the breakdown but excluded
 * from every total.
 */
export function availableFor(person: Person): AvailableSummary {
  const included = ACCOUNTS.filter(
    (a) => person === "household" || a.owner === person,
  );
  const group = (a: AccountInfo) => (a.currency === "GBP" || a.currency === null ? 0 : 1);
  const accounts = [...included].sort((x, y) => {
    const gx = group(x);
    const gy = group(y);
    if (gx !== gy) return gx - gy;
    if (gx === 1 && x.currency !== y.currency) {
      return String(x.currency).localeCompare(String(y.currency));
    }
    const bx = x.balanceMinor ?? Number.NEGATIVE_INFINITY;
    const by = y.balanceMinor ?? Number.NEGATIVE_INFINITY;
    return by - bx;
  });
  let gbpMinor = 0;
  let anyBalance = false;
  const foreignMinor = new Map<string, number>();
  for (const a of included) {
    if (a.balanceMinor === null || a.currency === null) continue;
    anyBalance = true;
    if (a.currency === "GBP") gbpMinor += a.balanceMinor;
    else foreignMinor.set(a.currency, (foreignMinor.get(a.currency) ?? 0) + a.balanceMinor);
  }
  const foreign = [...foreignMinor.entries()]
    .map(([currency, minor]) => ({ currency, total: minor / 100 }))
    .filter((f) => f.total !== 0)
    .sort((a, b) => a.currency.localeCompare(b.currency));
  // The view's as-of is the freshest balance date across accounts:
  // a derived balance speaks as of its own date (balanceAsOf), a
  // statement balance as of its run's statement date (lastDate).
  const asOf = included.reduce((m, a) => {
    const d = a.balanceAsOf ?? a.lastDate;
    return d > m ? d : m;
  }, "");
  return { accounts, gbpTotal: anyBalance ? gbpMinor / 100 : null, foreign, asOf };
}

export const docFor = (txnId: string, documents: readonly Doc[] = DOCS) => documents.find((d) => d.txnId === txnId);
export function receiptForTransaction(txn: Txn, extension: "pdf" | "jpg" | "png" = "pdf"): Doc {
  const [year = "2026", month = "10"] = txn.date.split("-");
  const merchant = txn.merchant.replace(/[^\p{L}\p{N}]/gu, "") || "Receipt";
  return {
    id: `receipt-${txn.id}`, merchant: txn.merchant, date: dateLabel(txn.date),
    amount: txn.amount, type: "Receipt", txnId: txn.id,
    path: `PersonalFinance/Documents/Receipts/${year}/${year}-${month}/${txn.date}_${merchant}_£${txn.amount.toFixed(2)}.${extension}`,
  };
}
export function attachReceipt(documents: readonly Doc[], receipt: Doc): Doc[] {
  const existing = (receipt.txnId ? docFor(receipt.txnId, documents) : undefined) ?? documents.find((d) => d.id === receipt.id);
  return existing
    ? documents.map((d) => d.id === existing.id ? { ...receipt, id: existing.id } : d)
    : [...documents, receipt];
}
export function detachReceipt(documents: readonly Doc[], txnId: string): Doc[] {
  return documents.map((d) => {
    if (d.txnId !== txnId) return d;
    const detached = { ...d };
    delete detached.txnId;
    delete detached.matchedLine;
    return detached;
  });
}
export const docName = (d: Doc) => d.path.split("/").at(-1) ?? "";
export const isMatched = (d: Doc) => !!(d.txnId || d.matchedLine);
export function documentOwner(doc: Doc): Owner | undefined {
  if (!isMatched(doc)) return undefined;
  return ALL_TXNS.find((t) => t.id === doc.txnId)?.owner ?? doc.owner;
}
export function documentsFor(documents: Doc[], person: Person): Doc[] {
  return documents.filter((doc) => {
    if (person === "household") return true;
    const owner = documentOwner(doc);
    return owner === person || owner === "joint";
  });
}

/** Last 7 days of the loaded month vs the 7 before, by transaction date. */
export function weeklySpend(person: Person) {
  const maxDay = TXNS.reduce((m, t) => Math.max(m, t.day), 0);
  const total = (start: number, end: number) => TXNS
    .filter((t) => t.kind === "spend" && t.day >= start && t.day <= end)
    .reduce((sum, t) => sum + shareOf(t, person), 0);
  return { thisWeek: total(maxDay - 6, maxDay), lastWeek: total(maxDay - 13, maxDay - 7) };
}
export function ocadoAnswer(person: Person) {
  const household = TXNS.filter((t) => t.kind === "spend" && /^ocado/i.test(t.merchant));
  const own = household.filter((t) => shareOf(t, person) > 0);
  const fallback = own.length === 0;
  const answerPerson = fallback ? "household" : person;
  const orders = fallback ? household : own;
  return { orders, fallback, total: orders.reduce((sum, t) => sum + shareOf(t, answerPerson), 0), answerPerson };
}
export function tripAnswer(person: Person, transactions: readonly Txn[] = TXNS) {
  const household = transactions.filter((t) => t.kind === "spend" && t.category === "Holidays");
  const own = household.filter((t) => shareOf(t, person) > 0);
  const fallback = own.length === 0;
  const answerPerson = fallback ? "household" : person;
  const orders = fallback ? household : own;
  return { orders, fallback, total: orders.reduce((sum, t) => sum + shareOf(t, answerPerson), 0), answerPerson };
}

// Fact-based accumulation, no advice: small weekday lunches (Pret).
export function weekdayLunchFact(person: Person = "household") {
  const lunches = TXNS.filter((x) => x.kind === "spend" && /^pret/i.test(x.merchant) && shareOf(x, person) > 0);
  const first = lunches[0];
  const each = first ? shareOf(first, person) : 0;
  const total = lunches.reduce((s, x) => s + shareOf(x, person), 0);
  return { count: lunches.length, each, total, year: Math.round(total * 12) };
}

function shiftMonthKey(key: string, delta: number): string {
  const { year, month } = monthParts(key);
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}
const monthNameOf = (key: string) => MONTH_NAMES[monthParts(key).month - 1] ?? "";

/** This view's monthly moved-aside totals, aligned to the aside
 * series' month range (missing entries read as 0). */
export function asideMonthlyFor(p: Person): { months: string[]; totals: number[] } {
  const months = MONTHLY_ASIDE.months;
  const raw = MONTHLY_ASIDE.totals[p] ?? [];
  return { months, totals: months.map((_, i) => raw[i] ?? 0) };
}

/** This view's monthly income and spend totals, aligned to the flow
 * series' month range (missing entries read as 0). */
export function flowMonthlyFor(p: Person): { months: string[]; income: number[]; spend: number[] } {
  const months = MONTHLY_FLOW.months;
  const inc = MONTHLY_FLOW.income[p] ?? [];
  const out = MONTHLY_FLOW.spend[p] ?? [];
  return {
    months,
    income: months.map((_, i) => inc[i] ?? 0),
    spend: months.map((_, i) => out[i] ?? 0),
  };
}

export interface FlowMonth {
  month: string; // YYYY-MM
  income: number; // pounds
  spend: number; // pounds
  gap: number; // income − spend, pounds
}

/** The last `count` calendar months ending at the store's current
 * month, as in/out/gap rows for the Home Income vs spending card.
 * The window is calendar-continuous: a month with no data in it
 * reads 0 in and 0 out (an honest empty month), never a skipped
 * month, and the window is never compressed to the months that
 * happen to have data. */
export function flowWindowFor(p: Person, count = 6): FlowMonth[] {
  const current = currentMonthKey();
  if (!current) return [];
  const { months, income, spend } = flowMonthlyFor(p);
  const at = new Map(months.map((m, i) => [m, i] as const));
  return Array.from({ length: count }, (_, k) => {
    const month = shiftMonthKey(current, k - (count - 1));
    const i = at.get(month);
    const inc = i !== undefined ? income[i]! : 0;
    const out = i !== undefined ? spend[i]! : 0;
    return { month, income: inc, spend: out, gap: inc - out };
  });
}

export function asideInMonth(p: Person, monthKey: string): number {
  const { months, totals } = asideMonthlyFor(p);
  const i = months.indexOf(monthKey);
  return i >= 0 ? totals[i]! : 0;
}
/**
 * The savings pace for the floor path: what was moved aside in the
 * latest COMPLETE month — the month before the current (still-open)
 * one — for this view. The current month never supplies the pace: it
 * may only be days old, which would understate it.
 */
export function asidePace(p: Person): { monthKey: string; total: number } {
  const prev = snapshot.monthKey ? shiftMonthKey(snapshot.monthKey, -1) : "";
  return { monthKey: prev, total: prev ? asideInMonth(p, prev) : 0 };
}
/** A typical month's moved-aside total: median of the previous 6
 * calendar months, the same window and median as the spend typicals. */
export function typicalAside(p: Person): number {
  if (!snapshot.monthKey) return 0;
  return medianOf(
    [1, 2, 3, 4, 5, 6].map((d) => asideInMonth(p, shiftMonthKey(snapshot.monthKey, -d))),
  );
}

/** Spends under £10 in the loaded month, this view's share — the same
 * definition as calculators.smallSpendFact, kept local because
 * calculators imports this module, not the other way round. */
function smallSpends(p: Person): { count: number; total: number } {
  let count = 0;
  let total = 0;
  for (const t of TXNS) {
    const share = shareOf(t, p);
    if (t.kind === "spend" && share > 0 && share < 10) {
      count += 1;
      total += share;
    }
  }
  return { count, total };
}

export interface CoachLever {
  impact: number;
  category?: string;
  kind: "budget" | "typical" | "small" | "pace";
  line: string;
}

/**
 * Every saving lever for this view, ranked by £ impact (largest
 * first): categories over their configured budget, categories running
 * above a usual month, the small-spends pile, and an above-typical
 * moved-aside pace. coachLines states the top two; Jev's coach
 * second opinion builds its lever choices from the same list, so the
 * two never disagree about what the levers are.
 */
export function coachLevers(person: Person): CoachLever[] {
  const settings = appSettings();
  const levers: CoachLever[] = [];
  const nowByCat = new Map(byCategory(person).map((c) => [c.category as string, c.amount]));
  const overBudget = new Set<string>();
  for (const [category, minor] of Object.entries(settings.categoryBudgets)) {
    const over = (nowByCat.get(category) ?? 0) - minor / 100;
    if (over > 0) {
      overBudget.add(category);
      levers.push({
        impact: over,
        category,
        kind: "budget",
        line: `${category} is ${gbp(over, false)} over its budget; back to budget adds ${gbp(over, false)}.`,
      });
    }
  }
  for (const name of categoryNames()) {
    if (overBudget.has(name)) continue;
    const usual = typicalFor(name, person);
    const diff = (nowByCat.get(name) ?? 0) - usual;
    if (usual > 0 && diff >= 50 && diff >= usual * 0.2) {
      levers.push({
        impact: diff,
        category: name,
        kind: "typical",
        line: `${name} ran ${gbp(diff, false)} above a usual month.`,
      });
    }
  }
  const small = smallSpends(person);
  if (small.total >= 40) {
    levers.push({
      impact: small.total,
      kind: "small",
      line: `Spends under £10 added up to ${gbp(small.total)} this month across ${small.count} spends.`,
    });
  }
  const asideNow = asideTotal(person);
  const asideTypical = typicalAside(person);
  if (asideNow > 0 && asideTypical > 0 && asideNow > asideTypical) {
    levers.push({
      impact: asideNow - asideTypical,
      kind: "pace",
      line: `You moved ${gbp(asideNow, false)} aside this month, ${gbp(asideNow - asideTypical, false)} more than a typical month.`,
    });
  }
  levers.sort((a, b) => b.impact - a.impact);
  return levers;
}

/**
 * The Coach lines, composed from the loaded month's facts, the
 * configured floor and budgets, and the aside series — every figure
 * computed here, never invented, and phrased as facts and options
 * only. Order: the floor position first (when a floor is set), then
 * the two biggest saving levers by £ impact, then the forward check
 * against next month's known regulars, then the standing facts (big
 * one-off, biggest change vs a usual month, moved aside) — a standing
 * fact is skipped only when a chosen lever already states it for the
 * same category or figure. With no floor and no budgets set, the
 * floor and budget lines simply never appear; nothing here ever asks
 * the user to configure one.
 */
export function coachLines(person: Person): string[] {
  if (person === "nikhila" && spendTotal("nikhila") === 0 && incomeTotal("nikhila") === 0) {
    return ["No statements from Nikhila yet — her view fills in as soon as her files are imported."];
  }
  const settings = appSettings();
  const available = availableFor(person).gbpTotal;
  const lines: string[] = [];

  // 1. Floor first: the gap and the path at last month's saving pace,
  // or the headroom when the floor is already met.
  if (settings.availableFloorMinor !== null && available !== null) {
    const floor = settings.availableFloorMinor / 100;
    if (available < floor) {
      const gap = floor - available;
      const pace = asidePace(person);
      if (pace.total > 0) {
        const months = Math.max(1, Math.ceil(gap / pace.total));
        lines.push(
          `${gbp(gap, false)} below your ${gbp(floor, false)} floor. You moved ${gbp(pace.total, false)} aside in ${monthNameOf(pace.monthKey)}; at that pace the floor is reached in about ${months} ${months === 1 ? "month" : "months"}.`,
        );
      } else {
        lines.push(
          `${gbp(gap, false)} below your ${gbp(floor, false)} floor. Nothing was moved aside in ${monthNameOf(pace.monthKey)}.`,
        );
      }
    } else {
      lines.push(`${gbp(available - floor, false)} above your floor.`);
    }
  }

  // 2. Levers, ranked by £ impact; the top two are stated.
  const chosen = coachLevers(person).slice(0, 2);
  lines.push(...chosen.map((l) => l.line));
  const leverCategories = new Set(
    chosen.map((l) => l.category).filter((c): c is string => typeof c === "string"),
  );
  const paceChosen = chosen.some((l) => l.kind === "pace");
  const asideNow = asideTotal(person);

  // 3. Forward check: next month's known regulars against Available.
  const upcoming = upcomingTotal(person);
  if (upcoming > 0 && available !== null) {
    lines.push(
      `${gbp(upcoming, false)} of ${nextMonthName()} regulars already known against ${gbp(available)} available.`,
    );
  }

  // 4. The standing facts, minus any a chosen lever already stated.
  const oneOff = biggestOneOff(person);
  if (oneOff && oneOff.amount >= 250) {
    lines.push(`The big one-off is ${oneOff.merchant} at ${gbp(oneOff.amount, false)} — tagged one-off, so it won't skew your usual month.`);
  }
  const [topChange] = biggestChanges(person);
  if (
    topChange &&
    Math.abs(topChange.diff) >= 25 &&
    topChange.usual > 0 &&
    !leverCategories.has(topChange.category)
  ) {
    lines.push(`${topChange.category} is ${gbp(Math.abs(topChange.diff), false)} ${topChange.diff > 0 ? "above" : "below"} a usual month.`);
  }
  if (asideNow > 0 && !paceChosen) {
    lines.push(`${gbp(asideNow, false)} was moved aside into savings and investments.`);
  }

  if (lines.length === 0) return ["A quiet month so far — nothing stands out against a usual month."];
  return lines;
}

/**
 * The Coach note for the Home card: the coachLines joined into the
 * card's single paragraph. Replaces the old hardcoded COACH_NOTE
 * strings (which described sample data: a Tenerife booking and a
 * solicitor that may not exist in real data).
 */
export function coachNote(person: Person): string {
  return coachLines(person).join(" ");
}
