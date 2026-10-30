import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const SCHEMA_VERSION = 1;

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
  spend_minor INTEGER NOT NULL DEFAULT 0,
  income_minor INTEGER NOT NULL DEFAULT 0,
  aside_minor INTEGER NOT NULL DEFAULT 0,
  txn_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (person, year_month, category)
);
CREATE TABLE IF NOT EXISTS merchant_memory (
  merchant TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  colour TEXT,
  icon TEXT,
  source TEXT NOT NULL DEFAULT 'rules',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
`;

export function openStore(storeDir: string): Database.Database {
  mkdirSync(storeDir, { recursive: true });
  const db = new Database(join(storeDir, "chitragupta.sqlite"));
  db.exec(SCHEMA);
  const row = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  if (!row) {
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('schema_version', ?)",
    ).run(String(SCHEMA_VERSION));
  }
  return db;
}
