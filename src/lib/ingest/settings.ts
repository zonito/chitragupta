import type Database from "better-sqlite3";
import { EMPTY_SETTINGS, type AppSettings } from "../data";
import { listCategories } from "./categories";

/**
 * App settings: the Available floor and the monthly budgets (overall +
 * per category), all optional, all configured from the Settings screen,
 * plus the Jev second-opinion switch (on unless explicitly switched
 * off) and the persisted outcome of the app's last live Jev call.
 *
 * Storage is a small dedicated `settings` key/value table. Like the
 * categories table and merchant memory it sits entirely outside the
 * ingest swap set (the rebuild replaces only transactions,
 * month_aggregates, ingest_runs and assignment-prefixed meta keys),
 * so floors and budgets survive statement rebuilds by construction —
 * they are the household's own choices, not derivable from any CSV.
 *
 * Amounts are minor units (pence). A missing row means "not set":
 * no floor, no budget. Category budgets are one JSON object keyed by
 * category name; reads prune names that are no longer categories
 * (e.g. a deleted custom), so a stale budget can never linger.
 */

const FLOOR_KEY = "available_floor_minor";
const OVERALL_KEY = "overall_monthly_budget_minor";
const CATEGORY_BUDGETS_KEY = "category_budgets";
const JEV_ENABLED_KEY = "jev_enabled";
const JEV_LAST_OUTCOME_KEY = "jev_last_outcome";

function readMinor(db: Database.Database, key: string): number | null {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  if (!row) return null;
  const n = Number(row.value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function writeMinor(
  db: Database.Database,
  key: string,
  minor: number | null,
): void {
  if (minor === null) {
    db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  } else {
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ).run(key, String(minor));
  }
}

function readCategoryBudgets(db: Database.Database): Record<string, number> {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(CATEGORY_BUDGETS_KEY) as { value: string } | undefined;
  if (!row) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const known = new Set(listCategories(db).map((c) => c.name));
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (known.has(name) && Number.isInteger(value) && (value as number) >= 0) {
      out[name] = value as number;
    }
  }
  return out;
}

function writeCategoryBudgets(
  db: Database.Database,
  budgets: Record<string, number>,
): void {
  if (Object.keys(budgets).length === 0) {
    db.prepare("DELETE FROM settings WHERE key = ?").run(CATEGORY_BUDGETS_KEY);
  } else {
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ).run(CATEGORY_BUDGETS_KEY, JSON.stringify(budgets));
  }
}

/** Jev is on unless the household switched it off: a missing row is ON,
 * only an explicit "0" is off. */
function readJevEnabled(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(JEV_ENABLED_KEY) as { value: string } | undefined;
  return row?.value !== "0";
}

function readJevLastOutcome(
  db: Database.Database,
): AppSettings["jevLastOutcome"] {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(JEV_LAST_OUTCOME_KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as {
      status?: unknown;
      at?: unknown;
    };
    if (
      (parsed.status === "ok" || parsed.status === "unavailable") &&
      typeof parsed.at === "string"
    ) {
      return { status: parsed.status, at: parsed.at };
    }
  } catch {
    // a corrupt outcome row reads as "not called yet"
  }
  return null;
}

export function getSettings(db: Database.Database): AppSettings {
  try {
    return {
      availableFloorMinor: readMinor(db, FLOOR_KEY),
      overallMonthlyBudgetMinor: readMinor(db, OVERALL_KEY),
      categoryBudgets: readCategoryBudgets(db),
      jevEnabled: readJevEnabled(db),
      jevLastOutcome: readJevLastOutcome(db),
    };
  } catch {
    // A settings read must never take the snapshot down with it.
    return { ...EMPTY_SETTINGS, categoryBudgets: {} };
  }
}

/**
 * Record the outcome of the app's most recent live Jev call, for the
 * Settings status line. Written by the Jev client after every live
 * attempt (never for cache serves — no call happened). Best effort by
 * design: a failed write must never break the surface that called Jev.
 */
export function recordJevOutcome(
  db: Database.Database,
  status: "ok" | "unavailable",
): void {
  try {
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ).run(
      JEV_LAST_OUTCOME_KEY,
      JSON.stringify({ status, at: new Date().toISOString() }),
    );
  } catch {
    // status bookkeeping only; swallow
  }
}

export interface SettingsPatch {
  availableFloorMinor?: number | null;
  overallMonthlyBudgetMinor?: number | null;
  categoryBudgets?: Record<string, number | null>;
  jevEnabled?: boolean;
}

export type SettingsResult =
  { ok: true; settings: AppSettings } | { ok: false; error: string };

const isValidAmount = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * Apply a partial settings update: absent keys are left untouched, an
 * explicit null clears, a number sets. Every amount in the patch is
 * validated before anything is written (amounts are whole pence, £0
 * or more — a negative or fractional amount rejects the whole patch).
 * Category budget entries naming something that is not a category
 * (a typo, a since-deleted custom) are ignored; the valid entries
 * still apply.
 */
export function updateSettings(
  db: Database.Database,
  patch: SettingsPatch,
): SettingsResult {
  if (
    patch.availableFloorMinor !== undefined &&
    patch.availableFloorMinor !== null &&
    !isValidAmount(patch.availableFloorMinor)
  ) {
    return {
      ok: false,
      error: "available floor must be a whole number of pence, £0 or more",
    };
  }
  if (
    patch.overallMonthlyBudgetMinor !== undefined &&
    patch.overallMonthlyBudgetMinor !== null &&
    !isValidAmount(patch.overallMonthlyBudgetMinor)
  ) {
    return {
      ok: false,
      error: "overall budget must be a whole number of pence, £0 or more",
    };
  }
  if (patch.jevEnabled !== undefined && typeof patch.jevEnabled !== "boolean") {
    return { ok: false, error: "jevEnabled must be true or false" };
  }
  if (patch.categoryBudgets !== undefined) {
    if (
      typeof patch.categoryBudgets !== "object" ||
      patch.categoryBudgets === null ||
      Array.isArray(patch.categoryBudgets)
    ) {
      return { ok: false, error: "categoryBudgets must be an object" };
    }
    for (const [name, value] of Object.entries(patch.categoryBudgets)) {
      if (value !== null && !isValidAmount(value)) {
        return {
          ok: false,
          error: `budget for "${name}" must be a whole number of pence, £0 or more`,
        };
      }
    }
  }

  const apply = db.transaction(() => {
    if (patch.jevEnabled !== undefined) {
      db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      ).run(JEV_ENABLED_KEY, patch.jevEnabled ? "1" : "0");
    }
    if (patch.availableFloorMinor !== undefined) {
      writeMinor(db, FLOOR_KEY, patch.availableFloorMinor);
    }
    if (patch.overallMonthlyBudgetMinor !== undefined) {
      writeMinor(db, OVERALL_KEY, patch.overallMonthlyBudgetMinor);
    }
    if (patch.categoryBudgets !== undefined) {
      const known = new Set(listCategories(db).map((c) => c.name));
      const next = readCategoryBudgets(db);
      for (const [name, value] of Object.entries(patch.categoryBudgets)) {
        if (!known.has(name)) continue; // unknown name: ignore the entry
        if (value === null) delete next[name];
        else next[name] = value;
      }
      writeCategoryBudgets(db, next);
    }
  });
  apply();
  return { ok: true, settings: getSettings(db) };
}
