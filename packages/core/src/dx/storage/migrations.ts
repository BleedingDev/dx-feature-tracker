import { upgradedEventJson } from "./upgrade-v1.js";

export interface StoreMigration {
  readonly rewriteEventBody: ((body: string) => string | null) | null;
  readonly statements: readonly string[];
  readonly version: number;
}

export const STORE_MIGRATIONS: readonly StoreMigration[] = [
  {
    rewriteEventBody: null,
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
  {
    rewriteEventBody: upgradedEventJson,
    statements: [],
    version: 2,
  },
  {
    rewriteEventBody: null,
    statements: [
      "CREATE TABLE IF NOT EXISTS usage_facts (fact_id TEXT PRIMARY KEY, harness TEXT, repo TEXT NOT NULL, branch TEXT, occurred_ms INTEGER, scope TEXT NOT NULL, body TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS usage_facts_time ON usage_facts (occurred_ms)",
      "CREATE TABLE IF NOT EXISTS usage_disagreements (fact_id TEXT NOT NULL, harness TEXT, field TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (fact_id, field))",
      "CREATE INDEX IF NOT EXISTS usage_disagreements_harness ON usage_disagreements (harness)",
      "CREATE TABLE IF NOT EXISTS usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS harness_cursors (ref_key TEXT PRIMARY KEY, harness TEXT NOT NULL, path TEXT NOT NULL, mtime_ms REAL, size INTEGER, cursor TEXT, last_event_id TEXT, updated_at TEXT NOT NULL)",
    ],
    version: 3,
  },
  {
    rewriteEventBody: null,
    statements: [
      "CREATE INDEX IF NOT EXISTS events_kind ON events (kind)",
      "DROP TABLE IF EXISTS usage_facts",
      "DROP TABLE IF EXISTS usage_disagreements",
      "DROP TABLE IF EXISTS usage_members",
      "DROP TABLE IF EXISTS usage_links",
      "DROP TABLE IF EXISTS usage_worktrees",
      "DROP TABLE IF EXISTS usage_unresolved",
      "DROP TABLE IF EXISTS usage_dirty",
      "DELETE FROM usage_meta",
      "CREATE TABLE usage_facts (fact_id TEXT PRIMARY KEY, component INTEGER NOT NULL, harness TEXT, repo TEXT NOT NULL, branch TEXT, scope TEXT NOT NULL, session_key TEXT, figure INTEGER NOT NULL, occurred_ms INTEGER, body TEXT NOT NULL)",
      "CREATE INDEX usage_facts_time ON usage_facts (occurred_ms)",
      "CREATE INDEX usage_facts_component ON usage_facts (component)",
      "CREATE INDEX usage_facts_session ON usage_facts (session_key, figure)",
      "CREATE TABLE usage_disagreements (fact_id TEXT NOT NULL, component INTEGER NOT NULL, harness TEXT, field TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (fact_id, field))",
      "CREATE INDEX usage_disagreements_component ON usage_disagreements (component)",
      "CREATE TABLE usage_members (seq INTEGER PRIMARY KEY, component INTEGER NOT NULL)",
      "CREATE INDEX usage_members_component ON usage_members (component)",
      "CREATE TABLE usage_links (link TEXT PRIMARY KEY, component INTEGER NOT NULL)",
      "CREATE INDEX usage_links_component ON usage_links (component)",
      "CREATE TABLE usage_worktrees (worktree TEXT NOT NULL, component INTEGER NOT NULL, PRIMARY KEY (worktree, component))",
      "CREATE INDEX usage_worktrees_component ON usage_worktrees (component)",
      "CREATE TABLE usage_unresolved (event_id TEXT PRIMARY KEY, component INTEGER NOT NULL)",
      "CREATE INDEX usage_unresolved_component ON usage_unresolved (component)",
      "CREATE TABLE usage_dirty (component INTEGER PRIMARY KEY)",
    ],
    version: 4,
  },
];

export const STORE_SCHEMA_VERSION = STORE_MIGRATIONS.length;
