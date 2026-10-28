import { dlopen, FFIType, JSCallback, ptr } from "bun:ffi";

/**
 * The few Win32 calls the Windows desktop check needs: real input through
 * SendInput, window geometry, the cursor shape, hit tests, DPI, and screen
 * pixels. Coordinates are physical screen pixels: the process asks to be
 * per-monitor DPI aware before anything else, so nothing it reads is scaled.
 */

export interface Rect { left: number; top: number; right: number; bottom: number }
export interface Point { x: number; y: number }
export interface Bitmap { width: number; height: number; data: Buffer }

export const rectWidth = (rect: Rect) => rect.right - rect.left;
export const rectHeight = (rect: Rect) => rect.bottom - rect.top;

function load() {
  if (process.platform !== "win32") throw new Error("The Windows desktop check runs on Windows only.");
  const user32 = dlopen("user32.dll", {
    SetProcessDpiAwarenessContext: { args: [FFIType.i64], returns: FFIType.bool },
    EnumWindows: { args: [FFIType.function, FFIType.i64], returns: FFIType.bool },
    EnumChildWindows: { args: [FFIType.ptr, FFIType.function, FFIType.i64], returns: FFIType.bool },
    GetWindowTextW: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    GetClassNameW: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    GetWindowThreadProcessId: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    IsWindow: { args: [FFIType.ptr], returns: FFIType.bool },
    IsWindowVisible: { args: [FFIType.ptr], returns: FFIType.bool },
    IsIconic: { args: [FFIType.ptr], returns: FFIType.bool },
    IsZoomed: { args: [FFIType.ptr], returns: FFIType.bool },
    GetWindowRect: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    GetClientRect: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    ClientToScreen: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    GetWindowLongPtrW: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i64 },
    SetWindowPos: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u32], returns: FFIType.bool },
    ShowWindow: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.bool },
    SetForegroundWindow: { args: [FFIType.ptr], returns: FFIType.bool },
    GetForegroundWindow: { args: [], returns: FFIType.ptr },
    GetAncestor: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
    WindowFromPoint: { args: [FFIType.i64], returns: FFIType.ptr },
    SendMessageTimeoutW: { args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.i64, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i64 },
    SendInput: { args: [FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.u32 },
    GetCursorPos: { args: [FFIType.ptr], returns: FFIType.bool },
    GetCursorInfo: { args: [FFIType.ptr], returns: FFIType.bool },
    LoadCursorW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    GetSystemMetrics: { args: [FFIType.i32], returns: FFIType.i32 },
    MonitorFromWindow: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
    GetMonitorInfoW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    GetDpiForWindow: { args: [FFIType.ptr], returns: FFIType.u32 },
    GetWindowDpiAwarenessContext: { args: [FFIType.ptr], returns: FFIType.ptr },
    GetAwarenessFromDpiAwarenessContext: { args: [FFIType.ptr], returns: FFIType.i32 },
    GetDC: { args: [FFIType.ptr], returns: FFIType.ptr },
    ReleaseDC: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  });
  const gdi32 = dlopen("gdi32.dll", {
    CreateCompatibleDC: { args: [FFIType.ptr], returns: FFIType.ptr },
    CreateCompatibleBitmap: { args: [FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.ptr },
    SelectObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    BitBlt: { args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.u32], returns: FFIType.bool },
    GetDIBits: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    DeleteObject: { args: [FFIType.ptr], returns: FFIType.bool },
    DeleteDC: { args: [FFIType.ptr], returns: FFIType.bool },
  });
  const dwmapi = dlopen("dwmapi.dll", {
    DwmGetWindowAttribute: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  });
  const shcore = dlopen("shcore.dll", {
    GetDpiForMonitor: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  });
  return { user32: user32.symbols, gdi32: gdi32.symbols, dwmapi: dwmapi.symbols, shcore: shcore.symbols };
}

const api = load();
const { user32, gdi32 } = api;

// DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
user32.SetProcessDpiAwarenessContext(-4n);

type Hwnd = number;

