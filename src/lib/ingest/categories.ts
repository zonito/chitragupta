import type Database from "better-sqlite3";
import { BUILTIN_CATEGORY_DEFS, type CategoryDef } from "../data";

/**
 * The categories table: the household's spending categories — the 9
 * built-ins plus any custom categories the users add (Settings, or
 * "New category…" in the Activity sheet). Merchant memory, the
 * classifier's allowed list and every category surface read from here,
 * so a custom category behaves exactly like a built-in one.
 *
 * System movement labels (Moved aside, Fees, Interest, Transfer) are
 * NOT categories: they can never be created, assigned or deleted here.
 */

export const SYSTEM_LABELS = [
  "Moved aside",
  "Fees",
  "Interest",
  "Transfer",
] as const;

export const BUILTIN_CATEGORY_NAMES: string[] = BUILTIN_CATEGORY_DEFS.map(
  (d) => d.name,
);

/** Icon names a category may carry; item-icons.tsx maps them to glyphs. */
export const CATEGORY_ICON_NAMES = [
  "shopping-basket",
  "utensils-crossed",
  "bus",
  "graduation-cap",
  "home",
  "repeat",
  "plane",
  "shopping-bag",
  "receipt",
  "tag",
  "star",
  "heart",
  "book-open",
  "music",
  "dumbbell",
  "paw-print",
  "gift",
  "wrench",
  "leaf",
  "wallet",
  "sparkles",
  "baby",
  "car",
  "coffee",
] as const;

/** Default colours for custom categories, handed out in order: hues
 * distinct from the nine built-in tokens, at the same mid lightness
 * the built-in chip inks use, so text on the 12% tint stays legible. */
export const CUSTOM_COLOUR_PALETTE = [
  "oklch(0.52 0.14 320)",
  "oklch(0.52 0.125 95)",
  "oklch(0.5 0.12 230)",
  "oklch(0.53 0.14 165)",
  "oklch(0.52 0.15 15)",
  "oklch(0.5 0.11 280)",
  "oklch(0.54 0.12 125)",
  "oklch(0.51 0.13 350)",
];

type CategoryRow = {
  name: string;
  colour: string;
  icon: string;
  builtin: number;
};

const rowToDef = (r: CategoryRow): CategoryDef => ({
  name: r.name,
  colour: r.colour,
  icon: r.icon,
  builtin: r.builtin === 1,
});

/** Seed the built-ins on first use. Reads stay cheap: one COUNT, and
 * the seed insert only ever runs on an empty table. */
export function ensureCategories(db: Database.Database): void {
  const count = db.prepare("SELECT COUNT(*) AS n FROM categories").get() as {
    n: number;
  };
  if (count.n > 0) return;
  const insert = db.prepare(
    "INSERT OR IGNORE INTO categories (name, colour, icon, builtin) VALUES (?, ?, ?, 1)",
  );
  const seed = db.transaction(() => {
    for (const def of BUILTIN_CATEGORY_DEFS) {
      insert.run(def.name, def.colour, def.icon);
    }
  });
  seed();
}

/** All categories: built-ins first, in their canonical order, then
 * customs alphabetically. */
