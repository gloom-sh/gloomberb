import { reportCrash } from "../telemetry/crash-reports";
import { debugLog } from "./debug-log";
import { RpcTimeoutError } from "./rpc-timeout-error";

const log = debugLog.createLogger("desktop-rpc");

/**
 * Starts a desktop bridge call nobody awaits without leaving its rejection
 * unhandled. A timed-out request is logged and reported once per session
 * (never as a crash when the machine slept, see `reportCrash`) and swallowed:
 * the next state change sends a fresh snapshot anyway. Any other error is
 * rethrown, so a programming error still surfaces as an unhandled rejection.
 *
 * `onFailure` runs for every failure, so a caller that remembers what it
 * already sent can forget it and send again.
 */
export function fireAndForget(request: Promise<unknown> | undefined, label: string, onFailure?: () => void): void {
  request?.catch((error: unknown) => {
    onFailure?.();
    if (!(error instanceof RpcTimeoutError)) throw error;
    log.warn(`${label} did not complete: ${error.message}`);
    reportCrash(error, { kind: "unhandled-rejection" });
  });
}