function utf16(buffer: Uint16Array, length: number): string {
  return Buffer.from(buffer.buffer, 0, Math.max(0, length) * 2).toString("utf16le");
}

function readRect(buffer: Int32Array): Rect {
  return { left: buffer[0]!, top: buffer[1]!, right: buffer[2]!, bottom: buffer[3]! };
}

export interface WindowInfo {
  hwnd: Hwnd;
  pid: number;
  title: string;
  className: string;
  visible: boolean;
}

function windowInfo(hwnd: Hwnd): WindowInfo {
  const title = new Uint16Array(512);
  const className = new Uint16Array(256);
  const pid = new Uint32Array(1);
  const titleLength = user32.GetWindowTextW(hwnd as never, ptr(title), title.length);
  const classLength = user32.GetClassNameW(hwnd as never, ptr(className), className.length);
  user32.GetWindowThreadProcessId(hwnd as never, ptr(pid));
  return {
    hwnd,
    pid: pid[0]!,
    title: utf16(title, titleLength),
    className: utf16(className, classLength),
    visible: user32.IsWindowVisible(hwnd as never),
  };
}

export function topLevelWindows(): WindowInfo[] {
  const handles: Hwnd[] = [];
  const callback = new JSCallback((hwnd: number) => {
    handles.push(hwnd);
    return 1;
  }, { args: [FFIType.ptr, FFIType.i64], returns: FFIType.i32 });
  try {
    user32.EnumWindows(callback.ptr as never, 0);
  } finally {
    callback.close();
  }
  return handles.map(windowInfo);
}

export function childWindows(parent: Hwnd): WindowInfo[] {
  const handles: Hwnd[] = [];
  const callback = new JSCallback((hwnd: number) => {
    handles.push(hwnd);
    return 1;
  }, { args: [FFIType.ptr, FFIType.i64], returns: FFIType.i32 });
  try {
    user32.EnumChildWindows(parent as never, callback.ptr as never, 0);
  } finally {
    callback.close();
  }
  return handles.map(windowInfo);
}

export const isWindow = (hwnd: Hwnd) => user32.IsWindow(hwnd as never);
export const isMinimized = (hwnd: Hwnd) => user32.IsIconic(hwnd as never);
export const isMaximized = (hwnd: Hwnd) => user32.IsZoomed(hwnd as never);
export const foregroundWindow = (): Hwnd => Number(user32.GetForegroundWindow() ?? 0);

export function windowRect(hwnd: Hwnd): Rect {
  const buffer = new Int32Array(4);
  if (!user32.GetWindowRect(hwnd as never, ptr(buffer))) throw new Error(`GetWindowRect failed for ${hwnd}`);
  return readRect(buffer);
}

/** The window as drawn, without the invisible resize borders Windows adds around a framed window. */
export function visibleRect(hwnd: Hwnd): Rect {
  const buffer = new Int32Array(4);
  // DWMWA_EXTENDED_FRAME_BOUNDS
  if (api.dwmapi.DwmGetWindowAttribute(hwnd as never, 9, ptr(buffer), 16) !== 0) return windowRect(hwnd);
  return readRect(buffer);
}

export function clientRect(hwnd: Hwnd): Rect {
  const size = new Int32Array(4);
  const origin = new Int32Array(2);
  if (!user32.GetClientRect(hwnd as never, ptr(size))) throw new Error(`GetClientRect failed for ${hwnd}`);
  if (!user32.ClientToScreen(hwnd as never, ptr(origin))) throw new Error(`ClientToScreen failed for ${hwnd}`);
  return { left: origin[0]!, top: origin[1]!, right: origin[0]! + size[2]!, bottom: origin[1]! + size[3]! };
}

const STYLE_BITS: Array<[string, bigint]> = [
  ["WS_POPUP", 0x80000000n],
  ["WS_CAPTION", 0x00c00000n],
  ["WS_SYSMENU", 0x00080000n],
  ["WS_THICKFRAME", 0x00040000n],
  ["WS_MINIMIZEBOX", 0x00020000n],
  ["WS_MAXIMIZEBOX", 0x00010000n],
];

