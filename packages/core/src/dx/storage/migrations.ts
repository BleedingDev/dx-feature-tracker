export interface StoreMigration {
  readonly statements: readonly string[];
  readonly version: number;
}

export const STORE_MIGRATIONS: readonly StoreMigration[] = [
  {
    statements: [
      "CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      "CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, adapter_id TEXT NOT NULL, kind TEXT NOT NULL, origin TEXT NOT NULL, flight_id TEXT, repo_common_dir TEXT, branch TEXT, occurred_at TEXT, observed_at TEXT NOT NULL, body TEXT NOT NULL)",
      "CREATE INDEX events_flight ON events (flight_id)",
      "CREATE INDEX events_branch ON events (repo_common_dir, branch)",
      "CREATE INDEX events_time ON events (occurred_at, observed_at)",
      "CREATE TABLE coverage (seq INTEGER PRIMARY KEY AUTOINCREMENT, adapter_id TEXT NOT NULL, flight_ids TEXT NOT NULL, repos TEXT NOT NULL, branches TEXT NOT NULL, body TEXT NOT NULL)",
      "CREATE INDEX coverage_adapter ON coverage (adapter_id)",
      "CREATE TABLE snapshots (seq INTEGER PRIMARY KEY AUTOINCREMENT, snapshot_id TEXT NOT NULL UNIQUE, selector_key TEXT NOT NULL, contract_digest TEXT NOT NULL, event_count INTEGER NOT NULL, manifest TEXT NOT NULL, coverage TEXT NOT NULL)",
      "CREATE INDEX snapshots_selector ON snapshots (selector_key)",
      "CREATE TABLE snapshot_events (snapshot_id TEXT NOT NULL, ordinal INTEGER NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY (snapshot_id, ordinal))",
    ],
    version: 1,
  },
];

export const STORE_SCHEMA_VERSION = STORE_MIGRATIONS.length;
