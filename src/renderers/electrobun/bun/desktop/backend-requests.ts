import {
  exportConfig,
  importConfig,
  resetAllData,
  saveConfig,
} from "../../../../data/config/store";
import type { UpdateProgress } from "../../../../updater";
import type {
  DesktopBackendRequestResponse,
  DesktopCoreRequest,
} from "../../shared/protocol";
import { encodeRpcValue } from "../../view/rpc-codec";
import { paneIdFromDetachedRpcKey } from "../window/focus";
import type { DesktopBackend, DesktopRpc } from "./backend";
import {
  checkElectrobunDesktopUpdate,
  runElectrobunDesktopUpdate,
} from "./update";

function sendUpdateProgress(rpc: DesktopRpc, progress: UpdateProgress): void {
  try {
    rpc.send["update.progress"]({
      progress: encodeRpcValue(progress) as UpdateProgress,
    });
  } catch (error) {
    console.warn("update progress send failed", error);
  }
}

/** Every window loses its popped-out panes, workspace and services before the data they read is replaced. */
function closeDesktopSession(backend: DesktopBackend): void {
  backend.detachedWindows.closeAll();
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
      return checkElectrobunDesktopUpdate(
        typeof request.payload.currentVersion === "string" ? request.payload.currentVersion : "",
      );
    case "update.start": {
      const { release, currentVersion } = request.payload;
      void runElectrobunDesktopUpdate(
        typeof currentVersion === "string" ? currentVersion : release.version,
        (progress) => sendUpdateProgress(rpc, progress),
      );
      return null;
    }
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
        // Null for the main window; a popped-out window's save counts only for its own pane.
        const senderDetachedPaneId = paneIdFromDetachedRpcKey(backend.rpcs.getRpcWindowKey(rpc));
        await backend.commitDesktopSnapshot(senderDetachedPaneId
          ? desktopWorkspace.replaceConfigFromDetachedPane(senderDetachedPaneId, request.payload.config)
          : desktopWorkspace.replaceConfig(request.payload.config, { layoutChanged: true }));
        return null;
      }
      backend.setConfig(request.payload.config);
      await saveConfig(backend.requireConfig());
      return null;
    }
    case "config.resetAllData":
      closeDesktopSession(backend);
      backend.config = null;
      await resetAllData(request.payload.dataDir);
      return null;
    case "config.export":
      await exportConfig(request.payload.config, request.payload.destPath);
      return null;
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
    default: {
      const exhaustive: never = request;
      throw new Error(`Unknown core backend method: ${String(exhaustive)}`);
    }
  }
}
