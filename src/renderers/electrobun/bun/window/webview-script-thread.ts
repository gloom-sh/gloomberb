import { BrowserView } from "electrobun/bun";
import { reportCrash } from "../../../../telemetry/crash-reports";
import { nativeWrapperLibraryPath, startNativeCallThread, type NativeCallThread, type NativeCallThreadFailure } from "./native-call-thread";
import { scriptForWebview } from "./script-for-webview";

/**
 * Past this a script's call counts as stuck: the thread that runs the
 * windows takes one in milliseconds, and keeps taking them while a menu is
 * open or a window is held mid-move. The app's own freeze watchdog waits
 * as long.
 */
const SCRIPT_CALL_LIMIT_MS = 30_000;
/** After this many stuck threads in a row, scripts run on the app's thread. */
const MAX_STUCK_THREADS = 3;

let installed = false;
let reported = false;

/**
 * Once per process, and only once it happens: scripts waiting on the app's
 * thread again, or piling up behind a call that does not return, is the
 * freeze this thread removes, so error tracking hears of it.
 */
function reportScriptThreadFailure(failure: NativeCallThreadFailure | "unavailable"): void {
  if (reported) return;
  reported = true;
  reportCrash(
    { name: "WebviewScriptThread", message: `Messages to windows could not go off the app's thread: ${failure}` },
    { kind: "plugin", plugin: "stall-monitor" },
  );
}

/**
 * On Windows every message the app sends a window goes as a script (it has
 * no socket there), and the script's native call waits until the thread
 * that runs the windows takes it, so the app stood still whenever that
 * thread was busy. Scripts go to a thread of their own, started with the
 * first one, and run there in the order they were sent, each only in the
 * page it was sent to (script-for-webview.ts).
 *
 * A call that does not return within the limit gives the thread up: the
 * scripts behind it go to a new thread, in order, so they neither pile up
 * behind it for good nor wait on this thread. After three stuck threads in
 * a row, or where no thread can run, scripts run on this thread as before,
 * the ones a thread took and never began first, so none is lost or
 * overtaken.
 */
export function runWebviewScriptsOffThread(platform: string = process.platform): void {
  if (platform !== "win32" || installed) return;
  installed = true;
  /** Undefined: started with the next script. Null: scripts run on this thread. */
  let thread: NativeCallThread | null | undefined;
  let stuckThreads = 0;
  const encoder = new TextEncoder();

  const start = (): NativeCallThread | null => {
    const started = startNativeCallThread(nativeWrapperLibraryPath(), "evaluateJavaScriptWithNoCompletion", {
      pointerFirst: true,
      callLimitMs: SCRIPT_CALL_LIMIT_MS,
      onCallDone: () => {
        stuckThreads = 0;
      },
      onFailure: (failure, unstarted) => {
        reportScriptThreadFailure(failure);
        stuckThreads += failure === "stuck" ? 1 : 0;
        thread = failure === "stuck" && stuckThreads < MAX_STUCK_THREADS ? undefined : null;
        for (const call of unstarted) call.replay();
      },
    });
    if (!started) reportScriptThreadFailure("unavailable");
    return started;
  };

  const run = (js: string, webviewId: number, webview: number, runHere: () => void): boolean => {
    if (thread === undefined) thread = start();
    if (!thread) return false;
    return thread.call(encoder.encode(`${scriptForWebview(webviewId, js)}\0`), webview, () => {
      if (!run(js, webviewId, webview, runHere)) runHere();
    });
  };
  BrowserView.setScriptRunner(run);
}
