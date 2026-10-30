import {
  CATEGORIES,
  type DataSnapshot,
  type Txn,
} from "@/lib/data";

/**
 * The original Lovable sample dataset, kept ONLY as a test fixture. The UI
 * never loads this; production data arrives via hydrateData(snapshot) from
 * the server-built snapshot. Tests hydrate this in setup.ts so the pure
 * data helpers are exercised against a known month (October 2026).
 */

const t = (
  id: number,
  day: number,
  merchant: string,
  category: Txn["category"],
  amount: number,
  owner: Txn["owner"],
  account: string,
  extra: Partial<Txn> = {},
): Txn => ({
  id: String(id),
  date: `2026-10-${String(day).padStart(2, "0")}`,
  day,
  monthKey: "2026-10",
  merchant,
  category,
  amount,
  owner,
  account,
  kind: "spend",
  ...extra,
});

const ZM = "Revolut Main · Zonito";
const ZP = "Revolut Pro · Zonito";
const NM = "Monzo Current · Nikhila";
const NA = "Amex Gold · Nikhila";
const JT = "Joint Bills · Revolut";

export const SAMPLE_TXNS: Txn[] = [
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

const TYPICAL: Record<string, number> = {
  Groceries: 540, "Eating out": 230, Transport: 200, School: 230, Home: 396,
  Subscriptions: 115, Holidays: 160, Shopping: 150, "One-off": 0,
};
const Z_SHARE: Record<string, number> = {
  Groceries: 0.1, "Eating out": 0.65, Transport: 0.62, School: 0.5, Home: 0.5,
  Subscriptions: 0.55, Holidays: 0.6, Shopping: 0.35, "One-off": 1,
};

function buildTypical() {
  const typical: DataSnapshot["typical"] = {};
  const sparks: DataSnapshot["sparks"] = {};
  for (const c of CATEGORIES) {
    const base = TYPICAL[c] ?? 0;
    const z = Z_SHARE[c] ?? 0.5;
    typical[c] = {
      household: base,
      zonito: Math.round(base * z),
      nikhila: Math.round(base * (1 - z)),
    };
    const now = SAMPLE_TXNS.filter((x) => x.kind === "spend" && x.category === c)
      .reduce((s, x) => s + (x.owner === "joint" ? x.amount : x.amount), 0);
    const shape = c === "Holidays" ? [0.2, 2.4, 0.3, 0.1, 0.6] : c === "One-off" ? [0, 0, 0, 0, 0] : [0.95, 1.08, 0.9, 1.02, 0.97];
    sparks[c] = {
      household: [...shape.map((k) => Math.round(base * k)), Math.round(now)],
      zonito: [],
      nikhila: [],
    };
  }
  return { typical, sparks };
}

const { typical, sparks } = buildTypical();

export const SAMPLE_SNAPSHOT: DataSnapshot = {
  configured: true,
  monthKey: "2026-10",
  months: [
    { key: "2026-10", label: "October 2026" },
    { key: "2026-09", label: "September 2026" },
  ],
  txns: SAMPLE_TXNS,
  income: [
    { day: 25, amount: 7240, owner: "zonito", type: "Salary" },
    { day: 28, amount: 4860, owner: "nikhila", type: "Salary" },
  ],
  upcoming: [
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
  ],
  subs: [
    { name: "Netflix", amount: 18.99, freq: "Monthly", last: "5 Oct", card: "Virtual ending 7730", owner: "zonito", status: "Active", charges: 14, nextExpected: "2026-11-05", variants: ["Netflix"], note: "£17.99 → £18.99 · Moved to the new card", chargeIds: ["netflix-1", "netflix-2", "netflix-3", "netflix-4", "netflix-5", "netflix-6", "netflix-7", "netflix-8", "netflix-9", "netflix-10", "netflix-11", "netflix-12", "netflix-13", "netflix-14"] },
    { name: "Spotify Family", amount: 19.99, freq: "Monthly", last: "2 Oct", card: "Virtual ending 7730", owner: "zonito", status: "Active", charges: 11, nextExpected: "2026-11-02", variants: ["Spotify Family"], note: "Moved to the new card", chargeIds: ["spotify-family-1", "spotify-family-2", "spotify-family-3", "spotify-family-4", "spotify-family-5", "spotify-family-6", "spotify-family-7", "spotify-family-8", "spotify-family-9", "spotify-family-10", "spotify-family-11"] },
    { name: "The Times", amount: 26, freq: "Monthly", last: "14 Oct", card: "Virtual ending 4412", owner: "zonito", status: "Active", charges: 6, nextExpected: "2026-11-14", variants: ["The Times"], note: "Not seen on the new card yet", chargeIds: ["the-times-1", "the-times-2", "the-times-3", "the-times-4", "the-times-5", "the-times-6"] },
    { name: "PureGym", amount: 34.99, freq: "Monthly", last: "21 Oct", card: "Physical ending 2256", owner: "nikhila", status: "Active", charges: 9, nextExpected: "2026-11-21", variants: ["PureGym"], chargeIds: ["puregym-1", "puregym-2", "puregym-3", "puregym-4", "puregym-5", "puregym-6", "puregym-7", "puregym-8", "puregym-9"] },
    { name: "iCloud+ 2TB", amount: 8.99, freq: "Monthly", last: "8 Oct", card: "Amex ending 1009", owner: "nikhila", status: "Active", charges: 12, nextExpected: "2026-11-08", variants: ["iCloud+ 2TB"], chargeIds: ["icloud-2tb-1", "icloud-2tb-2", "icloud-2tb-3", "icloud-2tb-4", "icloud-2tb-5", "icloud-2tb-6", "icloud-2tb-7", "icloud-2tb-8", "icloud-2tb-9", "icloud-2tb-10", "icloud-2tb-11", "icloud-2tb-12"] },
    { name: "Disney+", amount: 9.99, freq: "Monthly", last: "15 Oct", card: "Amex ending 1009", owner: "nikhila", status: "Active", charges: 7, nextExpected: "2026-11-15", variants: ["Disney+"], chargeIds: ["disney-1", "disney-2", "disney-3", "disney-4", "disney-5", "disney-6", "disney-7"] },
    { name: "Amazon Prime", amount: 95, freq: "Yearly", last: "14 Mar", card: "Virtual ending 4412", owner: "zonito", status: "Active", charges: 3, nextExpected: "2027-03-14", variants: ["Amazon Prime"], note: "Renews 14 Mar", chargeIds: ["amazon-prime-1", "amazon-prime-2", "amazon-prime-3"] },
    { name: "Microsoft 365 Family", amount: 104.99, freq: "Yearly", last: "2 Jun", card: "Amex ending 1009", owner: "nikhila", status: "Active", charges: 2, nextExpected: "2027-06-02", variants: ["Microsoft 365 Family"], chargeIds: ["microsoft-365-family-1", "microsoft-365-family-2"] },
  ],
  cards: [
    { label: "Online spending", type: "Virtual", last4: "4412", owner: "zonito", status: "Frozen", issued: "3 Feb 2025", frozen: "15 Oct 2026", replacedBy: "Virtual ending 7730", account: "Revolut Main" },
    { label: "Online spending", type: "Virtual", last4: "7730", owner: "zonito", status: "Active", issued: "15 Oct 2026", account: "Revolut Main" },
    { label: "Everyday", type: "Physical", last4: "0981", owner: "zonito", status: "Active", issued: "9 Jan 2025", account: "Revolut Main" },
    { label: "Business", type: "Physical", last4: "6620", owner: "zonito", status: "Active", issued: "22 Apr 2025", account: "Revolut Pro" },
    { label: "Everyday", type: "Physical", last4: "5530", owner: "nikhila", status: "Replaced", issued: "11 May 2023", frozen: "2 Jul 2026", replacedBy: "Physical ending 2256", account: "Monzo Current" },
    { label: "Everyday", type: "Physical", last4: "2256", owner: "nikhila", status: "Active", issued: "2 Jul 2026", account: "Monzo Current" },
    { label: "Amex Gold", type: "Physical", last4: "1009", owner: "nikhila", status: "Active", issued: "18 Aug 2024", account: "Amex Gold" },
  ],
  migration: {
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
  },
  merchantReview: [
    { name: "Bao Borough", category: "Eating out", detail: "£46.80 · 18 Oct · first time we've seen it" },
    { name: "Honest Burgers", category: "Eating out", detail: "£38.20 · 14 Oct · first time we've seen it" },
    { name: "Kingsley Napley LLP", category: "One-off", detail: "£1,850 · 13 Oct · solicitor · lease review" },
  ],
  accounts: [
    { name: "Revolut Main", owner: "zonito", last: "28 Oct", added: 31, stale: false },
    { name: "Revolut Pro", owner: "zonito", last: "28 Oct", added: 4, stale: false },
    { name: "Revolut Savings", owner: "zonito", last: "28 Oct", added: 2, stale: false },
    { name: "Joint Bills", owner: "joint", last: "27 Oct", added: 4, stale: false },
    { name: "Monzo Current", owner: "nikhila", last: "26 Oct", added: 17, stale: false },
    { name: "Amex Gold", owner: "nikhila", last: "6 Oct", added: 6, stale: true },
  ],
  docs: [
    { id: "d1", merchant: "Ikea", date: "14 Oct 2026", amount: 189.99, type: "Receipt", owner: "zonito", matchedLine: "Ikea · Wed 14 Oct · Revolut Main · Zonito", path: "PersonalFinance/Documents/Receipts/2026/2026-10/2026-10-14_Ikea_£189.99.pdf" },
    { id: "d2", merchant: "Octopus Energy", date: "1 Oct 2026", amount: 138, type: "Bill", txnId: "2", path: "PersonalFinance/Documents/Bills/2026/2026-10/2026-10-01_OctopusEnergy_£138.00.pdf" },
    { id: "d3", merchant: "Kingsley Napley LLP", date: "13 Oct 2026", amount: 1850, type: "Invoice", txnId: "24", path: "PersonalFinance/Documents/Invoices/2026/2026-10/2026-10-13_KingsleyNapley_£1850.00.pdf" },
    { id: "d4", merchant: "Samsung washing machine", date: "22 Mar 2026", amount: 549, type: "Warranty", owner: "nikhila", matchedLine: "Samsung · 22 Mar · Amex Gold · Nikhila", warrantyEnds: "Mar 2028", path: "PersonalFinance/Documents/Warranties/2026/2026-03-22_Samsung_£549.00.pdf" },
    { id: "d5", merchant: "John Lewis", date: "11 Oct 2026", amount: 64, type: "Receipt", txnId: "21", path: "PersonalFinance/Documents/Receipts/2026/2026-10/2026-10-11_JohnLewis_£64.00.pdf" },
    { id: "d6", merchant: "Boots Pharmacy", date: "19 Oct 2026", amount: 12.4, type: "Receipt", path: "PersonalFinance/Documents/Receipts/2026/2026-10/2026-10-19_BootsPharmacy_£12.40.pdf" },
  ],
  typical,
  sparks,
  months6: ["May", "Jun", "Jul", "Aug", "Sep", "Oct"],
  newMerchants: [
    { merchant: "Bao Borough", category: "Eating out", amount: 46.8, date: "2026-10-18" },
  ],
  biggestOneOff: {
    household: { merchant: "Kingsley Napley LLP", amount: 1850, date: "2026-10-13" },
    zonito: { merchant: "Kingsley Napley LLP", amount: 1850, date: "2026-10-13" },
  },
};
