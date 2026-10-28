import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import Electrobun from "electrobun/bun";
import { wideString } from "./windows-native";

const WM_QUIT = 0x0012;
/** The class Electrobun registers for its windows. */
const WINDOW_CLASS = "BasicWindowClass";
/** How long a quit waits for this app's windows to be destroyed. */
const WINDOWS_CLOSED_TIMEOUT_MS = 1_000;

function loadUser32() {
  return dlopen("user32.dll", {
    GetWindowThreadProcessId: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    FindWindowExW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    PostThreadMessageW: { args: [FFIType.u32, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.bool },
  });
}

/**
 * Electrobun ends its Windows event loop with PostQuitMessage, from the thread
 * the app's code runs on rather than the one running the loop. The loop never
 * ends: the app sits out a 5 s timeout with Chromium never shut down, and a
 * Gloom opened meanwhile finds Chromium's profile still held, hands itself to
 * the closing app and crashes. The quit message goes to the loop's own thread
 * instead, once this app's windows are gone; with one still open, Electrobun's
 * timeout ends the app as before. Does nothing off Windows.
 */
export function quitWindowsEventLoopOnItsThread(window: { ptr: Pointer | null }): void {
  if (process.platform !== "win32" || !window.ptr) return;
  let user32: ReturnType<typeof loadUser32>;
  try {
    user32 = loadUser32();
  } catch {
    return;
  }
  const loopThread = user32.symbols.GetWindowThreadProcessId(window.ptr, null);
  if (!loopThread) return;
  const className = wideString(WINDOW_CLASS);
  const processId = new Uint32Array(1);
  const ownWindowOpen = (): boolean => {
    let handle: Pointer | null = null;
    while ((handle = user32.symbols.FindWindowExW(null, handle, ptr(className), null))) {
      user32.symbols.GetWindowThreadProcessId(handle, ptr(processId));
      if (processId[0] === process.pid) return true;
    }
    return false;
  };
  Electrobun.events.on("before-quit", () => {
    // Quitting blocks this thread until the loop has ended, so the wait is here.
    const deadline = Date.now() + WINDOWS_CLOSED_TIMEOUT_MS;
    while (ownWindowOpen()) {
      if (Date.now() > deadline) return;
      Bun.sleepSync(16);
    }
    user32.symbols.PostThreadMessageW(loopThread, WM_QUIT, 0n, 0n);
  });
}
