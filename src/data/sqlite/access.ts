import type { Database } from "bun:sqlite";
import { debugLog } from "../../utils/debug-log";
import { logFailure } from "../../utils/log-failure";
import { isSqliteBusyError, trySqliteBusyOperation, withSqliteBusyRetry, withSqliteLockWait } from "./retry";

/**
 * How long a write of the app waits for a lock another program holds (a
 * second copy of the app, the `gloom` command, a restart's old process). The
 * app runs SQLite on its only thread, so every millisecond of it is a frozen
 * window: past this, the write waits in a queue instead.
 */
const SQLITE_APP_WRITE_WAIT_MS = 200;
/**
 * Reads are not held up by another program's writes (WAL); only its opening
 * or recovering the database locks them out, briefly. A read that gives up
 * throws, and user data that does not load reads as gone, so it waits longer.
 */
const SQLITE_APP_READ_WAIT_MS = 1_000;
/**
 * How long one timer tick of the queue may hold the thread: queued writes
 * run in order until this is spent, and the rest wait for the next tick.
 */
const QUEUED_WRITE_TICK_BUDGET_MS = 40;
/** How long a queued write waits for the lock within a tick. */
const QUEUED_WRITE_LOCK_WAIT_MS = 25;
const QUEUED_WRITE_FIRST_RETRY_MS = 100;
const QUEUED_WRITE_MAX_RETRY_MS = 2_000;
/** At shutdown nothing waits on the thread any more, and what is queued has nowhere else to go. */
const CLOSE_LOCK_WAIT_MS = 5_000;

const sqliteLog = debugLog.createLogger("sqlite");

/**
 * How a store reaches its tables, by what the data is.
 *
 * The cache can always be fetched again, so it never waits: a read another
 * program has locked is a miss, and a write is skipped. User data (tickers
 * with their positions, plugin state, the session) waits briefly; a write of
 * it that still finds the lock taken is queued and retried in the background,
 * a little at a time, and each store reads its own queued writes back until
 * they land. At shutdown the app waits up to 5 s for the lock to write what
 * is left; a write still locked out then is lost, and the log says how many.
 *
 * In WAL mode the connection commits with `synchronous=NORMAL`: a commit no
 * longer flushes the disk, and a power cut can cost the last few, never the
 * database. A write of user data is flushed within a second or two by the
 * checkpointer's thread, which flushes the WAL before copying it (see
 * checkpointer.ts): on Windows the flush took the app's thread for seconds
 * at a time. Where nothing else flushes (a command, a checkpointer that
 * stopped), a write of user data flushes itself (`FULL`), and with it
 * everything committed ahead of it. Where WAL does not take (a network
 * share), every commit flushes.
 *
 * On the app's connection the cache writes of one turn of the event loop
 * share a transaction and commit together once the turn is over: a batch of
 * quotes, a list's touched rows. A write of user data, the queue and close
 * commit them first, so a user write still commits on its own and flushes.
 */
export interface SqliteAccess {
  /** A read of cached data; null when another program has it locked. */
  readCache<T>(operationName: string, read: () => T): T | null;
  /** A write of cached data; false when another program has it locked, and nothing was written. */
  writeCache(operationName: string, write: () => void): boolean;
  /** A read of user data, or a statement asked for by the user: waits for a lock up to a second, then throws. */
  run<T>(operationName: string, statement: () => T): T;
  /**
   * A write of user data. Returns whether it landed now; when it did not, it
   * is queued behind the lock, in order with every write after it, and
   * `settled` runs once it is written, superseded or given up on.
   */
  write(operationName: string, write: () => void, options?: SqliteWriteOptions): boolean;
  /**
   * One timer tick's worth of the queue: queued writes in order, for up to
   * the tick's budget. True when the queue is empty.
   */
  flush(): boolean;
  /** Writes what is still queued, waiting up to 5 s for the lock. */
  close(): void;
}

interface SqliteWriteOptions {
  /**
   * The one row this write replaces or deletes in full. A queued write with
   * the same key is superseded and dropped from the queue: the later write
   * is all that row will hold, and it runs after every write queued before.
   * A write that touches several rows has no key.
   */
  key?: string;
  settled?: () => void;
}

