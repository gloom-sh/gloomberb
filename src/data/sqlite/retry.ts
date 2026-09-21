import { recordPerfSample } from "../../utils/perf-marks";

const SQLITE_BUSY_RETRY_ATTEMPTS = 4;
const SQLITE_BUSY_RETRY_INITIAL_DELAY_MS = 25;
const SQLITE_BUSY_RETRY_MAX_DELAY_MS = 250;
const SQLITE_BUSY_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export const SQLITE_BUSY_TIMEOUT_MS = 2000;
/**
 * SQLite is synchronous here, so a contended statement parks the whole app:
 * the busy handler waits inside the call, and the retry loop sleeps on top of
 * it. Anything above this is a freeze the user felt, and it is worth a line
 * naming the statement that caused it rather than leaving a mystery pause.
 */
const SQLITE_BLOCKING_REPORT_MS = 50;

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export interface SqliteBusyRetryOptions {
  attempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

export function isSqliteBusyError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; errno?: unknown; message?: unknown };
  const code = typeof candidate.code === "string" ? candidate.code.toUpperCase() : "";
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;
  if (candidate.errno === 5 || candidate.errno === 6) return true;
  const message = typeof candidate.message === "string" ? candidate.message.toLowerCase() : "";
  return message.includes("database is locked")
    || message.includes("database is busy")
    || message.includes("database table is locked");
}

function sleepSync(delayMs: number): void {
  if (delayMs <= 0) return;
  Atomics.wait(SQLITE_BUSY_SLEEP_BUFFER, 0, 0, delayMs);
}

export function withSqliteBusyRetry<T>(
  operationName: string,
  operation: () => T,
  options: SqliteBusyRetryOptions = {},
): T {
  const attempts = Math.max(1, Math.floor(options.attempts ?? SQLITE_BUSY_RETRY_ATTEMPTS));
  const maxDelayMs = Math.max(0, options.maxDelayMs ?? SQLITE_BUSY_RETRY_MAX_DELAY_MS);
  let delayMs = Math.max(0, options.initialDelayMs ?? SQLITE_BUSY_RETRY_INITIAL_DELAY_MS);
  const startedAt = now();
  const reportIfBlocking = (attempt: number) => {
    const elapsedMs = now() - startedAt;
    if (elapsedMs < SQLITE_BLOCKING_REPORT_MS) return;
    recordPerfSample("sqlite.blocked", elapsedMs, { operation: operationName, attempts: attempt });
  };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = operation();
      reportIfBlocking(attempt);
      return result;
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt >= attempts) {
        reportIfBlocking(attempt);
        throw error;
      }
      sleepSync(delayMs);
      delayMs = Math.min(maxDelayMs, delayMs === 0 ? maxDelayMs : delayMs * 2);
    }
  }

  throw new Error(`SQLite operation failed without an error: ${operationName}`);
}

export function trySqliteBusyOperation<T>(
  operationName: string,
  operation: () => T,
  options?: SqliteBusyRetryOptions,
): T | null {
  try {
    return withSqliteBusyRetry(operationName, operation, options);
  } catch (error) {
    if (isSqliteBusyError(error)) return null;
    throw error;
  }
}
