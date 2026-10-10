/** A timeout this many times past its limit means the machine slept through it. */
const SLEEP_TIMEOUT_FACTOR = 5;

/**
 * A call to the desktop's Bun process that did not complete in time: the
 * request timer ran out, or the bridge socket never opened. `name` stays
 * "Error", so crash reports and filters see the same type as before.
 */
export class RpcTimeoutError extends Error {
  readonly elapsedMs: number;
  readonly limitMs: number;

  constructor(message: string, { elapsedMs, limitMs, cause }: { elapsedMs: number; limitMs: number; cause?: unknown }) {
    super(message, cause === undefined ? undefined : { cause });
    this.elapsedMs = elapsedMs;
    this.limitMs = limitMs;
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
