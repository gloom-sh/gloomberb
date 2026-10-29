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
/** A queued write's turn on a timer: short, so a timer tick is never a freeze of its own. */
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
 * it that still finds the lock taken is queued, retried in the background
 * and written at shutdown, and is never lost. Each store reads its own queued
 * writes back until they land.
 *
 * The connection commits with `synchronous=NORMAL`: in WAL mode a commit no
 * longer flushes the disk, and a power cut can cost the last few, never the
 * database. A write of user data flushes as before (`FULL`), which also
 * flushes everything committed ahead of it.
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
   * `settled` runs once it is written (or failed for another reason).
   */
  write(operationName: string, write: () => void, settled?: () => void): boolean;
  /** Writes what is still queued, waiting for the lock as long as shutdown allows. */
  close(): void;
}

export interface SqliteAccessOptions {
  /**
   * The app's own connection, on the thread that answers the user: no
   * statement waits on another program for more than a moment. Without it
   * (commands, tests) statements wait out the busy timeout and retry, as a
   * command has nothing better to do.
   */
  interactive?: boolean;
}

interface QueuedWrite {
  operationName: string;
  write: () => void;
  settled?: () => void;
}

function settle(write: { settled?: () => void }): void {
  try {
    write.settled?.();
  } catch (error) {
    logFailure("data.sqlite", "Settling a queued write failed")(error);
  }
}

export function createSqliteAccess(db: Database, options: SqliteAccessOptions = {}): SqliteAccess {
  /** Commits `write` with a full flush; the connection's own setting is NORMAL. */
  const durable = <T>(write: () => T): T => {
    if (db.inTransaction) return write();
    db.exec("PRAGMA synchronous=FULL");
    try {
      return write();
    } finally {
      db.exec("PRAGMA synchronous=NORMAL");
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
      write: (operationName, write, settled) => {
        try {
          durable(() => withSqliteBusyRetry(operationName, write));
        } finally {
          settled?.();
        }
        return true;
      },
      close: () => {},
    };
  }

  const queue: QueuedWrite[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retryMs = QUEUED_WRITE_FIRST_RETRY_MS;
  let closed = false;

  /** Writes the queue in order until it is empty or the lock is still taken; true when empty. */
  const drain = (waitMs: number): boolean => {
    while (queue.length > 0) {
      const next = queue[0]!;
      try {
        durable(() => withSqliteLockWait(next.operationName, next.write, waitMs));
      } catch (error) {
        if (isSqliteBusyError(error)) return false;
        logFailure("data.sqlite", "A queued write failed")(error);
      }
      queue.shift();
      settle(next);
    }
    return true;
  };

  const schedule = () => {
    if (timer || closed) return;
    timer = setTimeout(() => {
      timer = null;
      if (drain(QUEUED_WRITE_LOCK_WAIT_MS)) {
        retryMs = QUEUED_WRITE_FIRST_RETRY_MS;
        return;
      }
      retryMs = Math.min(QUEUED_WRITE_MAX_RETRY_MS, retryMs * 2);
      schedule();
    }, retryMs);
    (timer as { unref?: () => void }).unref?.();
  };

  const tryCache = <T>(operationName: string, statement: () => T): { value: T } | null => {
    try {
      return { value: withSqliteLockWait(operationName, statement, 0) };
    } catch (error) {
      if (!isSqliteBusyError(error)) throw error;
      logFailure("data.sqlite", "Skipped a cache statement: another program holds the database")(error);
      return null;
    }
  };

  return {
    readCache: (operationName, read) => tryCache(operationName, read)?.value ?? null,
    writeCache: (operationName, write) => tryCache(operationName, write) !== null,
    run: (operationName, statement) => withSqliteLockWait(operationName, statement, SQLITE_APP_READ_WAIT_MS),
    write: (operationName, write, settled) => {
      if (queue.length === 0) {
        try {
          durable(() => withSqliteLockWait(operationName, write, SQLITE_APP_WRITE_WAIT_MS));
          settle({ settled });
          return true;
        } catch (error) {
          if (!isSqliteBusyError(error)) {
            settle({ settled });
            throw error;
          }
        }
      }
      queue.push({ operationName, write, settled });
      if (queue.length === 1) sqliteLog.warn("A write is waiting for another program to release the database", { operation: operationName });
      schedule();
      return false;
    },
    close: () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (drain(CLOSE_LOCK_WAIT_MS)) return;
      sqliteLog.error("Writes could not be saved: another program kept the database locked", { count: queue.length });
      for (const write of queue.splice(0)) settle(write);
    },
  };
}
