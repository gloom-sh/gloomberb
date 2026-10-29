import { trace } from "./diag-trace";
import Electrobun, { ApplicationMenu, Screen, Utils } from "electrobun/bun";
import { homedir } from "os";
import { debugLog } from "../../../utils/debug-log";
import { setConfigStoreHost } from "../../../data/config/store";
import * as nodeConfigStoreHost from "../../../data/config/store/node";
import { ELECTROBUN_CONTEXT_MENU_ACTION } from "../shared/protocol";
import { contextMenuSelectionMessage } from "./context-menu/click";
import { applicationMenuCommand, createApplicationMenuGate } from "./application-menu/click";
import { DesktopBackend } from "./desktop/backend";
import { startDesktopBackend } from "./desktop/initialization";
import {
  MAIN_WINDOW_MIN_SIZE,
  defaultMainWindowFrame,
  normalizeWindowFrameWithMinimum,
} from "./window/frame";
import { MAIN_WINDOW_RPC_KEY } from "./window/focus";
import { createAppWindow } from "./window/create";
import { desktopBootFramePath, desktopBootFramePreload, readDesktopBootFrame } from "./window/boot-frame";
import { getWindowFrame } from "./window/events";
import {
  fitWindowFrameToDisplays,
  readRememberedDesktopWindow,
  rememberedDesktopWindowPath,
  writeRememberedDesktopWindow,
  type RememberedDesktopWindow,
} from "./window/remembered-frame";
import { reapStaleTerminalMedia } from "../../opentui/terminal-media";
import { quitWindowsEventLoopOnItsThread } from "./window/windows-quit";
import { installProcessCrashListeners } from "../../../telemetry/crash-reports-node";
import { renameLegacyMacApp } from "./desktop/app-name";
import { scheduleDesktopRelaunch } from "./desktop/relaunch";
import { settleInstallerFolder } from "./desktop/installer-folder";

console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);
console.warn = (...args) => console.error(...args);

// The Bun process has no Debug pane. An error logged here, such as a plugin
// that failed to import, would otherwise be invisible outside the view's
// marketplace row; the launcher log is where a desktop user can look.
debugLog.mirrorToConsole({ minLevel: "error" });

setConfigStoreHost(nodeConfigStoreHost);

// Electrobun exits this process on an uncaught exception; the listener goes
// ahead of it and spools the report for the next launch. Nothing is sent
// before the config, and its off switch, has been read.
installProcessCrashListeners();

// An install the Windows installer made lives in the installer's folder,
// where its shortcuts, the gloom command and its uninstall entry lead.
// Electrobun's updater installs an update into a folder of its own and opens
// it from there: this build moves into the installer's folder and opens again
// from it before any window shows.
trace("settle installer folder");
const installerFolderMove = await settleInstallerFolder({
  platform: process.platform,
  execPath: process.execPath,
  homeDir: homedir(),
  localAppData: process.env.LOCALAPPDATA,
}).catch((error: unknown) => {
  console.error("[desktop] could not move the app into the installer's folder", error instanceof Error ? error.message : String(error));
  return null;
});
if (installerFolderMove?.kind === "relaunching") {
  Utils.quit();
  await new Promise<never>(() => {});
}

// An install from before the rename runs from Gloomberb.app, where its updater
// put this build. It takes the new name and opens again from there before any
// window shows. Anywhere else this returns without touching the disk.
trace("rename legacy app");
const appRename = await renameLegacyMacApp({
  execPath: process.execPath,
  platform: process.platform,
  homeDir: homedir(),
  pathEnv: process.env.PATH ?? "",
}).catch((error: unknown) => {
  console.error("[desktop] could not give the app its new name", error instanceof Error ? error.message : String(error));
  return null;
});
if (appRename?.kind === "renamed") {
  await scheduleDesktopRelaunch(appRename.bundle);
  Utils.quit();
  // The process is exiting; nothing below may open a window meanwhile.
  await new Promise<never>(() => {});
} else if (appRename?.kind === "skipped") {
  console.error(`[desktop] kept the app's old name: ${appRename.reason}`);
}

function readOpenUrlEvent(event: unknown): string | null {
  const data = event && typeof event === "object" ? (event as { data?: unknown }).data : null;
  if (!data || typeof data !== "object") return null;
  const url = (data as { url?: unknown }).url;
  return typeof url === "string" && url ? url : null;
}

trace("new backend");
const backend = new DesktopBackend();
trace("backend made");

Electrobun.events.on("context-menu-clicked", (event: unknown) => {
  const message = contextMenuSelectionMessage(event, ELECTROBUN_CONTEXT_MENU_ACTION);
  if (!message) return;
  backend.selectContextMenuItem(message);
});

