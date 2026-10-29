import { lastPerfSample, recordPerfSample } from "./perf-marks";

/** How often the monitor checks in. Short enough to date a stall precisely. */
const SAMPLE_INTERVAL_MS = 250;
/**
 * A timer that fires this late means the loop was busy that long, and nothing
 * the user did could be answered. Below it, ordinary render bursts would fill
 * the log with noise.
 */
const STALL_THRESHOLD_MS = 400;

/** The facts a `sqlite.blocked` step was measured with (data/sqlite/retry.ts). */
interface StallSqliteDetail {
  /** The statement's fixed name, such as "touch cached resource". */
  operation: string;
  attempts: number;
  /** Whether it waited on another connection's lock, rather than being slow on its own. */
  lockWait: boolean;
}

export interface StallEvent {
  blockedMs: number;
  /** The last measured section before the stall (perf-marks), if any. */
  lastMeasured?: string;
  /** How long before the stall was noticed that section ended. */
  lastMeasuredEndedMsAgo?: number;
  /** When that section was a SQLite statement that held the thread. */
  sqlite?: StallSqliteDetail;
  /** How long the process had been running when the stall was noticed. */
  uptimeMs?: number;
  /** Whether the process had finished starting (`markStartupComplete`). */
  phase?: "startup" | "steady";
}

let stallSink: ((event: StallEvent) => void) | null = null;
let startupComplete = false;

/**
 * Where this process's stalls go besides the Debug Log: the stall log and its
 * report (telemetry/stall-reports.ts), or, in the desktop window, the Bun
 * process that keeps them.
 */
export function setStallSink(next: ((event: StallEvent) => void) | null): () => void {
  stallSink = next;
  return () => {
    if (stallSink === next) stallSink = null;
  };
}

/**
 * The process is up: its first screen has its data, or (the desktop app's
 * Bun process) the main window has what it asked for. Stalls before this are
 * reported as startup ones.
 */
export function markStartupComplete(): void {
  startupComplete = true;
}

/** Test seam. */
export function resetStartupCompleteForTests(): void {
  startupComplete = false;
}

function noteStall(event: StallEvent): void {
  try {
    stallSink?.(event);
  } catch {
    // Intentional ignore: reporting a freeze must never become one.
  }
}

/** The facts of a `sqlite.blocked` sample, when they have the shape retry.ts gives them. */
function sqliteDetail(metadata: Record<string, unknown> | undefined): StallSqliteDetail | undefined {
  if (!metadata) return undefined;
  const { operation, attempts, lockWait } = metadata;
  if (typeof operation !== "string" || typeof attempts !== "number") return undefined;
  return { operation, attempts, lockWait: lockWait === true };
}

export interface MainThreadStallMonitorOptions {
  intervalMs?: number;
  thresholdMs?: number;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  report?: (blockedMs: number, context: Omit<StallEvent, "blockedMs">) => void;
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
 * did it" in a report that only says the app hung for a few seconds, and how
 * long the process had been up, so a slow start reads apart from a hang
 * hours in.
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
    ?? ((blockedMs, context) => {
      // Logged, but not a step: the next stall still names the work before it.
      recordPerfSample("runtime.stall", blockedMs, context, { lastStep: false });
      noteStall({ blockedMs, ...context });
    });

  let previous = now();
  const handle = schedule(() => {
    const current = now();
    const blockedMs = current - previous - intervalMs;
    previous = current;
    if (blockedMs < thresholdMs) return;
    const sample = lastPerfSample();
    const sqlite = sample?.name === "sqlite.blocked" ? sqliteDetail(sample.metadata) : undefined;
    report(blockedMs, {
      ...(sample
        ? { lastMeasured: sample.name, lastMeasuredEndedMsAgo: Math.round(current - sample.endedAt) }
        : {}),
      ...(sqlite ? { sqlite } : {}),
      uptimeMs: Math.round(current),
      phase: startupComplete ? "steady" : "startup",
    });
  }, intervalMs);
  if (handle && typeof (handle as { unref?: () => void }).unref === "function") {
    (handle as { unref: () => void }).unref();
  }

  return () => cancel(handle);
}
