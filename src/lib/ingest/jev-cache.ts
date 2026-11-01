import type Database from "better-sqlite3";

/**
 * Jev answer cache: one row per (surface, subject, state) question set
 * Jev has answered, in the store's `jev_cache` table. Jev's upstream
 * is intermittent (long unavailable stretches are normal), so answers
 * are served from here whenever a live call is not possible or not
 * needed; the table sits outside the ingest swap set (the rebuild
 * replaces only transactions and month_aggregates in the live file),
 * so cached opinions survive statement rebuilds by construction.
 *
 * Every function here is defensive: a cache failure must never break
 * the surface that asked — reads degrade to "no cache", writes are
 * best effort.
 */

export interface JevCacheEntry {
  key: string;
  surface: string;
  subject: string;
  answers: Record<string, string>;
  fetchedAt: string; // ISO timestamp of the live call that produced them
}

interface CacheRow {
  key: string;
  surface: string;
  subject: string;
  answers: string;
  fetched_at: string;
}

function toEntry(row: CacheRow): JevCacheEntry | null {
  try {
    const answers = JSON.parse(row.answers) as unknown;
    if (
      typeof answers !== "object" ||
      answers === null ||
      Array.isArray(answers)
    ) {
      return null;
    }
    return {
      key: row.key,
      surface: row.surface,
      subject: row.subject,
      answers: answers as Record<string, string>,
      fetchedAt: row.fetched_at,
    };
  } catch {
    return null;
  }
}

export function getJevCache(
  db: Database.Database,
  key: string,
): JevCacheEntry | null {
  try {
    const row = db
      .prepare(
        "SELECT key, surface, subject, answers, fetched_at FROM jev_cache WHERE key = ?",
      )
      .get(key) as CacheRow | undefined;
    return row ? toEntry(row) : null;
  } catch {
    return null;
  }
}

/** The most recent cached answer for a surface + subject, whatever
 * state produced it (the subscription detail shows the last opinion
 * with its date; a fresh ask replaces it). */
export function latestJevCache(
  db: Database.Database,
  surface: string,
  subject: string,
): JevCacheEntry | null {
  try {
    const row = db
      .prepare(
        `SELECT key, surface, subject, answers, fetched_at FROM jev_cache
         WHERE surface = ? AND subject = ?
         ORDER BY fetched_at DESC LIMIT 1`,
      )
      .get(surface, subject) as CacheRow | undefined;
    return row ? toEntry(row) : null;
  } catch {
    return null;
  }
}

export function putJevCache(db: Database.Database, entry: JevCacheEntry): void {
  try {
    db.prepare(
      `INSERT INTO jev_cache (key, surface, subject, answers, fetched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET
         surface = excluded.surface,
         subject = excluded.subject,
         answers = excluded.answers,
         fetched_at = excluded.fetched_at`,
    ).run(
      entry.key,
      entry.surface,
      entry.subject,
      JSON.stringify(entry.answers),
      entry.fetchedAt,
    );
  } catch {
    // best effort: an uncached answer is still shown this once
  }
}