Electrobun.events.on("open-url", (event: unknown) => {
  const url = readOpenUrlEvent(event);
  if (!url) return;
  backend.openDeepLink(url);
});

const applicationMenuMayRun = createApplicationMenuGate();
ApplicationMenu.on("application-menu-clicked", (event: unknown) => {
  const command = applicationMenuCommand(event);
  if (!command || !applicationMenuMayRun(command)) return;
  backend.runApplicationMenuCommand(command);
});

trace("app menu");
backend.installApplicationMenu();
trace("app menu set");

// The desktop app never starts a terminal player, but it is usually the next
// thing launched after a terminal run left one behind, and until something
// reaps it that player keeps decoding video and flooding the terminal it was
// started from. Cleaning up here is what makes the stray actually die.
reapStaleTerminalMedia();

const mainRpc = backend.createWindowRpc(MAIN_WINDOW_RPC_KEY);
const rememberedWindowPath = rememberedDesktopWindowPath();
const rememberedWindow = readRememberedDesktopWindow(rememberedWindowPath);
const fallbackMainWindowFrame = defaultMainWindowFrame();
const initialMainWindowFrame = fitWindowFrameToDisplays(
  normalizeWindowFrameWithMinimum(rememberedWindow?.frame, fallbackMainWindowFrame, MAIN_WINDOW_MIN_SIZE),
  readDisplayWorkAreas(),
);

let windowedFrame = initialMainWindowFrame;
let rememberTimer: ReturnType<typeof setTimeout> | null = null;

function readDisplayWorkAreas() {
  try {
    return Screen.getAllDisplays().map((display) => ({
      x: display.workArea?.x ?? display.bounds.x,
      y: display.workArea?.y ?? display.bounds.y,
      width: display.workArea?.width ?? display.bounds.width,
      height: display.workArea?.height ?? display.bounds.height,
      primary: display.isPrimary,
    }));
  } catch {
    return [];
  }
}

function rememberedFromWindow(): RememberedDesktopWindow | null {
  const window = backend.mainWindow;
  const live = getWindowFrame(window) ?? windowedFrame;
  let minimized = false;
  let fullscreen = false;
  let maximized = false;
  try { minimized = window?.isMinimized() === true; } catch { minimized = false; }
  if (minimized) return null;
  try { fullscreen = window?.isFullScreen() === true; } catch { fullscreen = false; }
  try { maximized = !fullscreen && window?.isMaximized() === true; } catch { maximized = false; }
  if (!fullscreen && !maximized) windowedFrame = live;
  return { frame: windowedFrame, maximized, fullscreen };
}

function flushRememberedWindow(): void {
  if (rememberTimer) {
    clearTimeout(rememberTimer);
    rememberTimer = null;
  }
  const next = rememberedFromWindow();
  if (next) writeRememberedDesktopWindow(rememberedWindowPath, next);
}

function scheduleRememberedWindow(): void {
  if (rememberTimer) clearTimeout(rememberTimer);
  rememberTimer = setTimeout(() => {
    rememberTimer = null;
    const next = rememberedFromWindow();
    if (next) writeRememberedDesktopWindow(rememberedWindowPath, next);
  }, 300);
}

trace("create window");
const mainWindow = createAppWindow({
  title: "Gloom",
  frame: initialMainWindowFrame,
  rpc: mainRpc,
  minSize: MAIN_WINDOW_MIN_SIZE,
  onFrameChange: scheduleRememberedWindow,
  // The layout the window last drew, which its page draws before its script
  // has loaded (dom/boot-frame.ts).
  preload: desktopBootFramePreload(readDesktopBootFrame(desktopBootFramePath())),
});
trace("window created");
backend.mainWindow = mainWindow;
quitWindowsEventLoopOnItsThread(mainWindow);
// The window is loading its view; the services it will ask for start now
// rather than when it asks. Its `init` reports a failure, and retries.
trace("start backend");
startDesktopBackend(backend).then(() => trace("backend started")).catch((error) => {
  console.error("[desktop] startup failed", error instanceof Error ? error.stack ?? error.message : String(error));
});
// Windows has no way into fullscreen here, and builds whose frameless window
// Windows took for fullscreen saved every window as fullscreen.
if (rememberedWindow?.fullscreen && process.platform !== "win32") {
  try { mainWindow.setFullScreen(true); } catch { /* the framed window is still the one they sized */ }
} else if (rememberedWindow?.maximized) {
  try { mainWindow.maximize(); } catch { /* the framed window is still the one they sized */ }
}
(mainWindow as { on?: (event: "close", listener: () => void) => void }).on?.("close", flushRememberedWindow);
backend.detachedWindows.focusWindowForRpcKey(MAIN_WINDOW_RPC_KEY);
