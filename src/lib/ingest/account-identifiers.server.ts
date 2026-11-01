import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Real statement account identifiers (the "Savings-<digits>" account
 * names) live OUTSIDE the repo, in a local JSON file the public
 * codebase never contains:
 *
 *   { "zonito": ["Savings-<digits>", "..."], "nikhila": ["...", ...] }
 *
 * Resolution order for the file:
 *   1. CHITRAGUPTA_ACCOUNT_IDENTIFIERS_FILE (explicit path), else
 *   2. <CHITRAGUPTA_DATA_DIR>/account-identifiers.json, else
 *   3. <dataDir argument>/account-identifiers.json when a caller
 *      passes the data dir explicitly (tests, tooling).
 *
 * The identifiers are statement-matching keys only: they name which
 * Originals file belongs to which savings account. Stored data keeps
 * the account names it already has; this file is what lets a FRESH
 * store discover the same accounts without the literals ever entering
 * source control. Persisted file assignments in the store are the
 * other, older source (see discoverFiles in ingest.ts) and win in
 * practice: this file only seeds discovery when no assignment has
 * been persisted yet.
 *
 * Any problem (missing file, bad JSON, wrong shape) reads as "no
 * configured accounts" — discovery then relies on persisted
 * assignments alone, exactly as it did before this file existed.
 */

export function accountIdentifiersPath(dataDir?: string): string | null {
  // An explicit data dir (tests, tooling, the live ingest) wins when it
  // actually holds the file; then the explicit env path; then the env
  // data dir.
  const candidates: string[] = [];
  if (dataDir) candidates.push(join(dataDir, "account-identifiers.json"));
  const explicit = process.env["CHITRAGUPTA_ACCOUNT_IDENTIFIERS_FILE"]?.trim();
  if (explicit) candidates.push(explicit);
  const fromEnv = process.env["CHITRAGUPTA_DATA_DIR"]?.trim();
  if (fromEnv) candidates.push(join(fromEnv, "account-identifiers.json"));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0] ?? null;
}

/** The configured statement account identifiers for one person. */
export function configuredAccounts(person: string, dataDir?: string): string[] {
  const path = accountIdentifiersPath(dataDir);
  if (!path || !existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return [];
    const list = (parsed as Record<string, unknown>)[person];
    if (!Array.isArray(list)) return [];
    return list.filter(
      (v): v is string => typeof v === "string" && v.trim().length > 0,
    );
  } catch {
    return [];
  }
}
