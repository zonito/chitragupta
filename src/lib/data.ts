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

export interface Txn {
  id: string;
  day: number; // October 2026
  merchant: string;
  category: Category;
  amount: number;
  owner: Owner;
  account: string;
  kind: Kind;
  fx?: string;
  note?: string;
}

const t = (
  id: number,
  day: number,
  merchant: string,
  category: Category,
  amount: number,
  owner: Owner,
  account: string,
  extra: Partial<Txn> = {},
): Txn => ({ id: String(id), day, merchant, category, amount, owner, account, kind: "spend", ...extra });

const ZM = "Revolut Main · Zonito";
const ZP = "Revolut Pro · Zonito";
const NM = "Monzo Current · Nikhila";
const NA = "Amex Gold · Nikhila";
const JT = "Joint Bills · Revolut";

export const TXNS: Txn[] = [
  t(1, 1, "Enfield Council Tax", "Home", 186, "joint", JT),
  t(2, 1, "Octopus Energy", "Home", 138, "joint", JT),
  t(3, 1, "Zonito → Nikhila", "Transfer", 600, "zonito", ZM, { kind: "transfer", note: "Monthly household share" }),
  t(4, 1, "Revolut Savings", "Moved aside", 500, "zonito", ZM, { kind: "aside" }),
  t(5, 2, "Spotify Family", "Subscriptions", 19.99, "zonito", "Virtual ending 4412"),
  t(6, 2, "Vanguard ISA", "Moved aside", 400, "nikhila", NM, { kind: "aside" }),
  t(7, 3, "Ocado", "Groceries", 112.4, "nikhila", NM),
  t(8, 3, "TfL", "Transport", 28.4, "zonito", ZM),
  t(9, 4, "Pret A Manger", "Eating out", 7.45, "zonito", ZM),
  t(10, 4, "Hyperoptic", "Home", 30, "joint", JT),
  t(11, 5, "ParentPay · school lunches", "School", 68, "nikhila", NM),
  t(12, 5, "Netflix", "Subscriptions", 18.99, "zonito", "Virtual ending 4412", { note: "Was £17.99 last month" }),
  t(13, 6, "Dishoom King's Cross", "Eating out", 86.5, "zonito", ZP),
  t(14, 7, "Jet2 Holidays · Tenerife Feb", "Holidays", 1284, "zonito", ZM),
  t(15, 7, "Thames Water", "Home", 42, "joint", JT),
  t(16, 8, "iCloud+", "Subscriptions", 8.99, "nikhila", NA),
  t(17, 8, "TfL", "Transport", 18.6, "nikhila", NM),
  t(18, 9, "Franco Manca", "Eating out", 42, "nikhila", NA),
  t(19, 10, "Ocado", "Groceries", 98.75, "nikhila", NM),
  t(20, 10, "Waitrose", "Groceries", 18.4, "zonito", ZM),
  t(21, 11, "John Lewis", "Shopping", 64, "nikhila", NA),
  t(22, 12, "Pret A Manger", "Eating out", 7.45, "zonito", ZM),
  t(23, 12, "TfL", "Transport", 31.2, "zonito", ZM),
  t(24, 13, "Kingsley Napley LLP", "One-off", 1850, "zonito", ZM, { note: "Solicitor · lease review. Tagged one-off." }),
  t(25, 14, "Nikhila → Zonito", "Transfer", 120, "nikhila", NM, { kind: "transfer", note: "Half of Dishoom + theatre" }),
  t(26, 14, "Honest Burgers", "Eating out", 38.2, "zonito", ZP),
  t(27, 15, "Disney+", "Subscriptions", 9.99, "nikhila", NA),
  t(28, 15, "Trading 212", "Moved aside", 150, "zonito", ZM, { kind: "aside" }),
  t(29, 16, "Bright Kids after-school club", "School", 140, "zonito", ZM),
  t(30, 17, "Ocado", "Groceries", 124.1, "nikhila", NM),
  t(31, 18, "Bao Borough", "Eating out", 46.8, "zonito", ZP, { note: "First time here" }),
  t(32, 19, "TfL", "Transport", 26.8, "zonito", ZM),
  t(33, 19, "Deliveroo", "Eating out", 31.6, "nikhila", NM),
  t(34, 20, "Airbnb · Lisbon half-term", "Holidays", 271.4, "nikhila", NA, { fx: "€312.00 at 0.8699" }),
  t(35, 21, "PureGym", "Subscriptions", 34.99, "nikhila", NM),
  t(36, 22, "Amazon", "Shopping", 23.49, "zonito", ZM),
  t(37, 22, "Gail's Bakery", "Eating out", 14.8, "nikhila", NM),
  t(38, 23, "St Mary's · museum trip", "School", 25, "nikhila", NM),
  t(39, 24, "Ocado", "Groceries", 105.6, "nikhila", NM),
  t(40, 24, "TfL", "Transport", 22.4, "nikhila", NM),
  t(41, 14, "The Times", "Subscriptions", 26, "zonito", "Virtual ending 4412", { note: "Last charge on the old card" }),
  t(42, 26, "Uber", "Transport", 16.9, "nikhila", NA),
  t(43, 26, "Pret A Manger", "Eating out", 7.45, "zonito", ZM),
  t(44, 27, "Padella", "Eating out", 17.75, "zonito", ZP),
  t(45, 27, "Boots", "Shopping", 17.2, "nikhila", NM),
  t(46, 28, "TfL", "Transport", 33.1, "zonito", ZM),
  t(47, 28, "Tesco Express", "Groceries", 12.85, "zonito", ZM),
  t(48, 29, "Ocado", "Groceries", 89.3, "nikhila", NM),
];

