import { lastPerfSample, recordPerfSample } from "./perf-marks";

/** How often the monitor checks in. Short enough to date a stall precisely. */
const SAMPLE_INTERVAL_MS = 250;
/**
 * A timer that fires this late means the loop was busy that long, and nothing
 * the user did could be answered. Below it, ordinary render bursts would fill
 * the log with noise.
 */
const STALL_THRESHOLD_MS = 400;

export interface MainThreadStallMonitorOptions {
  intervalMs?: number;
  thresholdMs?: number;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  report?: (blockedMs: number, context: Record<string, unknown>) => void;
}

function defaultNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/**
 * Names the freezes. A timer that should fire every quarter second is a
 * witness to everything that blocks the main thread, measured or not: when it
 * comes back late, the app was unresponsive for exactly that long. The report
 * carries the last measured section and how long before the stall it ended,
 * which is usually enough to tell "the cache read did it" from "the render
 * did it" in a report that only says the app hung for a few seconds.
 */
export function startMainThreadStallMonitor(
  options: MainThreadStallMonitorOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? SAMPLE_INTERVAL_MS;
  const thresholdMs = options.thresholdMs ?? STALL_THRESHOLD_MS;
  const now = options.now ?? defaultNow;
  const schedule = options.schedule ?? ((callback, delayMs) => setInterval(callback, delayMs));
  const cancel = options.cancel ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const report = options.report
    ?? ((blockedMs, context) => recordPerfSample("runtime.stall", blockedMs, context));

  let previous = now();
  const handle = schedule(() => {
    const current = now();
    const blockedMs = current - previous - intervalMs;
    previous = current;
    if (blockedMs < thresholdMs) return;
    const sample = lastPerfSample();
    report(blockedMs, {
      ...(sample
        ? { lastMeasured: sample.name, lastMeasuredEndedMsAgo: Math.round(current - sample.endedAt) }
        : {}),
    });
  }, intervalMs);
  if (handle && typeof (handle as { unref?: () => void }).unref === "function") {
    (handle as { unref: () => void }).unref();
  }

  return () => cancel(handle);
}
