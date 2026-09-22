import { Database } from "bun:sqlite";
import { SQLITE_BUSY_TIMEOUT_MS, withSqliteBusyRetry } from "./retry";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tickers (
    symbol TEXT PRIMARY KEY,
    metadata TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS resource_cache (
    namespace TEXT NOT NULL,
    kind TEXT NOT NULL,
    entity_key TEXT NOT NULL,
    variant_key TEXT NOT NULL DEFAULT '',
    source_key TEXT NOT NULL DEFAULT '',
    schema_version INTEGER NOT NULL,
    payload TEXT NOT NULL,
    provenance TEXT,
    fetched_at INTEGER NOT NULL,
    stale_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_accessed_at INTEGER NOT NULL,
    size_bytes INTEGER NOT NULL,
    PRIMARY KEY (namespace, kind, entity_key, variant_key, source_key)
  );

  CREATE INDEX IF NOT EXISTS idx_resource_cache_lookup
    ON resource_cache (namespace, kind, entity_key, expires_at, stale_at);

  CREATE INDEX IF NOT EXISTS idx_resource_cache_lru
    ON resource_cache (expires_at, last_accessed_at);

  -- The cache footprint is read on a schedule while the app is running, and
  -- the payloads make a table scan read the whole cache from disk: half a
  -- second of frozen UI on a 30MB cache. Covering the aggregate keeps the
  -- check to the size column alone.
  CREATE INDEX IF NOT EXISTS idx_resource_cache_size
    ON resource_cache (size_bytes);

  -- Least-recently-used order, so eviction reads candidates in batches
  -- instead of sorting every row in the cache.
  CREATE INDEX IF NOT EXISTS idx_resource_cache_recency
    ON resource_cache (last_accessed_at, fetched_at);

  CREATE TABLE IF NOT EXISTS plugin_state (
    plugin_id TEXT NOT NULL,
    key TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (plugin_id, key)
  );

  CREATE TABLE IF NOT EXISTS session_snapshots (
    session_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

export class SqliteDatabase {
  readonly connection: Database;

  constructor(dbPath: string) {
    this.connection = new Database(dbPath);
    this.connection.exec(`PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`);
    withSqliteBusyRetry("enable sqlite wal", () => {
      this.connection.exec("PRAGMA journal_mode=WAL");
    });
    withSqliteBusyRetry("initialize sqlite schema", () => {
      this.connection.exec(SCHEMA);
    });
  }

  close(): void {
    this.connection.close();
  }
}
