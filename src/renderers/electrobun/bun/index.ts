import Electrobun, { ApplicationMenu, Utils } from "electrobun/bun";
import { homedir } from "os";
import { debugLog } from "../../../utils/debug-log";
import { setConfigStoreHost } from "../../../data/config/store";
import * as nodeConfigStoreHost from "../../../data/config/store/node";
import { ELECTROBUN_CONTEXT_MENU_ACTION } from "../shared/protocol";
import { contextMenuSelectionMessage } from "./context-menu/click";
import { applicationMenuCommand, createApplicationMenuGate } from "./application-menu/click";
import { DesktopBackend } from "./desktop/backend";
import { startDesktopBackend } from "./desktop/initialization";
import { reapStaleTerminalMedia } from "../../opentui/terminal-media";
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

const backend = new DesktopBackend();

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

backend.installApplicationMenu();

// The desktop app never starts a terminal player, but it is usually the next
// thing launched after a terminal run left one behind, and until something
// reaps it that player keeps decoding video and flooding the terminal it was
// started from. Cleaning up here is what makes the stray actually die.
reapStaleTerminalMedia();

// The main window opens where it was left on these screens; extra windows
// follow once it has its data (desktop/window-controller.ts).
backend.startWindows();
// The window is loading its view; the services it will ask for start now
// rather than when it asks. Its `init` reports a failure, and retries.
startDesktopBackend(backend).catch((error) => {
  console.error("[desktop] startup failed", error instanceof Error ? error.stack ?? error.message : String(error));
});
