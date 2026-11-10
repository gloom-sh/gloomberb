/**
 * A timeout this many times past its limit means the page was suspended, not
 * that the Bun process stalled. A page that is running fires the timer within
 * a second or two of its limit, and a hidden one within a minute.
 */
const SLEEP_TIMEOUT_FACTOR = 2;

/** What a desktop pane says when the app's background process did not answer its request in time. */
export const REQUEST_TIMED_OUT_MESSAGE = "Request timed out";

/** What a desktop pane says when its window had no way to reach the app's background process. */
export const CONNECTION_LOST_MESSAGE = "Connection lost";

/**
 * A call to the desktop's Bun process that did not complete in time: the
 * request timer ran out, or the window had no way to send it. `name` stays
 * "Error", so crash reports and filters see the same type as before.
 *
 * The message is what a pane shows, in plain words. `report` names the
 * request and what happened to it, for logs and crash reports only.
 */
export class RpcTimeoutError extends Error {
  readonly elapsedMs: number;
  readonly limitMs: number;
  readonly report: string;

  constructor(
    message: string,
    { elapsedMs, limitMs, report, cause }: { elapsedMs: number; limitMs: number; report: string; cause?: unknown },
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.elapsedMs = elapsedMs;
    this.limitMs = limitMs;
    this.report = report;
  }
}

/**
 * A timeout whose timer fired long after its limit. A laptop that sleeps
 * suspends the page, and on wake the timer runs once for a request the Bun
 * process already lost. Nothing the user did failed, so it is not a crash.
 */
export function isSleepRpcTimeout(error: unknown): boolean {
  return error instanceof RpcTimeoutError && error.elapsedMs > SLEEP_TIMEOUT_FACTOR * error.limitMs;
}