export function windowStyle(hwnd: Hwnd): { value: string; flags: string[] } {
  const raw = BigInt.asUintN(32, BigInt(user32.GetWindowLongPtrW(hwnd as never, -16)));
  return {
    value: `0x${raw.toString(16).padStart(8, "0")}`,
    flags: STYLE_BITS.filter(([, bit]) => (raw & bit) === bit).map(([name]) => name),
  };
}

/** Moves and sizes a window without input: only to put it back between steps. */
export function placeWindow(hwnd: Hwnd, rect: Rect): void {
  // SWP_NOZORDER | SWP_NOACTIVATE
  user32.SetWindowPos(hwnd as never, null, rect.left, rect.top, rectWidth(rect), rectHeight(rect), 0x0004 | 0x0010);
}

export function showWindow(hwnd: Hwnd, command: "restore" | "minimize" | "show"): void {
  user32.ShowWindow(hwnd as never, command === "restore" ? 9 : command === "minimize" ? 6 : 5);
}

export function bringToFront(hwnd: Hwnd): void {
  user32.SetForegroundWindow(hwnd as never);
}

export interface MonitorInfo { monitor: Rect; work: Rect; dpi: number }

export function monitorOf(hwnd: Hwnd): MonitorInfo {
  // MONITOR_DEFAULTTONEAREST
  const monitor = user32.MonitorFromWindow(hwnd as never, 2);
  const info = new Int32Array(10);
  info[0] = 40;
  user32.GetMonitorInfoW(monitor, ptr(info));
  const dpiX = new Uint32Array(1);
  const dpiY = new Uint32Array(1);
  // MDT_EFFECTIVE_DPI
  api.shcore.GetDpiForMonitor(monitor, 0, ptr(dpiX), ptr(dpiY));
  return {
    monitor: { left: info[1]!, top: info[2]!, right: info[3]!, bottom: info[4]! },
    work: { left: info[5]!, top: info[6]!, right: info[7]!, bottom: info[8]! },
    dpi: dpiX[0]!,
  };
}

export function primaryMonitor(): MonitorInfo {
  return monitorOf(0);
}

const AWARENESS = ["unaware", "system aware", "per-monitor aware"];

export function windowDpi(hwnd: Hwnd): { dpi: number; awareness: string } {
  const context = user32.GetWindowDpiAwarenessContext(hwnd as never);
  const awareness = context ? user32.GetAwarenessFromDpiAwarenessContext(context) : -1;
  return { dpi: user32.GetDpiForWindow(hwnd as never), awareness: AWARENESS[awareness] ?? `unknown (${awareness})` };
}

export function cursorPosition(): Point {
  const buffer = new Int32Array(2);
  user32.GetCursorPos(ptr(buffer));
  return { x: buffer[0]!, y: buffer[1]! };
}

const CURSOR_NAMES: Array<[string, number]> = [
  ["arrow", 32512], ["text", 32513], ["wait", 32514], ["crosshair", 32515],
  ["resize-nwse", 32642], ["resize-nesw", 32643], ["resize-ew", 32644], ["resize-ns", 32645],
  ["move", 32646], ["not-allowed", 32648], ["hand", 32649], ["progress", 32650],
];
let cursorHandles: Map<number, string> | null = null;

/** The shape of the cursor on screen now, by the system cursor it is, or its handle. */
export function cursorShape(): string {
  if (!cursorHandles) {
    cursorHandles = new Map();
    for (const [name, id] of CURSOR_NAMES) {
      const handle = Number(user32.LoadCursorW(null, id as never) ?? 0);
      if (handle) cursorHandles.set(handle, name);
    }
  }
  // CURSORINFO: cbSize, flags, hCursor (8 bytes, at 8), ptScreenPos.
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 24, true);
  if (!user32.GetCursorInfo(ptr(bytes))) return "unknown";
  if ((view.getUint32(4, true) & 1) === 0) return "hidden";
  const handle = Number(view.getBigUint64(8, true));
  return cursorHandles.get(handle) ?? `custom 0x${handle.toString(16)}`;
}

