import { debugLog } from "./debug-log";

const WINDOW_MS = 30_000;
// Callers supply literal source/message pairs, so this retains one small record
// per operation, never per rejection payload or request.
const windows = new Map<string, { startedAt: number; suppressed: number }>();

/** Keep the fallback while recording the failed operation, without private rejection payloads. */
export function logFailure(source: string, message: string): (error: unknown) => undefined;
export function logFailure<T>(source: string, message: string, fallback: T): (error: unknown) => T;
export function logFailure<T>(source: string, message: string, fallback?: T) {
  return (_error: unknown): T | undefined => {
    // Descriptions must be fixed text: errors can contain credentials, URLs or home paths.
    try {
      const key = JSON.stringify([source, message]);
      const now = Date.now();
      const previous = windows.get(key);
      if (previous && now >= previous.startedAt && now - previous.startedAt < WINDOW_MS) {
        previous.suppressed++;
        return fallback;
      }
      windows.set(key, { startedAt: now, suppressed: 0 });
      debugLog.createLogger(source).warn(previous?.suppressed
        ? `${message} (suppressed repeats: ${previous.suppressed})`
        : message);
    } catch {
      // Intentional ignore: a failing console mirror must not replace the original fallback.
    }
    return fallback;
  };
}
