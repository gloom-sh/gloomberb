export interface RpcClockSample {
  wallMs: number;
  elapsedMs: number;
  awakeMs: number;
}

export const RPC_CLOCK_FRESHNESS_MS = 1_000;
const CLOCK_SLOP_MS = 100;
const MIN_SLEEP_MS = 5_000;

/** A conservative upper bound on the request's awake time, only when the clocks also show sleep. */
export function rpcAwakeTimeBound(
  startedAt: number,
  timedOutAt: number,
  before: RpcClockSample | null,
  after: RpcClockSample | null,
): number | null {
  if (!before || !after || ![startedAt, timedOutAt, before.wallMs, after.wallMs, before.elapsedMs, after.elapsedMs, before.awakeMs, after.awakeMs].every(Number.isFinite)) return null;
  if (timedOutAt <= startedAt || Math.abs(before.wallMs - startedAt) > RPC_CLOCK_FRESHNESS_MS
    || after.wallMs < timedOutAt || after.wallMs - timedOutAt > RPC_CLOCK_FRESHNESS_MS) return null;
  if (before.awakeMs < 0 || before.elapsedMs < 0) return null;
  const elapsed = after.elapsedMs - before.elapsedMs;
  const awake = after.awakeMs - before.awakeMs;
  if (elapsed <= 0 || awake < 0 || Math.abs(elapsed - (after.wallMs - before.wallMs)) > CLOCK_SLOP_MS) return null;
  const outsideRequest = Math.max(0, startedAt - before.wallMs) + after.wallMs - timedOutAt;
  if (elapsed - awake - outsideRequest - CLOCK_SLOP_MS < MIN_SLEEP_MS) return null;
  return awake + Math.max(0, before.wallMs - startedAt) + CLOCK_SLOP_MS;
}

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
  readonly awakeUpperBoundMs: number | null;

  constructor(
    message: string,
    { elapsedMs, limitMs, report, cause, awakeUpperBoundMs = null }: {
      elapsedMs: number; limitMs: number; report: string; cause?: unknown; awakeUpperBoundMs?: number | null;
    },
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.elapsedMs = elapsedMs;
    this.limitMs = limitMs;
    this.report = report;
    this.awakeUpperBoundMs = awakeUpperBoundMs;
  }
}

/**
 * Suppress only when sleep is measured and the request did not have its full
 * awake budget. Timer lateness alone also happens during a real awake stall.
 */
export function isSleepRpcTimeout(error: unknown): boolean {
  return error instanceof RpcTimeoutError && error.awakeUpperBoundMs !== null && error.awakeUpperBoundMs < error.limitMs;
}
