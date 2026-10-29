import { BrowserWindow } from "electrobun/bun";
import {
  applyNativeWindowFrame,
  applyWindowMoveEvent,
  applyWindowResizeEvent,
  updateWindowFrameCache,
  type WindowMoveEvent,
  type WindowResizeEvent,
} from "./events";
import type { WindowFrame, WindowMinimumSize } from "./frame";
import { applyWindowsCustomChrome } from "./windows-custom-chrome";
import { applyWindowsWindowIcon } from "./windows-icons";

type DesktopTitleBarStyle = "default" | "hidden" | "hiddenInset";
type DesktopWindowRenderer = "native" | "cef";
type DesktopWindowStyleMask = {
  Borderless?: boolean;
  Closable?: boolean;
  Miniaturizable?: boolean;
  Titled?: boolean;
  FullSizeContentView?: boolean;
};

function desktopTitleBarStyle(): DesktopTitleBarStyle {
  return process.platform === "darwin" ? "hiddenInset" : "hidden";
}

function desktopWindowRenderer(): DesktopWindowRenderer {
  if (process.platform === "win32") {
    const hostArchitecture = process.env.PROCESSOR_ARCHITEW6432 ?? process.env.PROCESSOR_ARCHITECTURE;
    return hostArchitecture?.toLowerCase() === "arm64" ? "native" : "cef";
  }
  return "native";
}

function desktopWindowStyleMask(): DesktopWindowStyleMask {
  if (process.platform !== "win32") return {};
  return {
    Borderless: true,
    Closable: false,
    Miniaturizable: false,
    Titled: false,
    FullSizeContentView: true,
  };
}

const APP_VIEW_URL = "views://mainview/index.html";

/**
 * Electrobun's Windows webview takes a page load that starts while Ctrl is
 * down for a Ctrl+click on a link: it cancels the load and asks for a new
 * window instead. A window opened from a Ctrl chord, as Ctrl+Shift+O pops a
 * pane out, stayed blank. Its page is loaded again, which Electrobun lets
 * through within half a second of the one it cancelled.
 */
function loadAgainWhenTakenForCtrlClick(window: BrowserWindow): void {
  (window.webview as { on: (name: string, handler: (event: unknown) => void) => void }).on("new-window-open", (event) => {
    const detail = (event as { data?: { detail?: { url?: unknown } } }).data?.detail;
    if (detail?.url === APP_VIEW_URL) window.webview.loadURL(APP_VIEW_URL);
  });
}

interface AppWindowOptions {
  title: string;
  /** Already normalized to at least `minSize`. */
  frame: WindowFrame;
  rpc: NonNullable<ConstructorParameters<typeof BrowserWindow>[0]>["rpc"];
  minSize: WindowMinimumSize;
  /** Runs after each move or resize has been applied to the cached frame. */
  onFrameChange?: () => void;
  /** Script run in the page before its own. */
  preload?: string;
}

/**
 * Opens a window on the app view with this platform's chrome and icon, keeps
 * its cached frame current as it moves, and holds it to `minSize` on resize.
 */
export function createAppWindow({ title, frame, rpc, minSize, onFrameChange, preload }: AppWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    title,
    frame,
    url: APP_VIEW_URL,
    ...(preload ? { preload } : {}),
    renderer: desktopWindowRenderer(),
    rpc,
    styleMask: desktopWindowStyleMask(),
    titleBarStyle: desktopTitleBarStyle(),
    navigationRules: JSON.stringify(["views://*"]),
    sandbox: false,
  });
  applyWindowsWindowIcon(title);
  applyWindowsCustomChrome(title);
  if (process.platform === "win32") loadAgainWhenTakenForCtrlClick(window);
  updateWindowFrameCache(window, frame, minSize);
  const readsNativeFrame = process.platform === "win32";
  (window as any).on?.("move", (event: WindowMoveEvent) => {
    if (readsNativeFrame) {
      if (!applyNativeWindowFrame(window, minSize)) return;
    } else {
      applyWindowMoveEvent(window, event);
    }
    onFrameChange?.();
  });
  (window as any).on?.("resize", (event: WindowResizeEvent) => {
    if (readsNativeFrame) {
      if (!applyNativeWindowFrame(window, minSize)) return;
    } else {
      applyWindowResizeEvent(window, event, minSize);
    }
    onFrameChange?.();
  });
  return window;
}
