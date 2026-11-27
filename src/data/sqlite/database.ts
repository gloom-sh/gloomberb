import { Database } from "bun:sqlite";
import { closeSync, openSync } from "fs";
import { logFailure } from "../../utils/log-failure";
import { restrictFileSync } from "../../utils/private-files";
import { createSqliteAccess, type SqliteAccess } from "./access";
import {
  CHECKPOINT_DELAY_MS,
  CHECKPOINTER_STUCK_AFTER_MS,
  LAZY_CHECKPOINT_DELAY_MS,
  SQLITE_BACKSTOP_AUTOCHECKPOINT_PAGES,
  SQLITE_DEFAULT_AUTOCHECKPOINT_PAGES,
  startWalCheckpointer,
  type WalCheckpointer,
  type WalCheckpointerOptions,
} from "./checkpointer";
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

  CREATE TABLE IF NOT EXISTS resource_pro_candidates (
    account TEXT NOT NULL,
    resource_id INTEGER NOT NULL,
    PRIMARY KEY (account, resource_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_resource_pro_id ON resource_pro_candidates (resource_id);
  CREATE TABLE IF NOT EXISTS resource_pro_backfill (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    covered_through INTEGER NOT NULL,
    legacy_end INTEGER NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS resource_pro_delete AFTER DELETE ON resource_cache
    BEGIN DELETE FROM resource_pro_candidates WHERE resource_id = OLD.rowid; END;

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

export interface SqliteDatabaseOptions {
  /**
   * The app's own connection, on the thread that answers the user (the
   * terminal, the desktop app's Bun process): statements do not wait on
   * another program's lock (see access.ts). Commands and tests wait it out.
   */
  interactive?: boolean;
  /**
   * Whether the app's commits wait while the checkpointer flushes (access.ts).
   * Windows only by default: elsewhere a commit does not wait on that flush.
   */
  holdCommitsDuringFlush?: boolean;
  /** Tests only: the WAL checkpointer's thread, how long it may go silent, and what it reports. */
  checkpointer?: WalCheckpointerOptions;
  /** Overrides the command's user-write lock deadline. */
  commandWriteWaitMs?: number;
}

export class SqliteDatabase {
  readonly connection: Database;
  readonly access: SqliteAccess;
  private readonly checkpointer: WalCheckpointer | null = null;

  constructor(dbPath: string, options: SqliteDatabaseOptions = {}) {
    const onDisk = dbPath !== "" && dbPath !== ":memory:" && !dbPath.startsWith("file:");
    // The database holds the Cloud session: created readable by the user
    // alone, so the WAL and shared-memory files SQLite makes beside it with
    // the same mode are too, and an older one made so.
    if (onDisk) {
      try {
        closeSync(openSync(dbPath, "a", 0o600));
        restrictFileSync(dbPath);
      } catch (error) {
        logFailure("data.sqlite", "Restricting the database file to its user failed")(error);
      }
    }
    this.connection = new Database(dbPath);
    // Opening waits for another program's lock: it happens once, and the app
    // has nothing to show without its data.
    this.connection.exec(`PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`);
    const journalMode = withSqliteBusyRetry("enable sqlite wal", () => (
      this.connection.query<{ journal_mode: string }, []>("PRAGMA journal_mode=WAL").get()?.journal_mode
    ));
    // In WAL mode commits can stop flushing the disk and the database stays
    // whole; user data is flushed soon after by the checkpointer, or per write
    // where it does not run (access.ts). Where WAL does not take (a network
    // share, an in-memory database), every commit flushes.
    const wal = journalMode?.toLowerCase() === "wal";
    if (onDisk && wal) {
      try {
        restrictFileSync(`${dbPath}-wal`);
        restrictFileSync(`${dbPath}-shm`);
      } catch (error) {
        logFailure("data.sqlite", "Restricting the database's WAL files to their user failed")(error);
      }
    }
    this.connection.exec(wal ? "PRAGMA synchronous=NORMAL" : "PRAGMA synchronous=FULL");
    withSqliteBusyRetry("initialize sqlite schema", () => {
      this.connection.exec(SCHEMA);
      if (!this.connection.query("SELECT 1 FROM resource_pro_backfill WHERE id = 1").get()) {
        this.connection.exec(`INSERT OR IGNORE INTO resource_pro_backfill
          SELECT 1, 0, COALESCE((SELECT MAX(rowid) FROM resource_cache), 0)`);
      }
    });
    // The app's statements choose how long to wait for a lock themselves.
    if (options.interactive) this.connection.exec("PRAGMA busy_timeout=0");
    // The app's commits leave copying the WAL into the database, and flushing
    // it, to a thread of its own, and only copy it themselves past a WAL ten
    // times the usual.
    let checkpointerRunning = false;
    if (options.interactive && wal && dbPath !== ":memory:") {
      this.checkpointer = startWalCheckpointer(dbPath, () => {
        checkpointerRunning = false;
        this.connection.exec(`PRAGMA wal_autocheckpoint=${SQLITE_DEFAULT_AUTOCHECKPOINT_PAGES}`);
      }, options.checkpointer);
      if (this.checkpointer) {
        checkpointerRunning = true;
        this.connection.exec(`PRAGMA wal_autocheckpoint=${SQLITE_BACKSTOP_AUTOCHECKPOINT_PAGES}`);
      }
    }
    const checkpointer = this.checkpointer;
    const holdCommits = checkpointer !== null && (options.holdCommitsDuringFlush ?? process.platform === "win32");
    this.access = createSqliteAccess(this.connection, {
      interactive: options.interactive,
      relaxedCommits: wal,
      commandWriteWaitMs: options.commandWriteWaitMs ?? (onDisk && wal && process.platform === "win32" ? CHECKPOINTER_STUCK_AFTER_MS : undefined),
      ...(checkpointer ? {
        onCommit: (kind) => checkpointer.nudge(kind === "user" ? CHECKPOINT_DELAY_MS : LAZY_CHECKPOINT_DELAY_MS),
        flushedElsewhere: () => checkpointerRunning,
        ...(holdCommits ? { holdCommits: () => checkpointer.busy() } : {}),
      } : {}),
    });
    if (holdCommits) checkpointer?.onIdle(() => this.access.resume());
  }

  close(): void {
    this.access.close();
    this.checkpointer?.close();
    this.connection.close();
  }
}
