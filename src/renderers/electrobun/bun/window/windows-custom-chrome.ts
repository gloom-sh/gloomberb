import type { Pointer } from "bun:ffi";
import { withWindowHandle, type Win32 } from "./windows-native";

const GWL_STYLE = -16;
const WS_CAPTION = 0x00c00000n;
const WS_SYSMENU = 0x00080000n;
const WS_THICKFRAME = 0x00040000n;
const WS_MINIMIZEBOX = 0x00020000n;
const WS_MAXIMIZEBOX = 0x00010000n;
const WINDOWS_NATIVE_CONTROL_STYLE_MASK = WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const CUSTOM_CHROME_SET_WINDOW_POS_FLAGS = SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED;

function styleValue(value: number | bigint): bigint {
  if (typeof value === "bigint") return value;
  return BigInt(value >>> 0);
}

function applyCustomChromeToWindow(win32: Win32, windowHandle: Pointer): boolean {
  const currentStyle = styleValue(win32.symbols.GetWindowLongPtrW(windowHandle, GWL_STYLE));
  const nextStyle = currentStyle & ~WINDOWS_NATIVE_CONTROL_STYLE_MASK;
  if (nextStyle !== currentStyle) {
    win32.symbols.SetWindowLongPtrW(windowHandle, GWL_STYLE, nextStyle);
  }

  return win32.symbols.SetWindowPos(
    windowHandle,
    null,
    0,
    0,
    0,
    0,
    CUSTOM_CHROME_SET_WINDOW_POS_FLAGS,
  );
}

export function applyWindowsCustomChrome(title: string): void {
  withWindowHandle(title, applyCustomChromeToWindow);
}
