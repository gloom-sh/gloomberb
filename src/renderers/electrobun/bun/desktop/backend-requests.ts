import Electrobun from "electrobun/bun";
import {
  exportConfig,
  importConfig,
  resetAllData,
  saveConfig,
} from "../../../../data/config/store";
import type { UpdateProgress } from "../../../../updater";
import { deleteBrokerAccountRecord, saveBrokerAccountRecord } from "../../../../brokers/account-cache";
import type {
  DesktopBackendRequestResponse,
  DesktopCoreRequest,
} from "../../shared/protocol";
import { encodeRpcValue } from "../../shared/rpc-codec";
import { desktopBootFramePath, removeDesktopBootFrame } from "../window/boot-frame";
import { MAIN_WINDOW_RPC_KEY, paneIdFromDetachedRpcKey } from "../window/focus";
import type { DesktopBackend, DesktopRpc } from "./backend";
import { createElectrobunDesktopUpdater } from "./update";

const desktopUpdater = createElectrobunDesktopUpdater(Electrobun.Updater);

function sendUpdateProgress(rpc: DesktopRpc, progress: UpdateProgress): void {
  try {
    rpc.send["update.progress"]({
      progress: encodeRpcValue(progress) as UpdateProgress,
    });
  } catch (error) {
    console.warn("update progress send failed", error);
  }
}

/**
 * Every window but the main one closes, and the workspace and services go,
 * before the data they read is replaced. Extra windows open again with the
 * next session where their tabs are still there.
 */
function closeDesktopSession(backend: DesktopBackend): void {
  backend.closeAllWindows();
  backend.workspace = null;
  backend.teardownServices();
}

export async function handleDesktopBackendRequest(
  backend: DesktopBackend,
  rpc: DesktopRpc,
  request: DesktopCoreRequest,
): Promise<DesktopBackendRequestResponse<DesktopCoreRequest["method"]>> {
  switch (request.method) {
    case "update.check":
      return desktopUpdater.check(
        typeof request.payload.currentVersion === "string" ? request.payload.currentVersion : "",
        request.payload.channel === "nightly" ? "nightly" : "stable",
      );
    case "update.start":
      void desktopUpdater.download(request.payload.release, (progress) => sendUpdateProgress(rpc, progress));
      return null;
    case "update.apply":
      // Only the main window offers Restart; a popped-out window never relaunches the app.
      if (paneIdFromDetachedRpcKey(backend.rpcs.getRpcWindowKey(rpc))) return null;
      void desktopUpdater.apply((progress) => sendUpdateProgress(rpc, progress));
      return null;
    case "ticker.loadAll":
      return backend.requireServices().tickerRepository.loadAllTickers();
    case "ticker.load":
      return backend.requireServices().tickerRepository.loadTicker(request.payload.symbol);
    case "ticker.save":
      await backend.requireServices().tickerRepository.saveTicker(request.payload.ticker);
      return null;
    case "ticker.delete":
      await backend.requireServices().tickerRepository.deleteTicker(request.payload.symbol);
      return null;
    case "config.save": {
      const desktopWorkspace = backend.workspace;
      if (desktopWorkspace) {
        // A popped-out window's save counts only for its own pane; a full
        // window's for what it changed, among its own tabs.
        const senderKey = backend.rpcs.getRpcWindowKey(rpc);
        const senderDetachedPaneId = paneIdFromDetachedRpcKey(senderKey);
        await backend.commitDesktopSnapshot(senderDetachedPaneId
          ? desktopWorkspace.replaceConfigFromDetachedPane(senderDetachedPaneId, request.payload.config)
          : desktopWorkspace.replaceConfigFromWindow(senderKey ?? MAIN_WINDOW_RPC_KEY, request.payload.config));
        return null;
      }
      backend.setConfig(request.payload.config);
      await saveConfig(backend.requireConfig());
      return null;
    }
    case "config.resetAllData":
      closeDesktopSession(backend);
      // No config, no session: a frame the closing window still sends is dropped.
      backend.config = null;
      removeDesktopBootFrame(desktopBootFramePath());
      await resetAllData(request.payload.dataDir);
      return null;
    case "config.export": {
      // With more than one window, each has only its own tabs: the export is
      // the whole config, every window's tabs included.
      const workspace = backend.workspace;
      const config = workspace && workspace.windowIds().length > 1 ? workspace.getSnapshot().config : request.payload.config;
      await exportConfig(config, request.payload.destPath);
      return null;
    }
    case "config.import": {
      closeDesktopSession(backend);
      await backend.startServices(await importConfig(request.payload.dataDir, request.payload.srcPath));
      backend.stateBroadcaster.sendDesktopState(backend.requireWorkspace().getSnapshot());
      return backend.requireConfig();
    }
    case "session.set":
      backend.requireServices().persistence.sessions.set(
        request.payload.sessionId,
        request.payload.value,
        request.payload.schemaVersion,
      );
      return null;
    case "session.delete":
      backend.requireServices().persistence.sessions.delete(request.payload.sessionId);
      return null;
    case "resources.set":
      saveBrokerAccountRecord(backend.requireServices().persistence.resources, request.payload.record);
      return null;
    case "resources.delete":
      deleteBrokerAccountRecord(backend.requireServices().persistence.resources, request.payload.key);
      return null;
    default: {
      const exhaustive: never = request;
      throw new Error(`Unknown core backend method: ${String(exhaustive)}`);
    }
  }
}
