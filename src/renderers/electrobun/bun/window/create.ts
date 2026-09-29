import { BrowserWindow } from "electrobun/bun";
import {
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

interface AppWindowOptions {
  title: string;
  /** Already normalized to at least `minSize`. */
  frame: WindowFrame;
  rpc: NonNullable<ConstructorParameters<typeof BrowserWindow>[0]>["rpc"];
  minSize: WindowMinimumSize;
  /** Runs after each move or resize has been applied to the cached frame. */
  onFrameChange?: () => void;
}

/**
 * Opens a window on the app view with this platform's chrome and icon, keeps
 * its cached frame current as it moves, and holds it to `minSize` on resize.
 */
export function createAppWindow({ title, frame, rpc, minSize, onFrameChange }: AppWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    title,
    frame,
    url: "views://mainview/index.html",
    renderer: desktopWindowRenderer(),
    rpc,
    styleMask: desktopWindowStyleMask(),
    titleBarStyle: desktopTitleBarStyle(),
    navigationRules: JSON.stringify(["views://*"]),
    sandbox: false,
  });
  applyWindowsWindowIcon(title);
  applyWindowsCustomChrome(title);
  updateWindowFrameCache(window, frame, minSize);
  (window as any).on?.("move", (event: WindowMoveEvent) => {
    applyWindowMoveEvent(window, event);
    onFrameChange?.();
  });
  (window as any).on?.("resize", (event: WindowResizeEvent) => {
    applyWindowResizeEvent(window, event, minSize);
    onFrameChange?.();
  });
  return window;
}