const HIT_TESTS: Record<number, string> = {
  [-2]: "transparent", [-1]: "error", 0: "nowhere", 1: "client", 2: "caption", 3: "sysmenu",
  8: "minimize", 9: "maximize", 10: "left", 11: "right", 12: "top", 13: "top-left", 14: "top-right",
  15: "bottom", 16: "bottom-left", 17: "bottom-right", 18: "border", 20: "close",
};

/**
 * Which window is under a screen point and what Windows says that point is
 * (WM_NCHITTEST): a resize border, the caption or client area.
 */
export function hitTest(point: Point): { window: WindowInfo | null; root: Hwnd; code: string } {
  const packed = (BigInt(point.y) << 32n) | (BigInt(point.x) & 0xffffffffn);
  const hwnd = Number(user32.WindowFromPoint(packed) ?? 0);
  if (!hwnd) return { window: null, root: 0, code: "none" };
  // GA_ROOT
  const root = Number(user32.GetAncestor(hwnd as never, 2) ?? 0);
  const result = new BigInt64Array(1);
  const lParam = BigInt(((point.y & 0xffff) << 16) | (point.x & 0xffff));
  // WM_NCHITTEST, SMTO_ABORTIFHUNG
  const ok = user32.SendMessageTimeoutW(hwnd as never, 0x0084, 0n, lParam, 0x0002, 500, ptr(result));
  const code = ok ? Number(BigInt.asIntN(32, result[0]!)) : NaN;
  return { window: windowInfo(hwnd), root, code: HIT_TESTS[code] ?? String(code) };
}

// --- Input ---------------------------------------------------------------

const INPUT_SIZE = 40;
const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_VIRTUALDESK = 0x4000;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;

function sendInputs(fill: (view: DataView, index: number) => void, count: number): void {
  const bytes = new Uint8Array(INPUT_SIZE * count);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < count; index += 1) fill(view, index * INPUT_SIZE);
  const sent = user32.SendInput(count, ptr(bytes), INPUT_SIZE);
  if (sent !== count) throw new Error(`SendInput sent ${sent} of ${count} events`);
}