// Zonito's share of joint bills
const JOINT_SHARE = 0.5;

export function shareOf(txn: Txn, p: Person): number {
  if (p === "household") return txn.amount;
  if (txn.owner === "joint") return txn.amount * JOINT_SHARE;
  return txn.owner === p ? txn.amount : 0;
}

export interface UpcomingPayment {
  name: string;
  day: number; // November 2026
  amount: number;
  owner: Owner;
}
export const UPCOMING: UpcomingPayment[] = [
  { name: "Enfield Council Tax", day: 1, amount: 186, owner: "joint" },
  { name: "Octopus Energy", day: 1, amount: 138, owner: "joint" },
  { name: "Spotify Family", day: 2, amount: 19.99, owner: "zonito" },
  { name: "Hyperoptic", day: 4, amount: 30, owner: "joint" },
  { name: "Netflix", day: 5, amount: 18.99, owner: "zonito" },
  { name: "ParentPay school lunches", day: 5, amount: 68, owner: "nikhila" },
  { name: "iCloud+", day: 8, amount: 8.99, owner: "nikhila" },
  { name: "Disney+", day: 15, amount: 9.99, owner: "nikhila" },
  { name: "Thames Water", day: 15, amount: 42, owner: "joint" },
  { name: "PureGym", day: 21, amount: 34.99, owner: "nikhila" },
  { name: "The Times", day: 14, amount: 26, owner: "zonito" },
];
export function upcomingShare(payment: UpcomingPayment, person: Person): number {
  if (person === "household") return payment.amount;
  if (payment.owner === "joint") return payment.amount * JOINT_SHARE;
  return payment.owner === person ? payment.amount : 0;
}
export function upcomingFor(person: Person): UpcomingPayment[] {
  return UPCOMING.filter((payment) => upcomingShare(payment, person) > 0).sort((a, b) => a.day - b.day);
}
export function upcomingTotal(person: Person): number {
  return UPCOMING.reduce((sum, payment) => sum + upcomingShare(payment, person), 0);
}
export const upcomingDateLabel = (day: number) => new Intl.DateTimeFormat("en-GB", {
  weekday: "short", day: "numeric", month: "short", timeZone: "UTC",
}).format(new Date(Date.UTC(2026, 10, day))).replace(",", "");

export function txnsFor(p: Person) {
  return TXNS.filter((x) => shareOf(x, p) > 0);
}

