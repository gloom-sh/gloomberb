import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

const WINDOWS_HANDLE_MAX_ATTEMPTS = 20;
const WINDOWS_HANDLE_RETRY_DELAY_MS = 100;

export type Win32 = ReturnType<typeof loadWin32>;

let cachedWin32: Win32 | null | undefined;

function loadWin32() {
  return dlopen("user32.dll", {
    FindWindowW: {
      args: [FFIType.ptr, FFIType.ptr],
      returns: FFIType.ptr,
    },
    GetWindowThreadProcessId: {
      args: [FFIType.ptr, FFIType.ptr],
      returns: FFIType.u32,
    },
    LoadImageW: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.int, FFIType.int, FFIType.u32],
      returns: FFIType.ptr,
    },
    SendMessageW: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.ptr],
      returns: FFIType.ptr,
    },
    SetClassLongPtrW: {
      args: [FFIType.ptr, FFIType.int, FFIType.ptr],
      returns: FFIType.ptr,
    },
    GetWindowLongPtrW: {
      args: [FFIType.ptr, FFIType.int],
      returns: FFIType.i64,
    },
    SetWindowLongPtrW: {
      args: [FFIType.ptr, FFIType.int, FFIType.i64],
      returns: FFIType.i64,
    },
    SetWindowPos: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.int, FFIType.int, FFIType.int, FFIType.int, FFIType.u32],
      returns: FFIType.bool,
    },
  });
}

function win32OrNull(): Win32 | null {
  if (process.platform !== "win32") return null;
  if (cachedWin32 !== undefined) return cachedWin32;

  try {
    cachedWin32 = loadWin32();
  } catch {
    cachedWin32 = null;
  }
  return cachedWin32;
}

export function wideString(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(`${value}\0`, "utf16le"));
}

function readWindowProcessId(win32: Win32, windowHandle: Pointer): number {
  const processIdBuffer = new Uint32Array(1);
  win32.symbols.GetWindowThreadProcessId(windowHandle, ptr(processIdBuffer));
  return processIdBuffer[0] ?? 0;
}

function findCurrentProcessWindow(win32: Win32, title: string): Pointer | null {
  const titleBuffer = wideString(title);
  const windowHandle = win32.symbols.FindWindowW(null, ptr(titleBuffer));
  if (!windowHandle) return null;
  if (readWindowProcessId(win32, windowHandle) !== process.pid) return null;
  return windowHandle;
}

/**
 * Runs `apply` on this process's window titled `title`. The native window shows
 * up a moment after BrowserWindow returns, so a missing handle or a failed
 * `apply` retries for a couple of seconds. Does nothing off Windows.
 */
export function withWindowHandle(
  title: string,
  apply: (win32: Win32, windowHandle: Pointer) => boolean,
  attempt = 1,
): void {
  const win32 = win32OrNull();
  if (!win32) return;

  const windowHandle = findCurrentProcessWindow(win32, title);
  if (windowHandle && apply(win32, windowHandle)) return;

  if (attempt < WINDOWS_HANDLE_MAX_ATTEMPTS) {
    setTimeout(() => withWindowHandle(title, apply, attempt + 1), WINDOWS_HANDLE_RETRY_DELAY_MS);
  }
}