export interface SqliteAccessOptions {
  /**
   * The app's own connection, on the thread that answers the user: no
   * statement waits on another program for more than a moment. Without it
   * (commands, tests) statements wait out the busy timeout and retry, as a
   * command has nothing better to do.
   */
  interactive?: boolean;
  /**
   * The connection runs `synchronous=NORMAL`, as it does once WAL took, and
   * a write of user data switches to `FULL` for its commit. Without it the
   * connection's own level is left alone.
   */
  relaxedCommits?: boolean;
  /**
   * Whether another thread flushes the WAL soon after each commit (the
   * checkpointer, while it runs). A write of user data then commits at
   * `NORMAL` like the cache's.
   */
  flushedElsewhere?: () => boolean;
  /** After each commit of the app's connection (see checkpointer.ts). */
  onCommit?: () => void;
}

interface QueuedWrite {
  operationName: string;
  write: () => void;
  key?: string;
  settled?: () => void;
}

function settle(write: { settled?: () => void }): void {
  try {
    write.settled?.();
  } catch (error) {
    logFailure("data.sqlite", "Settling a queued write failed")(error);
  }
}

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export function createSqliteAccess(db: Database, options: SqliteAccessOptions = {}): SqliteAccess {
  /** The app's cache writes of this turn, committed together once it is over (interactive only). */
  let cacheBatch: ReturnType<typeof setTimeout> | null = null;
  /** User writes running now: a cache write inside one commits on its own, outside any batch. */
  let durableWrites = 0;

  const commitCacheBatch = (): void => {
    if (!cacheBatch) return;
    clearTimeout(cacheBatch);
    cacheBatch = null;
    // A failed statement can roll the whole transaction back; its writes are
    // gone then, which a cache can afford.
    if (!db.inTransaction) return;
    try {
      db.exec("COMMIT");
      options.onCommit?.();
    } catch (error) {
      logFailure("data.sqlite", "Committing cached writes failed")(error);
      if (!db.inTransaction) return;
      try {
        db.exec("ROLLBACK");
      } catch (rollbackError) {
        logFailure("data.sqlite", "Rolling back cached writes failed")(rollbackError);
      }
    }
  };

  /**
   * Commits `write` on its own, with a full flush when the connection's own
   * level is NORMAL and nothing else flushes it. The cache writes of the turn
   * commit first, wherever they came from (a queued write's `settled`, the
   * write before), so the user write never lands inside their batch, which
   * a failed commit rolls back whole.
   */
  const durable = <T>(write: () => T): T => {
    commitCacheBatch();
    durableWrites += 1;
    try {
      if (!options.relaxedCommits || db.inTransaction || options.flushedElsewhere?.()) return write();
      db.exec("PRAGMA synchronous=FULL");
      try {
        return write();
      } finally {
        db.exec("PRAGMA synchronous=NORMAL");
      }
    } finally {
      durableWrites -= 1;
    }
  };

  if (!options.interactive) {
    return {
      readCache: (operationName, read) => trySqliteBusyOperation(operationName, read),
      writeCache: (operationName, write) => trySqliteBusyOperation(operationName, () => {
        write();
        return true;
      }) ?? false,
      run: (operationName, statement) => withSqliteBusyRetry(operationName, statement),
      write: (operationName, write, writeOptions) => {
        try {
          durable(() => withSqliteBusyRetry(operationName, write));
        } finally {
          settle({ settled: writeOptions?.settled });
        }
        return true;
      },
      flush: () => true,
      close: () => {},
    };
  }

  const queue: QueuedWrite[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retryMs = QUEUED_WRITE_FIRST_RETRY_MS;
  let closed = false;

  /**
   * Writes the queue in order for up to `budgetMs`, each write waiting for
   * the lock no longer than `lockWaitMs` or what is left of the budget.
   * Says why it stopped: the queue is empty, the lock is still taken, or the
   * budget is spent. A write already running finishes past the budget.
   */
  const drain = (budgetMs: number, lockWaitMs: number): "empty" | "locked" | "budget" => {
    const startedAt = now();
    while (queue.length > 0) {
      const leftMs = budgetMs - (now() - startedAt);
      if (leftMs <= 0) return "budget";
      const next = queue[0]!;
      try {
        durable(() => withSqliteLockWait(next.operationName, next.write, Math.min(lockWaitMs, leftMs)));
        options.onCommit?.();
      } catch (error) {
        if (isSqliteBusyError(error)) return "locked";
        logFailure("data.sqlite", "A queued write failed")(error);
      }
      queue.shift();
      settle(next);
    }
    return "empty";
  };

  const flush = (): boolean => {
    const result = drain(QUEUED_WRITE_TICK_BUDGET_MS, QUEUED_WRITE_LOCK_WAIT_MS);
    if (result === "empty") {
      retryMs = QUEUED_WRITE_FIRST_RETRY_MS;
      return true;
    }
    // A spent budget comes back at once, after whatever else waits on the
    // thread; a lock still taken backs off.
    if (result === "locked") retryMs = Math.min(QUEUED_WRITE_MAX_RETRY_MS, retryMs * 2);
    schedule(result === "budget" ? 0 : retryMs);
    return false;
  };

  function schedule(delayMs: number): void {
    if (timer || closed) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, delayMs);
    (timer as { unref?: () => void }).unref?.();
  }

  const tryCache = <T>(operationName: string, statement: () => T): { value: T } | null => {
    try {
      return { value: withSqliteLockWait(operationName, statement, 0) };
    } catch (error) {
      if (!isSqliteBusyError(error)) throw error;
      logFailure("data.sqlite", "Skipped a cache statement: another program holds the database")(error);
      return null;
    }
  };

  /** False when another program holds the lock, and the write is skipped. */
  const joinCacheBatch = (): boolean => {
    // Inside a user write, a batch would hold that write's own statements until the turn is over.
    if (durableWrites > 0) return true;
    if (cacheBatch && db.inTransaction) return true;
    if (cacheBatch) commitCacheBatch();
    // Inside a transaction a statement of this connection opened, the write is part of it.
    if (db.inTransaction) return true;
    if (!tryCache("begin cached writes", () => db.exec("BEGIN IMMEDIATE"))) return false;
    cacheBatch = setTimeout(commitCacheBatch, 0);
    (cacheBatch as { unref?: () => void }).unref?.();
    return true;
  };

  return {
    readCache: (operationName, read) => tryCache(operationName, read)?.value ?? null,
    writeCache: (operationName, write) => joinCacheBatch() && tryCache(operationName, write) !== null,
    run: (operationName, statement) => withSqliteLockWait(operationName, statement, SQLITE_APP_READ_WAIT_MS),
    write: (operationName, write, writeOptions = {}) => {
      const { key, settled } = writeOptions;
      if (queue.length === 0) {
        try {
          durable(() => withSqliteLockWait(operationName, write, SQLITE_APP_WRITE_WAIT_MS));
          options.onCommit?.();
          settle({ settled });
          return true;
        } catch (error) {
          if (!isSqliteBusyError(error)) {
            settle({ settled });
            throw error;
          }
        }
      }
      if (key !== undefined) {
        const superseded = queue.findIndex((queued) => queued.key === key);
        if (superseded >= 0) settle(queue.splice(superseded, 1)[0]!);
      }
      queue.push({ operationName, write, key, settled });
      if (queue.length === 1) sqliteLog.warn("A write is waiting for another program to release the database", { operation: operationName });
      schedule(retryMs);
      return false;
    },
    flush,
    close: () => {
      if (closed) return;
      closed = true;
      commitCacheBatch();
      if (timer) clearTimeout(timer);
      timer = null;
      if (drain(CLOSE_LOCK_WAIT_MS, CLOSE_LOCK_WAIT_MS) === "empty") return;
      sqliteLog.error("Writes could not be saved: another program kept the database locked", { count: queue.length });
      for (const write of queue.splice(0)) settle(write);
    },
  };
}