export function spendTotal(p: Person) {
  return TXNS.filter((x) => x.kind === "spend").reduce((s, x) => s + shareOf(x, p), 0);
}
export function asideTotal(p: Person) {
  return TXNS.filter((x) => x.kind === "aside").reduce((s, x) => s + shareOf(x, p), 0);
}
export interface IncomeEntry {
  day: number; // October 2026
  amount: number;
  owner: Exclude<Owner, "joint">;
  type: "Salary";
}
export const INCOME: IncomeEntry[] = [
  { day: 25, amount: 7240, owner: "zonito", type: "Salary" },
  { day: 28, amount: 4860, owner: "nikhila", type: "Salary" },
];
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

// Typical month (median of last 6), household, and Zonito's usual share
const TYPICAL: Record<string, number> = {
  Groceries: 540, "Eating out": 230, Transport: 200, School: 230, Home: 396,
  Subscriptions: 115, Holidays: 160, Shopping: 150, "One-off": 0,
};
const Z_SHARE: Record<string, number> = {
  Groceries: 0.1, "Eating out": 0.65, Transport: 0.62, School: 0.5, Home: 0.5,
  Subscriptions: 0.55, Holidays: 0.6, Shopping: 0.35, "One-off": 1,
};
export function typicalFor(c: string, p: Person) {
  const base = TYPICAL[c] ?? 0;
  if (p === "household") return base;
  const z = Z_SHARE[c] ?? 0.5;
  return Math.round(base * (p === "zonito" ? z : 1 - z));
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
  const u = typicalFor(c, p);
  const now = byCategory(p).find((x) => x.category === c)?.amount ?? 0;
  const shape = c === "Holidays" ? [0.2, 2.4, 0.3, 0.1, 0.6] : c === "One-off" ? [0, 0, 0, 0, 0] : [0.95, 1.08, 0.9, 1.02, 0.97];
  return [...shape.map((k) => Math.round(u * k)), Math.round(now)];
}
export const MONTHS6 = ["May", "Jun", "Jul", "Aug", "Sep", "Oct"];

export const COACH_NOTE: Record<Person, string> = {
  household: "Most of this month is two planned things: the Tenerife booking and the solicitor. Take those out and you're close to a normal month — eating out is the one quietly creeping up.",
  zonito: "The solicitor bill and the holiday deposit sit on your accounts, so your month looks big. Day to day you're steady — just more lunches and dinners out.",
  nikhila: "A calm month. Groceries are steady, the Lisbon Airbnb is the only stand-out, and you moved £400 aside into your ISA.",
};

export interface Sub {
  name: string; amount: number; freq: "Monthly" | "Yearly"; last: string; card: string;
  owner: Owner; status: ("Active" | "Price increased" | "Did not migrate")[]; note?: string;
}
export const SUBS: Sub[] = [
  { name: "Netflix", amount: 18.99, freq: "Monthly", last: "5 Oct", card: "Virtual ending 7730", owner: "zonito", status: ["Active", "Price increased"], note: "£17.99 → £18.99 · Moved to the new card" },
  { name: "Spotify Family", amount: 19.99, freq: "Monthly", last: "2 Oct", card: "Virtual ending 7730", owner: "zonito", status: ["Active"], note: "Moved to the new card" },
  { name: "The Times", amount: 26, freq: "Monthly", last: "14 Oct", card: "Virtual ending 4412", owner: "zonito", status: ["Did not migrate"], note: "Not seen on the new card yet" },
  { name: "PureGym", amount: 34.99, freq: "Monthly", last: "21 Oct", card: "Physical ending 2256", owner: "nikhila", status: ["Active"] },
  { name: "iCloud+ 2TB", amount: 8.99, freq: "Monthly", last: "8 Oct", card: "Amex ending 1009", owner: "nikhila", status: ["Active"] },
  { name: "Disney+", amount: 9.99, freq: "Monthly", last: "15 Oct", card: "Amex ending 1009", owner: "nikhila", status: ["Active"] },
  { name: "Amazon Prime", amount: 95, freq: "Yearly", last: "14 Mar", card: "Virtual ending 4412", owner: "zonito", status: ["Did not migrate"], note: "Renews 14 Mar" },
  { name: "Microsoft 365 Family", amount: 104.99, freq: "Yearly", last: "2 Jun", card: "Amex ending 1009", owner: "nikhila", status: ["Active"] },
];
export const monthlyOf = (s: Sub) => (s.freq === "Monthly" ? s.amount : s.amount / 12);
export const yearlyOf = (s: Sub) => (s.freq === "Monthly" ? s.amount * 12 : s.amount);

