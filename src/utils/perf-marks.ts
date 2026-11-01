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

// Scalars rather than an object: every measured section writes them, and
// only the stall monitor ever reads them. The metadata is the caller's own
// object, kept by reference.
let lastSampleName: string | null = null;
let lastSampleEndedAt = 0;
let lastSampleDurationMs = 0;
let lastSampleMetadata: Record<string, unknown> | undefined;
/** Inside `withoutLastStep`: samples are logged, and none becomes the last step. */
let quietDepth = 0;

/**
 * The most recent measured section, when it ended and what it was measured
 * with. The stall monitor reads it so a report of "the app froze" carries the
 * last thing the app is known to have been doing.
 */
export function lastPerfSample(): { name: string; endedAt: number; metadata?: Record<string, unknown> } | null {
  if (lastSampleName == null) return null;
  return { name: lastSampleName, endedAt: lastSampleEndedAt, ...(lastSampleMetadata ? { metadata: lastSampleMetadata } : {}) };
}

/**
 * Whether the last step ended inside a section that started at `startedAt`
 * and took at least half of its `durationMs`. That step says more about the
 * time than the section around it: a SQLite statement that held the thread
 * through most of a window's request keeps its lock and try facts, where a
 * short one before the request's real work does not.
 */
function lastStepAccountsForSection(startedAt: number, durationMs: number): boolean {
  return lastSampleName != null && lastSampleEndedAt >= startedAt && lastSampleDurationMs * 2 >= durationMs;
}

function logSlowPerfSample(
  name: string,
  durationMs: number,
  metadata?: Record<string, unknown>,
  lastStep = true,
  startedAt?: number,
): void {
  if (lastStep && quietDepth === 0 && (startedAt === undefined || !lastStepAccountsForSection(startedAt, durationMs))) {
    lastSampleName = name;
    lastSampleEndedAt = now();
    lastSampleDurationMs = durationMs;
    lastSampleMetadata = metadata;
  }
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

/**
 * Runs `fn` without any section it measures becoming the step a later stall
 * names: reporting a stall reads the windows, and the next stall must still
 * name the work before it, not the report.
 */
export function withoutLastStep<T>(fn: () => T): T {
  quietDepth += 1;
  try {
    return fn();
  } finally {
    quietDepth -= 1;
  }
}

export function isPerfTraceEnabled(): boolean {
  return traceToStderr;
}

/**
 * A sample measured elsewhere (a React Profiler callback, for instance).
 * `lastStep: false` logs it without making it the step a later stall names:
 * the stall monitor's own samples, which measure no work.
 */
export function recordPerfSample(
  name: string,
  durationMs: number,
  metadata?: Record<string, unknown>,
  options?: { lastStep?: boolean },
): void {
  logSlowPerfSample(name, durationMs, metadata, options?.lastStep !== false);
}

/**
 * Measures `fn`. A step measured inside it that took most of its time stays
 * the step a stall names (`lastStepAccountsForSection`).
 */
export function measurePerf<T>(
  name: string,
  fn: () => T,
  metadata?: Record<string, unknown>,
): T {
  const start = now();
  try {
    return fn();
  } finally {
    logSlowPerfSample(name, now() - start, metadata, true, start);
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
