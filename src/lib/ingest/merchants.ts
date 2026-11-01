import type Database from "better-sqlite3";
import { gbp } from "../data";
import { listCategories } from "./categories";

export type MerchantSource = "rules" | "claude-api" | "molang" | "user";

const CAT = {
  Groceries: "var(--cat-groceries)",
  EatingOut: "var(--cat-eating-out)",
  Transport: "var(--cat-transport)",
  School: "var(--cat-school)",
  Home: "var(--cat-home)",
  Subscriptions: "var(--cat-subscriptions)",
  Holidays: "var(--cat-holidays)",
  Shopping: "var(--cat-shopping)",
  OneOff: "var(--cat-one-off)",
} as const;

export const MERCHANT_RULES: { match: RegExp; category: string }[] = [
  {
    match:
      /ocado|waitrose|tesco|sainsbury|morrisons|asda|aldi|coop|co-op|lidl|milk & more|costco|a to z grocers|a z grocers|masala mart|kesari stor|mill hill mini|essentials mini|mahavir|meera express|veg chennai|shayona|srilalith/i,
    category: "Groceries",
  },
  {
    match:
      /\btfl\b|transport for london|paybyphone|ringgo|justpark|\bbp\b|\besso\b|tesla|trainline|gov\.uk|dvsa|driver & vehicle/i,
    category: "Transport",
  },
  { match: /\buber\b(?! eats)/i, category: "Transport" },
  { match: /uber eats|deliveroo/i, category: "Eating out" },
  {
    match: /parentpay|stage academy|atom learning|st mary/i,
    category: "School",
  },
  {
    match:
      /octopus|e\.on|thames water|hyperoptic|virgin media|council|barnet|brent|enfield|housekeep|emop|taskrabbit|b&q/i,
    category: "Home",
  },
  {
    match:
      /netflix|spotify|disney\+|youtube|amazon prime|prime video|icloud|google (workspace|cloud|play)|github|ifttt|medium|peloton|opencode|openai|excalidraw|bitwarden|101domain|metropcs|lebara/i,
    category: "Subscriptions",
  },
  {
    match:
      /jet2|airbnb|air india|haven|paultons|winter wonderland|flip out|vue( cinemas)?|cinema society/i,
    category: "Holidays",
  },
  {
    match:
      /amazon(?! prime| kindle)|ikea|john lewis|uniqlo|primark|sports direct|whsmith|temu|decathlon|nintendo|meta quest|apple\b/i,
    category: "Shopping",
  },
  {
    match:
      /pret|deliveroo|uber eats|costa|starbucks|chaiiwala|dishoom|franco manca|bao |honest burgers|mcdonald|pizza hut|subway|greggs|joe & the juice|victoria tavern|babel beer|karak chaii|eggfree|cakes? box|ckm cakes|gail/i,
    category: "Eating out",
  },
];

export function ruleCategory(merchant: string): string | null {
  for (const rule of MERCHANT_RULES) {
    if (rule.match.test(merchant)) return rule.category;
  }
  return null;
}

export function seedMerchantMemory(db: Database.Database): number {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO merchant_memory (merchant, category, colour, icon, source)
     VALUES (?, ?, ?, ?, 'rules')`,
  );
  const seen = new Set<string>();
  let added = 0;
  const merchants = db
    .prepare(
      `SELECT DISTINCT merchant FROM transactions WHERE movement IN ('spend','income')`,
    )
    .all() as { merchant: string }[];
  const apply = db.transaction((rows: { merchant: string }[]) => {
    for (const { merchant } of rows) {
      if (seen.has(merchant)) continue;
      seen.add(merchant);
      const category = ruleCategory(merchant);
      if (category) {
        added += Number(insert.run(merchant, category, null, null).changes);
      }
    }
  });
  apply(merchants);
  return added;
}

export function setMerchant(
  db: Database.Database,
  merchant: string,
  category: string,
  opts: {
    colour?: string | null;
    icon?: string | null;
    source?: MerchantSource;
  } = {},
): void {
  db.prepare(
    `INSERT INTO merchant_memory (merchant, category, colour, icon, source, updated_at)
     VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT (merchant) DO UPDATE SET
       category = excluded.category,
       colour = COALESCE(excluded.colour, merchant_memory.colour),
       icon = COALESCE(excluded.icon, merchant_memory.icon),
       source = excluded.source,
       updated_at = excluded.updated_at`,
  ).run(
    merchant,
    category,
    opts.colour ?? null,
    opts.icon ?? null,
    opts.source ?? "molang",
  );
}

/**
 * Labels that are not merchants at all and must never be sent to AI
 * classification or shown as review items, however they move. Kept
 * minimal and evidenced on the real data: "Investing money" (spend
 * ×63, an internal investment transfer), "Closing investment"
 * (income ×43), cashback credits and their reversals (Pro Cashback
 * income ×46, Pro Cashback Reversal spend ×4, Cashback, TOPCASHBACK),
 * and "Fidelity Investments" (spend ×5, an investment platform move,
 * not household spending).
 */
export const NEVER_CLASSIFY_PATTERNS: RegExp[] = [
  /^investing money$/i,
  /^closing investment$/i,
  /cashback/i,
  /^fidelity investments$/i,
];

type UnknownMerchantRow = { merchant: string; n: number; spend_n: number };

/**
 * Dismissals live in their own table, separate from merchant_memory:
 * dismissing a merchant in Settings is a "not now / noise" verdict,
 * not a classification, so it must never write a category, change a
 * transaction or move an aggregate. The table is created with the
 * store schema; this ensure keeps direct callers safe too.
 */
export function ensureDismissedTable(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS dismissed_merchants (
       merchant TEXT PRIMARY KEY,
       dismissed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     )`,
  );
}

