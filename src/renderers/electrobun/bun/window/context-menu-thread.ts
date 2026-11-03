import { ContextMenu } from "electrobun/bun";
import { startNativeCallThread, type NativeCallThread } from "./native-call-thread";

let installed = false;

/**
 * On Windows a context menu's native call waits on the thread that runs the
 * windows until the menu closes, which is as long as the person takes to
 * pick from it. It goes to a thread of its own, started with the first menu;
 * where that thread cannot run, menus open on this thread as before.
 */
export function runContextMenusOffThread(platform: string = process.platform): void {
  if (platform !== "win32" || installed) return;
  installed = true;
  let thread: NativeCallThread | null | undefined;
  const encoder = new TextEncoder();
  ContextMenu.setContextMenuRunner((menuConfig, handler) => {
    if (thread === undefined) {
      thread = startNativeCallThread(ContextMenu.nativeWrapperLibraryPath(), "showContextMenu", {
        onFailure: () => { thread = null; },
      });
    }
    return thread?.call(encoder.encode(`${menuConfig}\0`), handler) ?? false;
  });
}
