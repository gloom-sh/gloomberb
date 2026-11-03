import { BrowserView } from "electrobun/bun";
import { reportCrash } from "../../../../telemetry/crash-reports";
import { nativeWrapperLibraryPath, startNativeCallThread, type NativeCallThread, type NativeCallThreadFailure } from "./native-call-thread";

let installed = false;

/**
 * Once per process, and only once it happens: scripts waiting on the app's
 * thread again is the freeze this thread removes, so error tracking hears
 * of it.
 */
function reportScriptThreadFailure(failure: NativeCallThreadFailure | "unavailable"): void {
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
 * first one, and run there in the order they were sent. Where that thread
 * cannot run, they run on this thread as before, those it took and never
 * began first, so none is lost or overtaken.
 */
export function runWebviewScriptsOffThread(platform: string = process.platform): void {
  if (platform !== "win32" || installed) return;
  installed = true;
  /** Undefined: started with the next script. Null: scripts run on this thread. */
  let thread: NativeCallThread | null | undefined;
  const encoder = new TextEncoder();

  const start = (): NativeCallThread | null => {
    const started = startNativeCallThread(nativeWrapperLibraryPath(), "evaluateJavaScriptWithNoCompletion", {
      pointerFirst: true,
      onFailure: (failure, unstarted) => {
        reportScriptThreadFailure(failure);
        thread = null;
        for (const call of unstarted) call.replay();
      },
    });
    if (!started) reportScriptThreadFailure("unavailable");
    return started;
  };

  BrowserView.setScriptRunner((js, webview, runHere) => {
    if (thread === undefined) thread = start();
    if (!thread) return false;
    return thread.call(encoder.encode(`${js}\0`), webview, runHere);
  });
}