/** Record a Settings dismissal. Merchant memory is NOT touched. */
export function dismissMerchant(db: Database.Database, merchant: string): void {
  ensureDismissedTable(db);
  db.prepare(
    `INSERT INTO dismissed_merchants (merchant, dismissed_at)
     VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT (merchant) DO UPDATE SET dismissed_at = excluded.dismissed_at`,
  ).run(merchant);
}

/**
 * The shared definition of the review queue: every distinct merchant
 * with spend/income rows that is not in merchant_memory and has not
 * been dismissed, ordered by row count. reviewQueue caps this list
 * for display and reviewQueueCount counts it in full — both derive
 * from this one query plus the one qualification filter below, so
 * the two can never drift apart.
 */
function unknownMerchantRows(db: Database.Database): UnknownMerchantRow[] {
  ensureDismissedTable(db);
  return db
    .prepare(
      `SELECT merchant, COUNT(*) AS n,
              SUM(CASE WHEN movement = 'spend' THEN 1 ELSE 0 END) AS spend_n
       FROM transactions
       WHERE movement IN ('spend','income')
         AND merchant NOT IN (SELECT merchant FROM merchant_memory)
         AND merchant NOT IN (SELECT merchant FROM dismissed_merchants)
       GROUP BY merchant ORDER BY n DESC`,
    )
    .all() as UnknownMerchantRow[];
}

/**
 * A merchant qualifies for review only when it is a real spending
 * label: it must have at least one 'spend' transaction (pure-income
 * and income+internal labels — salary senders, deposit labels,
 * cashback credits, investment payouts — are not merchants to
 * classify), and it must not match the never-classify list. The
 * count a qualifying merchant reports stays its full spend+income
 * row count.
 */
function qualifiesForReview(row: UnknownMerchantRow): boolean {
  if (row.spend_n <= 0) return false;
  return !NEVER_CLASSIFY_PATTERNS.some((p) => p.test(row.merchant));
}

function qualifiedUnknownMerchantRows(
  db: Database.Database,
): UnknownMerchantRow[] {
  return unknownMerchantRows(db).filter(qualifiesForReview);
}

/** The TRUE number of distinct unknown merchants (never capped). */
export function reviewQueueCount(db: Database.Database): number {
  return qualifiedUnknownMerchantRows(db).length;
}

export type ReviewQueueItem = {
  merchant: string;
  count: number;
  examples: string[];
  /** Plain-English spend detail, the format the snapshot used to build:
   * "£X · N charges · last <date>" from the merchant's spend rows. */
  detail: string;
  /**
   * The category the app currently resolves for this merchant, or null
   * when the only resolution is the movement fallback. Resolution is
   * exactly the snapshot/API order: an explicit transaction category
   * first, then merchant memory — either of those is a real label a
   * screen would show; a merchant whose rows carry neither resolves
   * per movement ('One-off' for spend, etc.), which is a fallback,
   * not a suggestion, so it surfaces as null rather than a forced
   * label. Only live categories (built-in or custom, from the
   * categories table) can be suggested: anything else cannot be
   * picked in the review sheet anyway.
   */
  suggestion: string | null;
};

const day10 = (iso: string) => iso.slice(0, 10);
function shortDayLabel(iso: string): string {
  const d = new Date(`${day10(iso)}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(d);
}

function reviewDetail(db: Database.Database, merchant: string): string {
  const stats = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(-amount_minor), 0) AS total, MAX(effective_date) AS last
       FROM transactions WHERE merchant = ? AND movement = 'spend'`,
    )
    .get(merchant) as { n: number; total: number; last: string | null };
  return stats.last
    ? `${gbp(stats.total / 100)} · ${stats.n} charge${stats.n === 1 ? "" : "s"} · last ${shortDayLabel(stats.last)}`
    : "No card payments — transfers or income only";
}

function reviewSuggestion(
  db: Database.Database,
  merchant: string,
  allowed: ReadonlySet<string>,
): string | null {
  const rows = db
    .prepare(
      `SELECT COALESCE(t.category, m.category) AS explicit
       FROM transactions t LEFT JOIN merchant_memory m ON m.merchant = t.merchant
       WHERE t.merchant = ?
       ORDER BY CASE WHEN t.movement = 'spend' THEN 0 ELSE 1 END,
                t.effective_date DESC`,
    )
    .all(merchant) as { explicit: string | null }[];
  for (const row of rows) {
    if (row.explicit && allowed.has(row.explicit)) {
      return row.explicit;
    }
  }
  return null;
}

export function reviewQueue(db: Database.Database): ReviewQueueItem[] {
  const rows = qualifiedUnknownMerchantRows(db).slice(0, 200);
  // Suggestions may name any live category, built-in or custom.
  const allowed = new Set(listCategories(db).map((c) => c.name));
  return rows.map((r) => {
    const examples = db
      .prepare(
        `SELECT description FROM transactions WHERE merchant = ? LIMIT 3`,
      )
      .all(r.merchant) as { description: string }[];
    return {
      merchant: r.merchant,
      count: r.n,
      examples: examples.map((e) => e.description),
      detail: reviewDetail(db, r.merchant),
      suggestion: reviewSuggestion(db, r.merchant, allowed),
    };
  });
}

export const MERCHANT_COLOURS: Record<string, string> = CAT;
