import { createAppServices, type AppServices } from "../../../../core/app-services";
import { getDesktopBackendPlugins } from "../../../../plugins/catalog-backend";
import type { AppSessionSnapshot } from "../../../../core/state/session-persistence";
import {
  exportConfig,
  importConfig,
  resetAllData,
  saveConfig,
} from "../../../../data/config/store";
import type { AppConfig } from "../../../../types/config";
import type { DesktopSharedStateSnapshot } from "../../../../types/desktop-window";
import type {
  DesktopBackendRequestPayload,
  DesktopBackendRequestResponse,
  DesktopCoreRequest,
} from "../../shared/protocol";
import {
  checkElectrobunDesktopUpdate,
} from "./update";
import {
  createDesktopWorkspace,
  type DesktopWorkspace,
} from "./workspace";

interface DesktopBackendRequestOptions {
  clearCurrentConfig: () => void;
  closeAllDetachedWindows: () => void;
  commitDesktopSnapshot: (snapshot: DesktopSharedStateSnapshot) => Promise<DesktopSharedStateSnapshot>;
  getConfig: () => AppConfig;
  getDesktopWorkspace: () => DesktopWorkspace | null;
  getServices: () => AppServices;
  getSessionSnapshot: () => AppSessionSnapshot | null;
  request: DesktopCoreRequest;
  reconcileDetachedWindows: () => void;
  registerCoreCapabilities: () => void;
  sendDesktopState: (snapshot: DesktopSharedStateSnapshot) => void;
  setCurrentConfig: (config: AppConfig) => void;
  setDesktopWorkspace: (workspace: DesktopWorkspace | null) => void;
  setServices: (services: AppServices) => void;
  startUpdate: (currentVersion: string) => void;
  syncConfigAccessors: () => void;
  teardownServices: () => void;
}

async function importDesktopConfig({
  closeAllDetachedWindows,
  getConfig,
  getSessionSnapshot,
  reconcileDetachedWindows,
  registerCoreCapabilities,
  sendDesktopState,
  setCurrentConfig,
  setDesktopWorkspace,
  setServices,
  syncConfigAccessors,
  teardownServices,
}: DesktopBackendRequestOptions,
  payload: DesktopBackendRequestPayload<"config.import">,
): Promise<AppConfig> {
  closeAllDetachedWindows();
  setDesktopWorkspace(null);
  teardownServices();
  setCurrentConfig(await importConfig(payload.dataDir, payload.srcPath));
  setServices(createAppServices({
    config: getConfig(),
    plugins: getDesktopBackendPlugins(),
  }));
  syncConfigAccessors();
  registerCoreCapabilities();
  const desktopWorkspace = createDesktopWorkspace(getConfig(), getSessionSnapshot());
  setDesktopWorkspace(desktopWorkspace);
  reconcileDetachedWindows();
  sendDesktopState(desktopWorkspace.getSnapshot());
  return getConfig();
}

export async function handleDesktopBackendRequest(
  options: DesktopBackendRequestOptions,
): Promise<DesktopBackendRequestResponse<DesktopCoreRequest["method"]>> {
  const {
    clearCurrentConfig,
    closeAllDetachedWindows,
    commitDesktopSnapshot,
    getConfig,
    getDesktopWorkspace,
    getServices,
    request,
    setCurrentConfig,
    setDesktopWorkspace,
    startUpdate,
    teardownServices,
  } = options;

  switch (request.method) {
    case "update.check":
      return checkElectrobunDesktopUpdate(
        typeof request.payload.currentVersion === "string" ? request.payload.currentVersion : "",
      );
    case "update.start": {
      const { release, currentVersion } = request.payload;
      startUpdate(typeof currentVersion === "string" ? currentVersion : release.version);
      return null;
    }
    case "ticker.loadAll":
      return getServices().tickerRepository.loadAllTickers();
    case "ticker.load":
      return getServices().tickerRepository.loadTicker(request.payload.symbol);
    case "ticker.save":
      await getServices().tickerRepository.saveTicker(request.payload.ticker);
      return null;
    case "ticker.delete":
      await getServices().tickerRepository.deleteTicker(request.payload.symbol);
      return null;
    case "config.save": {
      setCurrentConfig(request.payload.config);
      const desktopWorkspace = getDesktopWorkspace();
      if (desktopWorkspace) {
        await commitDesktopSnapshot(desktopWorkspace.replaceConfig(getConfig(), { layoutChanged: true }));
        return null;
      }
      await saveConfig(getConfig());
      return null;
    }
    case "config.resetAllData":
      closeAllDetachedWindows();
      setDesktopWorkspace(null);
      teardownServices();
      clearCurrentConfig();
      await resetAllData(request.payload.dataDir);
      return null;
    case "config.export":
      await exportConfig(request.payload.config, request.payload.destPath);
      return null;
    case "config.import":
      return importDesktopConfig(options, request.payload);
    case "session.set":
      getServices().persistence.sessions.set(
        request.payload.sessionId,
        request.payload.value,
        request.payload.schemaVersion,
      );
      return null;
    case "session.delete":
      getServices().persistence.sessions.delete(request.payload.sessionId);
      return null;
    default: {
      const exhaustive: never = request;
      throw new Error(`Unknown core backend method: ${String(exhaustive)}`);
    }
  }
}
