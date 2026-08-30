import { Buffer } from "node:buffer";
import { ContextMenu, Utils, type BrowserWindow } from "electrobun/bun";
import { buildSoundCommand } from "../../../../notifications/app-notifier";
import type {
  DesktopBackendRequestResponse,
  DesktopHostRequest,
  DesktopRestartMessage,
  DesktopWindowControlAction,
} from "../../shared/protocol";
import { safeExternalUrl } from "../../../../utils/external-url";
import { getContextMenuRequestId, normalizeContextMenuItems } from "../context-menu/normalize";
import { MAIN_WINDOW_RPC_KEY } from "../window/focus";
import { saveTextFileToDownloads } from "../../../../utils/save-text-file";

interface DesktopHostRequestOptions<TRpc> {
  clearMainWindow: () => void;
  closeAllDetachedWindows: () => void;
  controlWindowForRpcKey: (windowKey: string | undefined, action: DesktopWindowControlAction) => boolean;
  focusWindowForRpcKey: (windowKey: string) => void;
  getMainWindow: () => BrowserWindow | null;
  getRpcWindowKey: (rpc: TRpc) => string | undefined;
  request: DesktopHostRequest;
  restartDesktopApp: (message?: DesktopRestartMessage) => void;
  rpc: TRpc;
  teardownServices: () => void;
  trackContextMenuRequest: (requestId: string, rpc: TRpc) => void;
}

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

function normalizeWindowControlAction(action: unknown): DesktopWindowControlAction {
  if (action === "minimize" || action === "toggle-maximize" || action === "close") {
    return action;
  }
  throw new Error("host.windowControl requires a valid action.");
}

export async function handleDesktopHostRequest<TRpc>({
  clearMainWindow,
  closeAllDetachedWindows,
  controlWindowForRpcKey,
  focusWindowForRpcKey,
  getMainWindow,
  getRpcWindowKey,
  request,
  restartDesktopApp,
  rpc,
  teardownServices,
  trackContextMenuRequest,
}: DesktopHostRequestOptions<TRpc>): Promise<DesktopBackendRequestResponse<DesktopHostRequest["method"]>> {
  switch (request.method) {
    case "host.restart":
      restartDesktopApp({
        reason: typeof request.payload.reason === "string" ? request.payload.reason : undefined,
        source: typeof request.payload.source === "string" ? request.payload.source : "backend-request",
      });
      return null;
    case "host.exit": {
      closeAllDetachedWindows();
      teardownServices();
      const mainWindow = getMainWindow();
      if (mainWindow) {
        mainWindow.close();
        clearMainWindow();
        return null;
      }
      Utils.quit();
      return null;
    }
    case "host.windowControl": {
      const action = normalizeWindowControlAction(request.payload.action);
      const windowKey = getRpcWindowKey(rpc);
      if (action === "close" && windowKey === MAIN_WINDOW_RPC_KEY) {
        closeAllDetachedWindows();
        teardownServices();
        const mainWindow = getMainWindow();
        if (mainWindow) {
          mainWindow.close();
          clearMainWindow();
          return null;
        }
        Utils.quit();
        return null;
      }
      if (!controlWindowForRpcKey(windowKey, action)) {
        throw new Error("No desktop window is registered for this request.");
      }
      return null;
    }
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
      const windowKey = getRpcWindowKey(rpc);
      if (windowKey) focusWindowForRpcKey(windowKey);
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
      if (requestId) trackContextMenuRequest(requestId, rpc);
      ContextMenu.showContextMenu(menu as never);
      return true;
    }
    default: {
      const exhaustive: never = request;
      throw new Error(`Unknown host method: ${String(exhaustive)}`);
    }
  }
}