export function listCategories(db: Database.Database): CategoryDef[] {
  ensureCategories(db);
  const rows = db
    .prepare("SELECT name, colour, icon, builtin FROM categories")
    .all() as CategoryRow[];
  const order = new Map(BUILTIN_CATEGORY_DEFS.map((d, i) => [d.name, i]));
  return rows.map(rowToDef).sort((a, b) => {
    if (a.builtin && b.builtin) {
      return (order.get(a.name) ?? 99) - (order.get(b.name) ?? 99);
    }
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export type CategoryResult =
  { ok: true; category: CategoryDef } | { ok: false; error: string };

const COLOUR_PATTERN =
  /^(#[0-9a-fA-F]{3,8}|oklch\([^)]{1,50}\)|var\(--[a-z0-9-]{1,40}\))$/;

export function createCategory(
  db: Database.Database,
  input: { name?: unknown; colour?: unknown; icon?: unknown },
): CategoryResult {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 1 || name.length > 40) {
    return { ok: false, error: "category name must be 1–40 characters" };
  }
  const existing = listCategories(db);
  const clash = existing.find(
    (c) => c.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) {
    return {
      ok: false,
      error: `a category named "${clash.name}" already exists`,
    };
  }
  if (
    (SYSTEM_LABELS as readonly string[]).some(
      (label) => label.toLowerCase() === name.toLowerCase(),
    )
  ) {
    return {
      ok: false,
      error: `"${name}" is a system movement label, not a category`,
    };
  }
  let colour: string;
  if (
    input.colour === undefined ||
    input.colour === null ||
    input.colour === ""
  ) {
    const customCount = existing.filter((c) => !c.builtin).length;
    colour = CUSTOM_COLOUR_PALETTE[customCount % CUSTOM_COLOUR_PALETTE.length]!;
  } else if (
    typeof input.colour === "string" &&
    COLOUR_PATTERN.test(input.colour.trim())
  ) {
    colour = input.colour.trim();
  } else {
    return {
      ok: false,
      error: "colour must be a hex value, an oklch() colour or a var(--token)",
    };
  }
  let icon = "tag";
  if (input.icon !== undefined && input.icon !== null && input.icon !== "") {
    if (
      typeof input.icon === "string" &&
      (CATEGORY_ICON_NAMES as readonly string[]).includes(input.icon)
    ) {
      icon = input.icon;
    } else {
      return {
        ok: false,
        error: `icon must be one of: ${CATEGORY_ICON_NAMES.join(", ")}`,
      };
    }
  }
  db.prepare(
    "INSERT INTO categories (name, colour, icon, builtin) VALUES (?, ?, ?, 0)",
  ).run(name, colour, icon);
  return { ok: true, category: { name, colour, icon, builtin: false } };
}

export function deleteCategory(
  db: Database.Database,
  rawName: unknown,
): { ok: true } | { ok: false; error: string } {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  const existing = listCategories(db);
  const found = existing.find(
    (c) => c.name.toLowerCase() === name.toLowerCase(),
  );
  if (!found) return { ok: false, error: `no category named "${name}"` };
  if (found.builtin) {
    return {
      ok: false,
      error: `"${found.name}" is a built-in category and cannot be removed`,
    };
  }
  const inMemory = db
    .prepare("SELECT COUNT(*) AS n FROM merchant_memory WHERE category = ?")
    .get(found.name) as { n: number };
  if (inMemory.n > 0) {
    return {
      ok: false,
      error: `"${found.name}" is still used by ${inMemory.n} merchant${inMemory.n === 1 ? "" : "s"} — reassign them first`,
    };
  }
  const inTransactions = db
    .prepare("SELECT COUNT(*) AS n FROM transactions WHERE category = ?")
    .get(found.name) as { n: number };
  if (inTransactions.n > 0) {
    return {
      ok: false,
      error: `"${found.name}" is still used by ${inTransactions.n} transaction${inTransactions.n === 1 ? "" : "s"} — reassign them first`,
    };
  }
  db.prepare("DELETE FROM categories WHERE name = ?").run(found.name);
  return { ok: true };
}

/**
 * Example merchants per custom category, for the classification
 * prompt: merchant_memory rows carrying the category, user corrections
 * first, up to 5 names each. This is how the classifier learns what a
 * custom category means.
 */
export function customCategoryExamples(
  db: Database.Database,
): { name: string; examples: string[] }[] {
  return listCategories(db)
    .filter((c) => !c.builtin)
    .map((c) => {
      const rows = db
        .prepare(
          `SELECT merchant FROM merchant_memory WHERE category = ?
           ORDER BY CASE WHEN source = 'user' THEN 0 ELSE 1 END, updated_at DESC
           LIMIT 5`,
        )
        .all(c.name) as { merchant: string }[];
      return { name: c.name, examples: rows.map((r) => r.merchant) };
    });
}