export interface CardItem {
  label: string; type: "Virtual" | "Physical"; last4: string; owner: Owner;
  status: "Active" | "Frozen" | "Replaced"; issued: string; frozen?: string; replacedBy?: string; account: string;
}
export const CARDS: CardItem[] = [
  { label: "Online spending", type: "Virtual", last4: "4412", owner: "zonito", status: "Frozen", issued: "3 Feb 2025", frozen: "15 Oct 2026", replacedBy: "Virtual ending 7730", account: "Revolut Main" },
  { label: "Online spending", type: "Virtual", last4: "7730", owner: "zonito", status: "Active", issued: "15 Oct 2026", account: "Revolut Main" },
  { label: "Everyday", type: "Physical", last4: "0981", owner: "zonito", status: "Active", issued: "9 Jan 2025", account: "Revolut Main" },
  { label: "Business", type: "Physical", last4: "6620", owner: "zonito", status: "Active", issued: "22 Apr 2025", account: "Revolut Pro" },
  { label: "Everyday", type: "Physical", last4: "5530", owner: "nikhila", status: "Replaced", issued: "11 May 2023", frozen: "2 Jul 2026", replacedBy: "Physical ending 2256", account: "Monzo Current" },
  { label: "Everyday", type: "Physical", last4: "2256", owner: "nikhila", status: "Active", issued: "2 Jul 2026", account: "Monzo Current" },
  { label: "Amex Gold", type: "Physical", last4: "1009", owner: "nikhila", status: "Active", issued: "18 Aug 2024", account: "Amex Gold" },
];
export const MIGRATION = {
  moved: [
    { name: "Netflix", seen: "Card details updated · 21 Oct" },
    { name: "Spotify Family", seen: "Card details updated · 27 Oct" },
    { name: "Uber One", seen: "Seen on 7730 · 19 Oct" },
  ],
  waiting: [
    { name: "The Times", seen: "Last charged 14 Oct, just before the freeze" },
    { name: "Amazon Prime", seen: "Yearly · next 14 Mar" },
    { name: "Notion", seen: "Last on 4412 · 2 Sep" },
  ],
};

// New or unrecognised merchants waiting for a quick review.
export interface MerchantReview { name: string; category: Category; detail: string }
export const MERCHANT_REVIEW: MerchantReview[] = [
  { name: "Bao Borough", category: "Eating out", detail: "£46.80 · 18 Oct · first time we've seen it" },
  { name: "Honest Burgers", category: "Eating out", detail: "£38.20 · 14 Oct · first time we've seen it" },
  { name: "Kingsley Napley LLP", category: "One-off", detail: "£1,850 · 13 Oct · solicitor · lease review" },
];

export const ACCOUNTS = [
  { name: "Revolut Main", owner: "zonito" as Owner, last: "28 Oct", added: 31, stale: false },
  { name: "Revolut Pro", owner: "zonito" as Owner, last: "28 Oct", added: 4, stale: false },
  { name: "Revolut Savings", owner: "zonito" as Owner, last: "28 Oct", added: 2, stale: false },
  { name: "Joint Bills", owner: "joint" as Owner, last: "27 Oct", added: 4, stale: false },
  { name: "Monzo Current", owner: "nikhila" as Owner, last: "26 Oct", added: 17, stale: false },
  { name: "Amex Gold", owner: "nikhila" as Owner, last: "6 Oct", added: 6, stale: true },
];

export const gbp = (n: number, dp = true) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: dp ? 2 : 0, maximumFractionDigits: dp ? 2 : 0 }).format(n);

const WD = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const dayLabel = (d: number, long = false) => {
  const w = WD[new Date(2026, 9, d).getDay()] ?? "";
  return long ? `${w} ${d} October` : `${w.slice(0, 3)} ${d} Oct`;
};

export const ownerName = (o: Owner) => (o === "joint" ? "Joint" : o === "zonito" ? "Zonito" : "Nikhila");

