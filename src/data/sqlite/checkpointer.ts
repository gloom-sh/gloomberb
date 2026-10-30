import { resolve } from "path";
import { debugLog } from "../../utils/debug-log";
import { logFailure } from "../../utils/log-failure";

/**
 * Pages SQLite lets the WAL grow to before the connection that commits
 * copies them into the database itself. The app's connection keeps this as
 * a backstop only: the checkpointer below does the copying long before.
 */
export const SQLITE_DEFAULT_AUTOCHECKPOINT_PAGES = 1_000;
export const SQLITE_BACKSTOP_AUTOCHECKPOINT_PAGES = 10_000;
/** How soon after a commit the WAL is copied into the database, at most once per this. */
const CHECKPOINT_DELAY_MS = 1_000;
/** How long closing waits for the checkpointer to let go of the file (Windows cannot delete an open one). */
const CLOSE_WAIT_MS = 1_000;

const checkpointLog = debugLog.createLogger("sqlite");

/**
 * Runs on its own thread with its own connection. A passive checkpoint
 * copies what it can without waiting on a lock and never stops the app's
 * connection from reading or writing meanwhile. It flushes the WAL to disk
 * before copying it, and the database after: that flush is what makes the
 * app's writes of user data durable (access.ts), so it never runs with
 * `synchronous=OFF`.
 */
const WORKER_SOURCE = `
import { Database } from "bun:sqlite";
let db = null;
let closedFlag = null;
self.onmessage = (event) => {
  const message = event.data;
  if (message.type === "open") {
    closedFlag = new Int32Array(message.closed);
    try {
      db = new Database(message.path);
      db.exec("PRAGMA busy_timeout=1000");
      db.exec("PRAGMA synchronous=FULL");
      postMessage({ type: "ready" });
    } catch (error) {
      postMessage({ type: "failed", message: String(error && error.message || error) });
    }
    return;
  }
  if (message.type === "checkpoint") {
    if (!db) return;
    const startedAt = performance.now();
    try {
      const result = db.query("PRAGMA wal_checkpoint(PASSIVE)").get();
      postMessage({ type: "checkpointed", ms: performance.now() - startedAt, result });
    } catch (error) {
      postMessage({ type: "failed", message: String(error && error.message || error) });
    }
    return;
  }
  if (message.type === "close") {
    try {
      db?.close();
    } catch (error) {
      // Intentional ignore: the thread ends either way, and a failed close only leaves the handle to the OS.
    }
    db = null;
    if (closedFlag) {
      Atomics.store(closedFlag, 0, 1);
      Atomics.notify(closedFlag, 0);
    }
    self.close();
  }
};
`;

export interface WalCheckpointer {
  /** Writes were committed: the WAL is copied into the database shortly, off this thread. */
  nudge(): void;
  /** Stops the thread, waiting briefly for it to close its connection. */
  close(): void;
}

interface WorkerMessage {
  type: "ready" | "failed" | "checkpointed";
  message?: string;
  ms?: number;
  result?: { busy?: number; log?: number; checkpointed?: number };
}

/**
 * Copies the WAL into the database file on a thread of its own.
 *
 * SQLite does this inside a commit once the WAL passes 1,000 pages: one
 * write in a few hundred copies about 4 MB into the database and flushes the
 * disk, on the thread that asked for the write. That is the app's only
 * thread, and the copy takes 150 ms to a second on a laptop, more under an
 * antivirus. The app's connection leaves it to this instead (see
 * database.ts), along with flushing what it commits, and `onFailure` puts
 * SQLite's own schedule and the app's flushes back when the thread cannot
 * run.
 *
 * Null where there is no Worker to run it on.
 */
export function startWalCheckpointer(dbPath: string, onFailure: () => void): WalCheckpointer | null {
  if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL.createObjectURL !== "function") return null;
  let worker: Worker;
  const source = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "application/javascript" }));
  try {
    worker = new Worker(source);
  } catch (error) {
    checkpointLog.warn("Could not start the WAL checkpointer; commits checkpoint themselves", { error: String(error) });
    URL.revokeObjectURL(source);
    return null;
  }
  (worker as { unref?: () => void }).unref?.();
  const closed = new SharedArrayBuffer(4);
  let failed = false;
  let stopped = false;
  let running = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const fail = (reason: string) => {
    if (failed || stopped) return;
    failed = true;
    checkpointLog.warn("The WAL checkpointer stopped; commits checkpoint themselves", { reason });
    try {
      onFailure();
    } catch (error) {
      logFailure("data.sqlite", "Could not give commits their checkpoints back")(error);
    }
  };

  /** False when the worker is gone (a crashed thread throws on a message), which ends the checkpointer. */
  const post = (message: { type: string; path?: string; closed?: SharedArrayBuffer }): boolean => {
    try {
      worker.postMessage(message);
      return true;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  const terminate = () => {
    try {
      worker.terminate();
    } catch (error) {
      logFailure("data.sqlite", "Stopping the WAL checkpointer failed")(error);
    }
  };

  const schedule = () => {
    if (timer || running || failed || stopped) return;
    timer = setTimeout(() => {
      timer = null;
      if (failed || stopped) return;
      pending = false;
      running = post({ type: "checkpoint" });
    }, CHECKPOINT_DELAY_MS);
    (timer as { unref?: () => void }).unref?.();
  };

  worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
    const message = event.data;
    if (message.type === "ready") {
      URL.revokeObjectURL(source);
      return;
    }
    if (message.type === "failed") {
      fail(message.message ?? "unknown error");
      return;
    }
    if (message.type === "checkpointed") {
      running = false;
      if (pending) schedule();
    }
  };
  worker.onerror = (event) => {
    fail(event.message);
  };
  if (!post({ type: "open", path: resolve(dbPath), closed })) {
    terminate();
    URL.revokeObjectURL(source);
    return null;
  }

  return {
    nudge() {
      if (failed || stopped) return;
      pending = true;
      schedule();
    },
    close() {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = null;
      const asked = !failed && post({ type: "close" });
      stopped = true;
      if (!asked) {
        terminate();
        return;
      }
      Atomics.wait(new Int32Array(closed), 0, 0, CLOSE_WAIT_MS);
    },
  };
}
