import { debugLog } from "./debug-log";

const SAMPLE_INTERVAL_MS = 50;
const LAG_WARN_MS = 100;
const LAG_ERROR_MS = 300;
const LONG_TASK_WARN_MS = 50;

const mainThreadLog = debugLog.createLogger("main-thread");

function now(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === "function" ? perf.now() : Date.now();
}

function summarizeLongTask(entry: unknown): Record<string, unknown> {
  const value = entry as {
    name?: string;
    duration?: number;
    startTime?: number;
    attribution?: Array<Record<string, unknown>>;
  };
  return {
    name: value.name,
    durationMs: Math.round((value.duration ?? 0) * 10) / 10,
    startTimeMs: Math.round((value.startTime ?? 0) * 10) / 10,
    attribution: value.attribution?.map((item) => ({
      name: item.name,
      entryType: item.entryType,
      containerType: item.containerType,
      containerName: item.containerName,
      containerId: item.containerId,
      scriptUrl: item.scriptUrl,
      lineNumber: item.lineNumber,
      columnNumber: item.columnNumber,
    })).slice(0, 3),
  };
}

export function startMainThreadMonitor(
  scope: string,
  options: { mirrorToConsole?: boolean } = {},
): () => void {
  let stopped = false;
  let lastTick = now();
  let maxLagMs = 0;
  let sampleCount = 0;

  mainThreadLog.info("monitor started", {
    scope,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    lagWarnMs: LAG_WARN_MS,
    lagErrorMs: LAG_ERROR_MS,
  });

  const intervalId = setInterval(() => {
    const current = now();
    const elapsedMs = current - lastTick;
    lastTick = current;
    sampleCount += 1;

    const lagMs = elapsedMs - SAMPLE_INTERVAL_MS;
    if (lagMs <= 0) return;
    maxLagMs = Math.max(maxLagMs, lagMs);
    if (lagMs < LAG_WARN_MS) return;

    const payload = {
      scope,
      lagMs: Math.round(lagMs * 10) / 10,
      elapsedMs: Math.round(elapsedMs * 10) / 10,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      sampleCount,
      maxLagMs: Math.round(maxLagMs * 10) / 10,
    };
    if (lagMs >= LAG_ERROR_MS) {
      mainThreadLog.error("event loop blocked", payload);
    } else {
      mainThreadLog.warn("event loop delayed", payload);
    }
    if (options.mirrorToConsole) {
      console.error(
        `perf main-thread.stall scope=${scope} lag_ms=${payload.lagMs} elapsed_ms=${payload.elapsedMs} sample_interval_ms=${SAMPLE_INTERVAL_MS}`,
      );
    }
  }, SAMPLE_INTERVAL_MS);

  const ObserverCtor = (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver;
  let observer: { observe: (options: { entryTypes: string[] }) => void; disconnect?: () => void } | null = null;
  if (typeof ObserverCtor === "function") {
    try {
      observer = new (ObserverCtor as new (callback: (list: { getEntries: () => unknown[] }) => void) => {
        observe: (options: { entryTypes: string[] }) => void;
        disconnect: () => void;
      })((list) => {
        for (const entry of list.getEntries()) {
          const durationMs = (entry as { duration?: number }).duration ?? 0;
          if (durationMs < LONG_TASK_WARN_MS) continue;
          const payload = { scope, ...summarizeLongTask(entry) };
          if (durationMs >= LAG_ERROR_MS) {
            mainThreadLog.error("browser long task", payload);
          } else {
            mainThreadLog.warn("browser long task", payload);
          }
          if (options.mirrorToConsole) {
            console.error(
              `perf main-thread.longtask scope=${scope} duration_ms=${Math.round(durationMs * 10) / 10}`,
            );
          }
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      observer = null;
    }
  }

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(intervalId);
    observer?.disconnect?.();
    mainThreadLog.info("monitor stopped", {
      scope,
      sampleCount,
      maxLagMs: Math.round(maxLagMs * 10) / 10,
    });
  };
}
