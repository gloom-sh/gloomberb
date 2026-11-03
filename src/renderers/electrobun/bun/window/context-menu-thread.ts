import { ContextMenu } from "electrobun/bun";
import { reportCrash } from "../../../../telemetry/crash-reports";
import { debugLog } from "../../../../utils/debug-log";
import { nativeWrapperLibraryPath, startNativeCallThread, type NativeCallThread, type NativeCallThreadFailure } from "./native-call-thread";
import { measureNativeCall } from "./native-timing";

const menuLog = debugLog.createLogger("context-menu-thread");

/**
 * Past this a menu's call counts as stuck: a person picks or dismisses a
 * menu well within it, and Windows closes one when the app loses focus.
 */
const MENU_CALL_LIMIT_MS = 60_000;
/** A menu asked for longer ago than this is not shown late. */
const REPLAY_WITHIN_MS = 5_000;
/** After this many stuck threads, menus open on the app's thread. */
const MAX_STUCK_THREADS = 3;

let installed = false;

/**
 * Once per process, and only once it happens: menus waiting on the app's
 * thread again is the freeze this thread removes, so error tracking hears
 * of it, and the menus themselves count as stalls (host-requests.ts).
 */
function reportMenuThreadFailure(failure: NativeCallThreadFailure | "unavailable"): void {
  reportCrash(
    { name: "ContextMenuThread", message: `Context menus could not open off the app's thread: ${failure}` },
    { kind: "plugin", plugin: "stall-monitor" },
  );
}

/**
 * On Windows a context menu's native call waits on the thread that runs the
 * windows until the menu closes, which is as long as the person takes to
 * pick from it. It goes to a thread of its own, started with the first menu.
 * Where that thread cannot run, menus open on this thread as before, those
 * it took and never began included; a stuck one is replaced by a new thread.
 */
export function runContextMenusOffThread(platform: string = process.platform): void {
  if (platform !== "win32" || installed) return;
  installed = true;
  /** Undefined: started with the next menu. Null: menus open on this thread. */
  let thread: NativeCallThread | null | undefined;
  let stuckThreads = 0;
  const encoder = new TextEncoder();

  const start = (): NativeCallThread | null => {
    const started = startNativeCallThread(nativeWrapperLibraryPath(), "showContextMenu", {
      callLimitMs: MENU_CALL_LIMIT_MS,
      onFailure: (failure, unstarted) => {
        reportMenuThreadFailure(failure);
        stuckThreads += failure === "stuck" ? 1 : 0;
        thread = failure === "stuck" && stuckThreads < MAX_STUCK_THREADS ? undefined : null;
        const now = performance.now();
        for (const call of unstarted) {
          if (now - call.takenAt <= REPLAY_WITHIN_MS) call.replay();
          else menuLog.warn("A context menu asked for too long ago was not shown", { ageMs: Math.round(now - call.takenAt) });
        }
      },
    });
    if (!started) reportMenuThreadFailure("unavailable");
    return started;
  };

  const show = (menuConfig: string, handler: number, showHere: () => void): boolean => {
    if (thread === undefined) thread = start();
    if (!thread) return false;
    return thread.call(encoder.encode(`${menuConfig}\0`), handler, () => {
      if (!show(menuConfig, handler, showHere)) measureNativeCall("context-menu.show", showHere);
    });
  };
  ContextMenu.setContextMenuRunner(show);
}
