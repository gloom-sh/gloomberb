import { existsSync } from "fs";
import { resolve } from "path";
import { ptr, type Pointer } from "bun:ffi";
import {
  findCurrentProcessWindow,
  WINDOWS_HANDLE_MAX_ATTEMPTS,
  WINDOWS_HANDLE_RETRY_DELAY_MS,
  wideString,
  win32OrNull,
} from "./windows-native";

const WM_SETICON = 0x0080;
const ICON_SMALL = 0;
const ICON_BIG = 1;
const IMAGE_ICON = 1;
const LR_LOADFROMFILE = 0x0010;
const LR_DEFAULTSIZE = 0x0040;
const GCLP_HICON = -14;
const GCLP_HICONSM = -34;
type Win32 = NonNullable<ReturnType<typeof win32OrNull>>;
let smallIconHandle: Pointer | null = null;
let bigIconHandle: Pointer | null = null;

function loadIconHandle(win32: Win32, iconPath: string, size: number): Pointer | null {
  const iconPathBuffer = wideString(iconPath);
  const iconHandle = win32.symbols.LoadImageW(
    null,
    ptr(iconPathBuffer),
    IMAGE_ICON,
    size,
    size,
    LR_LOADFROMFILE | LR_DEFAULTSIZE,
  );

  return iconHandle || null;
}

function ensureIconHandles(win32: Win32): boolean {
  if (smallIconHandle && bigIconHandle) return true;

  const iconPath = resolve("../Resources/app.ico");
  if (!existsSync(iconPath)) return false;

  smallIconHandle = smallIconHandle ?? loadIconHandle(win32, iconPath, 16);
  bigIconHandle = bigIconHandle ?? loadIconHandle(win32, iconPath, 32);

  return Boolean(smallIconHandle && bigIconHandle);
}

function setWindowIcon(win32: Win32, windowHandle: Pointer): boolean {
  if (!ensureIconHandles(win32) || !smallIconHandle || !bigIconHandle) return false;

  win32.symbols.SendMessageW(windowHandle, WM_SETICON, ICON_SMALL, smallIconHandle);
  win32.symbols.SendMessageW(windowHandle, WM_SETICON, ICON_BIG, bigIconHandle);
  win32.symbols.SetClassLongPtrW(windowHandle, GCLP_HICONSM, smallIconHandle);
  win32.symbols.SetClassLongPtrW(windowHandle, GCLP_HICON, bigIconHandle);
  return true;
}

export function applyWindowsWindowIcon(title: string, attempt = 1): void {
  const win32 = win32OrNull();
  if (!win32) return;

  const windowHandle = findCurrentProcessWindow(win32, title);
  if (windowHandle && setWindowIcon(win32, windowHandle)) return;

  if (attempt < WINDOWS_HANDLE_MAX_ATTEMPTS) {
    setTimeout(() => applyWindowsWindowIcon(title, attempt + 1), WINDOWS_HANDLE_RETRY_DELAY_MS);
  }
}
