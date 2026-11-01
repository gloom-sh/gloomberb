import { BrowserView, BrowserWindow } from "electrobun/bun";
import { measurePerf } from "../../../../utils/perf-marks";

/**
 * Electrobun's window and webview calls that go to the native layer. On
 * Windows each one is answered on the thread that runs the windows, and this
 * process waits for it: while that thread is busy, so is this one.
 */
const WINDOW_CALLS = [
  "activate", "close", "show", "showInactive", "hide", "minimize", "unminimize", "maximize", "unmaximize",
  "isMinimized", "isMaximized", "isFullScreen", "setFullScreen", "isAlwaysOnTop", "setAlwaysOnTop",
  "setTitle", "setPosition", "setSize", "setFrame", "getFrame",
];
const VIEW_CALLS = [
  "executeJavascript", "loadURL", "loadHTML", "setNavigationRules", "openDevTools", "closeDevTools", "toggleDevTools",
  "setPageZoom",
];

let measured = false;

/** `getFrame` as a stall report keeps it: `get-frame`. */
function sectionPart(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function measureCalls(prototype: object, prefix: string, names: readonly string[]): void {
  const methods = prototype as Record<string, unknown>;
  for (const name of names) {
    const original = methods[name];
    if (typeof original !== "function") continue;
    const section = `${prefix}.${sectionPart(name)}`;
    methods[name] = function measuredNativeCall(this: unknown, ...args: unknown[]) {
      return measurePerf(section, () => original.apply(this, args));
    };
  }
}

/**
 * Names each native window and webview call (`native.window.get-frame`,
 * `native.view.execute-javascript`), so a stall inside or right after one
 * says so instead of naming whatever was measured last. Once per process.
 */
export function measureNativeWindowCalls(): void {
  if (measured) return;
  measured = true;
  measureCalls(BrowserWindow.prototype, "native.window", WINDOW_CALLS);
  measureCalls(BrowserView.prototype, "native.view", VIEW_CALLS);
}
