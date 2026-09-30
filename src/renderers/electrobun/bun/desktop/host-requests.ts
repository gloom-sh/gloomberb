import { Buffer } from "node:buffer";
import { ContextMenu, Utils, type BrowserWindow } from "electrobun/bun";
import { buildSoundCommand } from "../../../../notifications/app-notifier";
import type {
  DesktopBackendRequestResponse,
  DesktopHostRequest,
  DesktopWindowControlAction,
} from "../../shared/protocol";
import { safeExternalUrl } from "../../../../utils/external-url";
import { getContextMenuRequestId, normalizeContextMenuItems } from "../context-menu/normalize";
import { MAIN_WINDOW_RPC_KEY } from "../window/focus";
import { applyDesktopWindowControl } from "../window/controls";
import { saveTextFileToDownloads } from "../../../../utils/save-text-file";
import type { DesktopBackend, DesktopRpc } from "./backend";

function normalizeText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function playNotificationSound(sound: string | undefined): void {
  if (!sound) return;
  const command = buildSoundCommand(sound);
  if (!command) return;
  try {
    const child = Bun.spawn([command.command, ...command.args], { stdio: ["ignore", "ignore", "ignore"] });
    child.unref();
  } catch (error) {
    console.warn("notification sound failed", {
      command: command.command,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function windowForRpcKey(backend: DesktopBackend, windowKey: string | undefined): BrowserWindow | null {
  return windowKey === MAIN_WINDOW_RPC_KEY
    ? backend.mainWindow
    : backend.detachedWindows.getWindowForRpcKey(windowKey);
}

/**
 * Electrobun has no fullscreen event, so the view asks after every resize.
 * A runtime whose native library cannot answer reports windowed, which is the
 * layout the header held before it could ask at all.
 */
function isWindowFullscreen(backend: DesktopBackend, windowKey: string | undefined): boolean {
  try {
    return windowForRpcKey(backend, windowKey)?.isFullScreen?.() === true;
  } catch {
    return false;
  }
}

function controlWindow(
  backend: DesktopBackend,
  windowKey: string | undefined,
  action: DesktopWindowControlAction,
): boolean {
  const targetWindow = windowForRpcKey(backend, windowKey);
  if (!targetWindow) return false;
  if (action !== "close") {
    backend.detachedWindows.suppressAutoDockForRpcKey(windowKey);
  }
  applyDesktopWindowControl(targetWindow, action);
  return true;
}

/** Exiting closes the popped-out windows, services and main window; with no main window it quits directly. */
function exitDesktopApp(backend: DesktopBackend): void {
  backend.detachedWindows.closeAll();
  backend.teardownServices();
  const mainWindow = backend.mainWindow;
  if (mainWindow) {
    mainWindow.close();
    backend.mainWindow = null;
    return;
  }
  Utils.quit();
}

function normalizeWindowControlAction(action: unknown): DesktopWindowControlAction {
  if (action === "minimize" || action === "toggle-maximize" || action === "close") {
    return action;
  }
  throw new Error("host.windowControl requires a valid action.");
}

export async function handleDesktopHostRequest(
  backend: DesktopBackend,
  rpc: DesktopRpc,
  request: DesktopHostRequest,
): Promise<DesktopBackendRequestResponse<DesktopHostRequest["method"]>> {
  switch (request.method) {
    case "host.exit":
      exitDesktopApp(backend);
      return null;
    case "host.windowControl": {
      const action = normalizeWindowControlAction(request.payload.action);
      const windowKey = backend.rpcs.getRpcWindowKey(rpc);
      if (action === "close" && windowKey === MAIN_WINDOW_RPC_KEY) {
        exitDesktopApp(backend);
        return null;
      }
      if (!controlWindow(backend, windowKey, action)) {
        throw new Error("No desktop window is registered for this request.");
      }
      return null;
    }
    case "host.windowFullscreen":
      return isWindowFullscreen(backend, backend.rpcs.getRpcWindowKey(rpc));
    case "host.openExternal": {
      if (typeof request.payload.url !== "string") {
        throw new Error("host.openExternal requires a URL.");
      }
      const externalUrl = safeExternalUrl(request.payload.url);
      if (externalUrl) Utils.openExternal(externalUrl);
      return null;
    }
    case "host.copyText":
      Utils.clipboardWriteText(normalizeText(request.payload.text) ?? "");
      return null;
    case "host.focusWindow": {
      const windowKey = backend.rpcs.getRpcWindowKey(rpc);
      if (windowKey) backend.detachedWindows.focusWindowForRpcKey(windowKey);
      return null;
    }
    case "host.copyPngImage": {
      const pngBase64 = normalizeText(request.payload.pngBase64);
      if (!pngBase64) throw new Error("host.copyPngImage requires PNG data.");
      Utils.clipboardWriteImage(new Uint8Array(Buffer.from(pngBase64, "base64")));
      return null;
    }
    case "host.readText":
      return Utils.clipboardReadText() ?? "";
    case "host.saveTextFile": {
      if (typeof request.payload.name !== "string" || typeof request.payload.text !== "string") {
        throw new Error("host.saveTextFile requires a name and text.");
      }
      return saveTextFileToDownloads(request.payload.name, request.payload.text);
    }
    case "host.notify":
      playNotificationSound(normalizeText(request.payload.sound));
      Utils.showNotification({
        title: normalizeText(request.payload.title) ?? "Gloomberb",
        body: normalizeText(request.payload.body),
        subtitle: normalizeText(request.payload.subtitle),
        silent: true,
      });
      return null;
    case "host.showContextMenu": {
      const menu = normalizeContextMenuItems(request.payload.menu);
      if (menu.length === 0) return false;
      const requestId = getContextMenuRequestId(menu);
      if (requestId) backend.trackContextMenuRequest(requestId, rpc);
      ContextMenu.showContextMenu(menu as never);
      return true;
    }
    default: {
      const exhaustive: never = request;
      throw new Error(`Unknown host method: ${String(exhaustive)}`);
    }
  }
}