function mouseInput(flags: number, point?: Point): void {
  const virtualLeft = user32.GetSystemMetrics(76);
  const virtualTop = user32.GetSystemMetrics(77);
  const virtualWidth = user32.GetSystemMetrics(78);
  const virtualHeight = user32.GetSystemMetrics(79);
  sendInputs((view, offset) => {
    view.setUint32(offset, 0, true); // INPUT_MOUSE
    if (point) {
      // The normalized coordinate that lands on this pixel, not the one before it.
      const dx = Math.ceil(((point.x - virtualLeft) * 65536) / virtualWidth);
      const dy = Math.ceil(((point.y - virtualTop) * 65536) / virtualHeight);
      view.setInt32(offset + 8, dx, true);
      view.setInt32(offset + 12, dy, true);
    }
    view.setUint32(offset + 20, flags | (point ? MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | MOUSEEVENTF_MOVE : 0), true);
  }, 1);
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function moveMouse(point: Point): void {
  mouseInput(0, point);
}

export function mouseDown(): void {
  mouseInput(MOUSEEVENTF_LEFTDOWN);
}

export function mouseUp(): void {
  mouseInput(MOUSEEVENTF_LEFTUP);
}

export async function click(point: Point, { double = false } = {}): Promise<void> {
  moveMouse(point);
  await sleep(60);
  for (let press = 0; press < (double ? 2 : 1); press += 1) {
    mouseDown();
    await sleep(40);
    mouseUp();
    await sleep(double ? 60 : 40);
  }
}

/**
 * Presses at `from`, moves to `to` in `steps` moves `stepMs` apart, runs
 * `whileHeld` with the button still down, then releases at `to`.
 */
export async function drag(
  from: Point,
  to: Point,
  { steps = 12, stepMs = 24, holdMs = 120, whileHeld }: { steps?: number; stepMs?: number; holdMs?: number; whileHeld?: () => Promise<void> } = {},
): Promise<void> {
  moveMouse(from);
  await sleep(120);
  mouseDown();
  await sleep(holdMs);
  for (let step = 1; step <= steps; step += 1) {
    moveMouse({
      x: Math.round(from.x + ((to.x - from.x) * step) / steps),
      y: Math.round(from.y + ((to.y - from.y) * step) / steps),
    });
    await sleep(stepMs);
  }
  await sleep(150);
  try {
    if (whileHeld) await whileHeld();
  } finally {
    mouseUp();
  }
}

const EXTENDED_KEYS = new Set([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e, 0x5b, 0x5c]);

function keyInput(vk: number, up: boolean): void {
  sendInputs((view, offset) => {
    view.setUint32(offset, 1, true); // INPUT_KEYBOARD
    view.setUint16(offset + 8, vk, true);
    view.setUint32(offset + 12, (up ? KEYEVENTF_KEYUP : 0) | (EXTENDED_KEYS.has(vk) ? KEYEVENTF_EXTENDEDKEY : 0), true);
  }, 1);
}

export const VK = {
  backspace: 0x08, tab: 0x09, enter: 0x0d, shift: 0x10, control: 0x11, alt: 0x12, escape: 0x1b,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28, win: 0x5b,
} as const;

/** Presses a chord: every key down in order, then up in reverse. Letters by their capital. */
export async function pressKeys(...keys: Array<number | string>): Promise<void> {
  const codes = keys.map((key) => typeof key === "number" ? key : key.toUpperCase().charCodeAt(0));
  for (const code of codes) {
    keyInput(code, false);
    await sleep(30);
  }
  for (const code of [...codes].reverse()) {
    keyInput(code, true);
    await sleep(30);
  }
}

/** Types letters, digits and spaces one key at a time, as a keyboard does. */
export async function typeText(text: string): Promise<void> {
  for (const char of text) {
    if (!/^[a-z0-9 ]$/i.test(char)) throw new Error(`typeText only types letters, digits and spaces: ${char}`);
    const upper = char !== char.toLowerCase();
    if (upper) await pressKeys(VK.shift, char);
    else await pressKeys(char === " " ? 0x20 : char);
    await sleep(40);
  }
}

// --- Screen pixels ---------------------------------------------------------

/** The pixels on screen in `rect`, RGBA. */
export function captureScreen(rect: Rect): Bitmap {
  const width = rectWidth(rect);
  const height = rectHeight(rect);
  if (width <= 0 || height <= 0) throw new Error(`Cannot capture an empty rect: ${JSON.stringify(rect)}`);
  const screen = user32.GetDC(null);
  const memory = gdi32.CreateCompatibleDC(screen);
  const bitmap = gdi32.CreateCompatibleBitmap(screen, width, height);
  const previous = gdi32.SelectObject(memory, bitmap);
  // SRCCOPY | CAPTUREBLT
  const copied = gdi32.BitBlt(memory, 0, 0, width, height, screen, rect.left, rect.top, 0x00cc0020 | 0x40000000);
  gdi32.SelectObject(memory, previous);
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  view.setUint32(0, 40, true);
  view.setInt32(4, width, true);
  view.setInt32(8, -height, true);
  view.setUint16(12, 1, true);
  view.setUint16(14, 32, true);
  const data = Buffer.alloc(width * height * 4);
  const lines = gdi32.GetDIBits(memory, bitmap, 0, height, ptr(data), ptr(header), 0);
  gdi32.DeleteObject(bitmap);
  gdi32.DeleteDC(memory);
  user32.ReleaseDC(null, screen);
  if (!copied || lines !== height) throw new Error(`Screen capture failed (copied ${copied}, lines ${lines} of ${height})`);
  for (let index = 0; index < data.length; index += 4) {
    const blue = data[index]!;
    data[index] = data[index + 2]!;
    data[index + 2] = blue;
    data[index + 3] = 255;
  }
  return { width, height, data };
}

export function screenRect(): Rect {
  const left = user32.GetSystemMetrics(76);
  const top = user32.GetSystemMetrics(77);
  return { left, top, right: left + user32.GetSystemMetrics(78), bottom: top + user32.GetSystemMetrics(79) };
}
