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
export type Kind = "spend" | "transfer" | "aside";

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
  kind: Kind;
  fx?: string;
  note?: string;
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
export interface Sub {
  name: string; amount: number; freq: "Weekly" | "Monthly" | "Quarterly" | "Yearly"; last: string; card: string;
  owner: Owner; status: "Active" | "Ended"; note?: string;
  /** Number of charges in the recurring amount cluster that defines this sub. */
  charges: number;
  /** Store fingerprints of those cluster charges, in charge order. The
   *  detail view fetches exactly these rows, so its count always matches
   *  `charges` and unrelated same-merchant purchases never appear. */
  chargeIds: string[];
  /** ISO date of the next expected charge; Active subs only, else null. */
  nextExpected: string | null;
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
export interface AccountInfo { name: string; owner: Owner; last: string; added: number; stale: boolean }
export type DocType = "Receipt" | "Bill" | "Invoice" | "Warranty";
export interface Doc {
  id: string; merchant: string; date: string; amount: number; type: DocType;
  txnId?: string; matchedLine?: string; path: string; warrantyEnds?: string; owner?: Owner;
}
export interface NewMerchant { merchant: string; category: Category; amount: number; date: string }

export interface DataSnapshot {
  configured: boolean;
  monthKey: string; // current month, YYYY-MM ("" when no data)
  /** ISO date of the store's latest transaction, when the snapshot builder knows it. */
  latestDate?: string;
  months: { key: string; label: string }[]; // every month with transactions in the store, newest first
  txns: Txn[]; // current + previous month only; older months load on demand via /api/transactions
  income: IncomeEntry[]; // current month
  upcoming: UpcomingPayment[];
  subs: Sub[];
  cards: CardItem[];
  migration: { moved: { name: string; seen: string }[]; waiting: { name: string; seen: string }[] };
  reviewTotal: number; // TRUE review-queue size; the sheet fetches the items itself from /api/review-queue
  accounts: AccountInfo[];
  docs: Doc[];
  typical: Record<string, Partial<Record<Person, number>>>;
  sparks: Record<string, Partial<Record<Person, number[]>>>;
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
  upcoming: [],
  subs: [],
  cards: [],
  migration: { moved: [], waiting: [] },
  reviewTotal: 0,
  accounts: [],
  docs: [],
  typical: {},
  sparks: {},
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
export const UPCOMING: UpcomingPayment[] = [];
export const SUBS: Sub[] = [];
export const CARDS: CardItem[] = [];
export const ACCOUNTS: AccountInfo[] = [];
export const DOCS: Doc[] = [];
export const MONTHS6: string[] = [];
export let MIGRATION: DataSnapshot["migration"] = { moved: [], waiting: [] };

function replace<T>(target: T[], next: T[]): void {
  target.length = 0;
  target.push(...next);
}

export function hydrateData(next: DataSnapshot): void {
  snapshot = next;
  replace(ALL_TXNS, next.txns);
  replace(TXNS, next.txns.filter((t) => t.monthKey === next.monthKey));
  replace(INCOME, next.income);
  replace(UPCOMING, next.upcoming);
  replace(SUBS, next.subs);
  replace(CARDS, next.cards);
  replace(ACCOUNTS, next.accounts);
  replace(DOCS, next.docs);
  replace(MONTHS6, next.months6);
  MIGRATION = next.migration;
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
  return CATEGORIES.map((c) => ({ category: c, amount: m[c] ?? 0 })).filter((c) => c.amount > 0).sort((a, b) => b.amount - a.amount);
}

export function typicalFor(c: string, p: Person) {
  return snapshot.typical[c]?.[p] ?? 0;
}
export function typicalTotal(p: Person) {
  return CATEGORIES.reduce((s, c) => s + typicalFor(c, p), 0);
}
export function biggestChanges(p: Person) {
  const cur = Object.fromEntries(byCategory(p).map((c) => [c.category, c.amount]));
  return CATEGORIES.map((c) => ({ category: c, now: cur[c] ?? 0, usual: typicalFor(c, p), diff: (cur[c] ?? 0) - typicalFor(c, p) }))
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
    .slice(0, 3);
}

export function sparkFor(c: string, p: Person): number[] {
  return snapshot.sparks[c]?.[p] ?? [];
}

const PER_YEAR: Record<Sub["freq"], number> = { Weekly: 52, Monthly: 12, Quarterly: 4, Yearly: 1 };
export const yearlyOf = (s: Sub) => s.amount * PER_YEAR[s.freq];
export const monthlyOf = (s: Sub) => yearlyOf(s) / 12;

export const gbp = (n: number, dp = true) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: dp ? 2 : 0, maximumFractionDigits: dp ? 2 : 0 }).format(n);

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

/**
 * The Coach note, composed from the loaded month's facts — never invented.
 * Replaces the old hardcoded COACH_NOTE strings (which described sample
 * data: a Tenerife booking and a solicitor that may not exist in real data).
 */
export function coachNote(person: Person): string {
  if (person === "nikhila" && spendTotal("nikhila") === 0 && incomeTotal("nikhila") === 0) {
    return "No statements from Nikhila yet — her view fills in as soon as her files are imported.";
  }
  const facts: string[] = [];
  const oneOff = biggestOneOff(person);
  if (oneOff && oneOff.amount >= 250) {
    facts.push(`The big one-off is ${oneOff.merchant} at ${gbp(oneOff.amount, false)} — tagged one-off, so it won't skew your usual month.`);
  }
  const [topChange] = biggestChanges(person);
  if (topChange && Math.abs(topChange.diff) >= 25 && topChange.usual > 0) {
    facts.push(`${topChange.category} is ${gbp(Math.abs(topChange.diff), false)} ${topChange.diff > 0 ? "above" : "below"} a usual month.`);
  }
  const aside = asideTotal(person);
  if (aside > 0) facts.push(`${gbp(aside, false)} was moved aside into savings and investments.`);
  if (facts.length === 0) return "A quiet month so far — nothing stands out against a usual month.";
  return facts.join(" ");
}