export type DocType = "Receipt" | "Bill" | "Invoice" | "Warranty";
export interface Doc {
  id: string; merchant: string; date: string; amount: number; type: DocType;
  txnId?: string; matchedLine?: string; path: string; warrantyEnds?: string; owner?: Owner;
}
export const DOCS: Doc[] = [
  { id: "d1", merchant: "Ikea", date: "14 Oct 2026", amount: 189.99, type: "Receipt", owner: "zonito", matchedLine: "Ikea · Wed 14 Oct · Revolut Main · Zonito", path: "PersonalFinance/Documents/Receipts/2026/2026-10/2026-10-14_Ikea_£189.99.pdf" },
  { id: "d2", merchant: "Octopus Energy", date: "1 Oct 2026", amount: 138, type: "Bill", txnId: "2", path: "PersonalFinance/Documents/Bills/2026/2026-10/2026-10-01_OctopusEnergy_£138.00.pdf" },
  { id: "d3", merchant: "Kingsley Napley LLP", date: "13 Oct 2026", amount: 1850, type: "Invoice", txnId: "24", path: "PersonalFinance/Documents/Invoices/2026/2026-10/2026-10-13_KingsleyNapley_£1850.00.pdf" },
  { id: "d4", merchant: "Samsung washing machine", date: "22 Mar 2026", amount: 549, type: "Warranty", owner: "nikhila", matchedLine: "Samsung · 22 Mar · Amex Gold · Nikhila", warrantyEnds: "Mar 2028", path: "PersonalFinance/Documents/Warranties/2026/2026-03-22_Samsung_£549.00.pdf" },
  { id: "d5", merchant: "John Lewis", date: "11 Oct 2026", amount: 64, type: "Receipt", txnId: "21", path: "PersonalFinance/Documents/Receipts/2026/2026-10/2026-10-11_JohnLewis_£64.00.pdf" },
  { id: "d6", merchant: "Boots Pharmacy", date: "19 Oct 2026", amount: 12.4, type: "Receipt", path: "PersonalFinance/Documents/Receipts/2026/2026-10/2026-10-19_BootsPharmacy_£12.40.pdf" },
];
export const docFor = (txnId: string, documents: readonly Doc[] = DOCS) => documents.find((d) => d.txnId === txnId);
export function receiptForTransaction(txn: Txn, extension: "pdf" | "jpg" | "png" = "pdf"): Doc {
  const date = `2026-10-${String(txn.day).padStart(2, "0")}`;
  const merchant = txn.merchant.replace(/[^\p{L}\p{N}]/gu, "") || "Receipt";
  return {
    id: `receipt-${txn.id}`, merchant: txn.merchant, date: `${txn.day} Oct 2026`,
    amount: txn.amount, type: "Receipt", txnId: txn.id,
    path: `PersonalFinance/Documents/Receipts/2026/2026-10/${date}_${merchant}_£${txn.amount.toFixed(2)}.${extension}`,
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
  return TXNS.find((t) => t.id === doc.txnId)?.owner ?? doc.owner;
}
export function documentsFor(documents: Doc[], person: Person): Doc[] {
  return documents.filter((doc) => {
    if (person === "household") return true;
    const owner = documentOwner(doc);
    return owner === person || owner === "joint";
  });
}
export function weeklySpend(person: Person) {
  const total = (start: number, end: number) => TXNS
    .filter((t) => t.kind === "spend" && t.day >= start && t.day <= end)
    .reduce((sum, t) => sum + shareOf(t, person), 0);
  return { thisWeek: total(23, 29), lastWeek: total(16, 22) };
}
export function ocadoAnswer(person: Person) {
  const household = TXNS.filter((t) => t.kind === "spend" && t.merchant === "Ocado");
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
  const lunches = TXNS.filter((x) => x.kind === "spend" && x.merchant === "Pret A Manger" && shareOf(x, person) > 0);
  const first = lunches[0];
  const each = first ? shareOf(first, person) : 0;
  const total = lunches.reduce((s, x) => s + shareOf(x, person), 0);
  return { count: lunches.length, each, total, year: Math.round(total * 12) };
}
