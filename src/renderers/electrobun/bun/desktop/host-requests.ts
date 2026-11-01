import { Buffer } from "node:buffer";
import { ContextMenu, Utils, type BrowserWindow } from "electrobun/bun";
import { buildSoundCommand } from "../../../../notifications/app-notifier";
import type {
  DesktopBackendRequestResponse,
  DesktopHostRequest,
  DesktopWindowControlAction,
  DesktopWindowResizeEdge,
} from "../../shared/protocol";
import { safeExternalUrl } from "../../../../utils/external-url";
import { getContextMenuRequestId, normalizeContextMenuItems } from "../context-menu/normalize";
import { MAIN_WINDOW_RPC_KEY } from "../window/focus";
import { applyDesktopWindowControl } from "../window/controls";
import { startSystemWindowMove, startSystemWindowResize } from "../window/windows-native";
import { saveTextFileToDownloads } from "../../../../utils/save-text-file";
import { setAppBadge } from "./app-badge";
import { desktopBootFramePath, saveDesktopBootFrame } from "../window/boot-frame";
import { saveDesktopViewIds } from "./view-ids";
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
  return backend.nativeWindow(windowKey);
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

function isWindowMaximized(backend: DesktopBackend, windowKey: string | undefined): boolean {
  try {
    return windowForRpcKey(backend, windowKey)?.isMaximized?.() === true;
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

/** Exiting closes every window and the services, then quits. */
function exitDesktopApp(backend: DesktopBackend): void {
  backend.quit();
}

function normalizeWindowResizeEdge(edge: unknown): DesktopWindowResizeEdge {
  if (edge === "top" || edge === "top-left" || edge === "top-right") return edge;
  throw new Error("host.startWindowResize requires a top edge or corner.");
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
    case "host.windowMaximized":
      return isWindowMaximized(backend, backend.rpcs.getRpcWindowKey(rpc));
    case "host.startWindowDrag": {
      const targetWindow = windowForRpcKey(backend, backend.rpcs.getRpcWindowKey(rpc));
      if (!targetWindow?.ptr || !startSystemWindowMove(targetWindow.ptr)) {
        throw new Error("This window cannot be moved by the system.");
      }
      return null;
    }
    case "host.startWindowResize": {
      const edge = normalizeWindowResizeEdge(request.payload.edge);
      const targetWindow = windowForRpcKey(backend, backend.rpcs.getRpcWindowKey(rpc));
      if (!targetWindow?.ptr || !startSystemWindowResize(targetWindow.ptr, edge)) {
        throw new Error("This window cannot be resized by the system.");
      }
      return null;
    }
    case "host.openExternal": {
      if (typeof request.payload.url !== "string") {
        throw new Error("host.openExternal requires a URL.");
      }
      const externalUrl = safeExternalUrl(request.payload.url);
      return externalUrl ? Utils.openExternal(externalUrl) !== false : false;
    }
    case "host.copyText":
      Utils.clipboardWriteText(normalizeText(request.payload.text) ?? "");
      return null;
    case "host.focusWindow": {
      const windowKey = backend.rpcs.getRpcWindowKey(rpc);
      backend.focusWindow(windowKey);
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
        title: normalizeText(request.payload.title) ?? "Gloom",
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
    case "host.saveBootFrame":
      saveDesktopBootFrame(desktopBootFramePath(), request.payload.frame, {
        mainWindow: backend.rpcs.getRpcWindowKey(rpc) === MAIN_WINDOW_RPC_KEY,
        session: backend.config !== null,
      });
      return null;
    case "host.saveViewIds":
      // The main window's view keeps them; its popped-out panes share its storage.
      if (backend.rpcs.getRpcWindowKey(rpc) === MAIN_WINDOW_RPC_KEY && backend.config) {
        saveDesktopViewIds(backend.config.dataDir, request.payload.ids);
      }
      return null;
    case "host.setAppBadge":
      // One badge for the app, from the main window; a popped-out pane's view
      // has its own chat state and must not overwrite it.
      if (backend.rpcs.getRpcWindowKey(rpc) === MAIN_WINDOW_RPC_KEY) {
        setAppBadge(request.payload.label);
      }
      return null;
    default: {
      const exhaustive: never = request;
      throw new Error(`Unknown host method: ${String(exhaustive)}`);
    }
  }
}
