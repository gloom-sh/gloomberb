import { debugLog } from "./debug-log";

/** Keep the fallback while recording the failed operation, without private rejection payloads. */
export function logFailure(source: string, message: string): (error: unknown) => undefined;
export function logFailure<T>(source: string, message: string, fallback: T): (error: unknown) => T;
export function logFailure<T>(source: string, message: string, fallback?: T) {
  return (_error: unknown): T | undefined => {
    // Descriptions must be fixed text: errors can contain credentials, URLs or home paths.
    try {
      debugLog.createLogger(source).warn(message);
    } catch {
      // Intentional ignore: a failing console mirror must not replace the original fallback.
    }
    return fallback;
  };
}
