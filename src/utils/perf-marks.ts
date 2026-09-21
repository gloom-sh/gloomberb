import { debugLog } from "./debug-log";

const PERF_WARN_MS = 50;
const PERF_ERROR_MS = 200;

const perfLog = debugLog.createLogger("perf");

/**
 * `GLOOMBERB_PERF_TRACE=1` mirrors every sample to stderr as one line with the
 * elapsed process time, so a tmux-driven run yields a startup timeline without
 * opening the in-app log. Resolved once: the check sits on every measured call.
 */
const traceToStderr = typeof process !== "undefined"
  && !!process.env?.GLOOMBERB_PERF_TRACE
  && typeof process.stderr?.write === "function";

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

// Two scalars rather than an object: every measured section writes them, and
// only the stall monitor ever reads them.
let lastSampleName: string | null = null;
let lastSampleEndedAt = 0;

/**
 * The most recent measured section and when it ended. The stall monitor reads
 * it so a report of "the app froze" carries the last thing the app is known to
 * have been doing.
 */
export function lastPerfSample(): { name: string; endedAt: number } | null {
  return lastSampleName == null ? null : { name: lastSampleName, endedAt: lastSampleEndedAt };
}

function logSlowPerfSample(
  name: string,
  durationMs: number,
  metadata?: Record<string, unknown>,
): void {
  lastSampleName = name;
  lastSampleEndedAt = now();
  const payload = {
    durationMs: Math.round(durationMs * 10) / 10,
    ...(metadata ?? {}),
  };
  if (traceToStderr) {
    const detail = metadata ? ` ${JSON.stringify(metadata)}` : "";
    process.stderr.write(`perf ${name} ${payload.durationMs}ms t=${Math.round(now())}${detail}\n`);
  }
  if (durationMs >= PERF_ERROR_MS) {
    perfLog.error(name, payload);
  } else if (durationMs >= PERF_WARN_MS) {
    perfLog.warn(name, payload);
  }
}

export function isPerfTraceEnabled(): boolean {
  return traceToStderr;
}

/** A sample measured elsewhere (a React Profiler callback, for instance). */
export function recordPerfSample(
  name: string,
  durationMs: number,
  metadata?: Record<string, unknown>,
): void {
  logSlowPerfSample(name, durationMs, metadata);
}

export function measurePerf<T>(
  name: string,
  fn: () => T,
  metadata?: Record<string, unknown>,
): T {
  const start = now();
  try {
    return fn();
  } finally {
    logSlowPerfSample(name, now() - start, metadata);
  }
}

export async function measurePerfAsync<T>(
  name: string,
  fn: () => Promise<T>,
  metadata?: Record<string, unknown>,
): Promise<T> {
  const start = now();
  try {
    return await fn();
  } finally {
    logSlowPerfSample(name, now() - start, metadata);
  }
}
