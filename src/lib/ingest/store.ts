import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const SCHEMA_VERSION = 2;

// Bump this whenever the ingest classification rules change (parse.ts
// classifyMovement, ASIDE_PATTERNS, merchant rule seeds). Ingest compares it
// against the version stamped in the store; a mismatch purges the derived
// transactions and rebuilds them from the source CSVs, so a store built by
// older rules can never keep stale rows (e.g. the phantom REVERTED spend a
// pre-fix store held forever under plain INSERT OR IGNORE).
export const RULES_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions (
  fingerprint TEXT PRIMARY KEY,
  person TEXT NOT NULL,
  account TEXT NOT NULL,
  effective_date TEXT NOT NULL,
  year_month TEXT NOT NULL,
  description TEXT NOT NULL,
  merchant TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  fee_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  balance_minor INTEGER NOT NULL,
  movement TEXT NOT NULL,
  category TEXT,
  source TEXT NOT NULL DEFAULT 'ingest',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_txns_month ON transactions (person, year_month, movement);
CREATE INDEX IF NOT EXISTS idx_txns_merchant ON transactions (merchant);
CREATE TABLE IF NOT EXISTS ingest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account TEXT NOT NULL,
  started_at TEXT NOT NULL,
  rows_seen INTEGER NOT NULL,
  rows_added INTEGER NOT NULL,
  balance_minor INTEGER,
  currency TEXT,
  discrepancy TEXT,
  finished_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS month_aggregates (
  person TEXT NOT NULL,
  year_month TEXT NOT NULL,
  category TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GBP',
  spend_minor INTEGER NOT NULL DEFAULT 0,
  income_minor INTEGER NOT NULL DEFAULT 0,
  aside_minor INTEGER NOT NULL DEFAULT 0,
  txn_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (person, year_month, category, currency)
);
CREATE TABLE IF NOT EXISTS merchant_memory (
  merchant TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  colour TEXT,
  icon TEXT,
  source TEXT NOT NULL DEFAULT 'rules',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS dismissed_merchants (
  merchant TEXT PRIMARY KEY,
  dismissed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  merchant TEXT NOT NULL,
  date TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  type TEXT NOT NULL,
  txn_id TEXT,
  path TEXT NOT NULL,
  warranty_ends TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_txn ON documents (txn_id);
CREATE INDEX IF NOT EXISTS idx_documents_path ON documents (path);
`;

export const STORE_FILENAME = "chitragupta.sqlite";

export function openStore(storeDir: string): Database.Database {
  return openStoreFile(join(storeDir, STORE_FILENAME));
}

/** Open (creating if needed) the store database at an exact file path. */
export function openStoreFile(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  const row = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  if (!row) {
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('schema_version', ?)",
    ).run(String(SCHEMA_VERSION));
  } else if (Number(row.value) !== SCHEMA_VERSION) {
    // month_aggregates is a derived cache and its shape changed at v2 (a
    // currency dimension, so foreign amounts are never face-value mixed
    // into GBP totals). Drop and recreate it empty; the API layer detects
    // the empty cache and recomputes it from transactions on first use.
    db.exec("DROP TABLE IF EXISTS month_aggregates;");
    db.exec(SCHEMA);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
      String(SCHEMA_VERSION),
    );
  }
  return db;
}
