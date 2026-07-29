import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createAppServices, type AppServices } from "../../../../core/app-services";
import { getDesktopBackendPlugins } from "../../../../plugins/catalog-backend";
import type { AppSessionSnapshot } from "../../../../core/state/session-persistence";
import {
  getDataDir,
  initDataDir,
} from "../../../../data/config/store";
import type { AppConfig } from "../../../../types/config";
import type {
  DesktopSharedStateSnapshot,
  DesktopThemePreviewState,
} from "../../../../types/desktop-window";
import {
  loadDesktopPluginState,
} from "./plugin-state";
import {
  createDesktopWorkspace,
  type DesktopWorkspace,
} from "./workspace";
import {
  MAIN_WINDOW_RPC_KEY,
  paneIdFromDetachedRpcKey,
} from "../window/focus";
import type { DesktopBackendRequestPayload, ElectrobunBackendInit } from "../../shared/protocol";

interface DesktopWindowTarget {
  kind: "main" | "detached";
  paneId?: string;
}

interface InitializeDesktopBackendOptions<TRpc> {
  getCurrentConfig: () => AppConfig | null;
  getCurrentServices: () => AppServices | null;
  getDesktopSnapshot: () => DesktopSharedStateSnapshot | null;
  getDesktopWorkspace: () => DesktopWorkspace | null;
  getRpcWindowKey: (rpc: TRpc) => string | undefined;
  getSessionSnapshot: () => AppSessionSnapshot | null;
  getThemePreview: () => DesktopThemePreviewState;
  markWindowRpcReady: (rpc: TRpc) => void;
  payload: DesktopBackendRequestPayload<"init">;
  reconcileDetachedWindows: () => void;
  registerCoreCapabilities: () => void;
  rpc: TRpc;
  setCurrentConfig: (config: AppConfig) => void;
  setDesktopWorkspace: (workspace: DesktopWorkspace) => void;
  setServices: (services: AppServices) => void;
  syncConfigAccessors: () => void;
}

interface InitializationPayloadOptions {
  desktopThemePreview: DesktopThemePreviewState;
  getDesktopSnapshot: () => DesktopSharedStateSnapshot | null;
  getSessionSnapshot: () => AppSessionSnapshot | null;
}

function normalizeInitWindowTarget<TRpc>(
  rpc: TRpc,
  payload: DesktopBackendRequestPayload<"init">,
  getRpcWindowKey: (rpc: TRpc) => string | undefined,
): DesktopWindowTarget {
  const rpcKey = getRpcWindowKey(rpc);
  if (rpcKey === MAIN_WINDOW_RPC_KEY) return { kind: "main" };

  const detachedPaneId = paneIdFromDetachedRpcKey(rpcKey);
  if (detachedPaneId) {
    return {
      kind: "detached",
      paneId: detachedPaneId,
    };
  }

  const kind = payload.kind === "detached" ? "detached" : "main";
  return {
    kind,
    paneId: kind === "detached" && typeof payload.paneId === "string" && payload.paneId.length > 0
      ? payload.paneId
      : undefined,
  };
}

function buildInitializationPayload(
  config: AppConfig,
  services: AppServices,
  windowTarget: DesktopWindowTarget,
  options: InitializationPayloadOptions,
): ElectrobunBackendInit {
  return {
    config,
    sessionSnapshot: options.getSessionSnapshot(),
    desktopSnapshot: options.getDesktopSnapshot(),
    desktopThemePreview: options.desktopThemePreview,
    pluginState: loadDesktopPluginState(services.pluginRegistry),
    capabilityManifests: services.pluginRegistry.capabilities.manifests({ rendererOnly: true }),
    desktopPlatform: process.platform,
    windowKind: windowTarget.kind,
    paneId: windowTarget.paneId,
  };
}

async function resolveDesktopDataDir(): Promise<string> {
  const dataDir = await getDataDir() ?? join(process.env.HOME || homedir(), ".gloomberb");
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}

export async function initializeDesktopBackend<TRpc>(
  options: InitializeDesktopBackendOptions<TRpc>,
): Promise<ElectrobunBackendInit> {
  const windowTarget = normalizeInitWindowTarget(options.rpc, options.payload, options.getRpcWindowKey);
  options.markWindowRpcReady(options.rpc);

  const currentConfig = options.getCurrentConfig();
  const currentServices = options.getCurrentServices();
  if (currentConfig && currentServices) {
    if (!options.getDesktopWorkspace()) {
      options.setDesktopWorkspace(createDesktopWorkspace(currentConfig, options.getSessionSnapshot()));
      options.reconcileDetachedWindows();
    }
    return buildInitializationPayload(currentConfig, currentServices, windowTarget, {
      getDesktopSnapshot: options.getDesktopSnapshot,
      getSessionSnapshot: options.getSessionSnapshot,
      desktopThemePreview: options.getThemePreview(),
    });
  }

  options.setCurrentConfig(await initDataDir(await resolveDesktopDataDir()));
  const config = options.getCurrentConfig();
  if (!config) throw new Error("Desktop config failed to initialize.");

  const services = createAppServices({
    config,
    plugins: getDesktopBackendPlugins(),
  });
  options.setServices(services);
  options.syncConfigAccessors();
  options.registerCoreCapabilities();
  options.setDesktopWorkspace(createDesktopWorkspace(config, options.getSessionSnapshot()));
  options.reconcileDetachedWindows();

  return buildInitializationPayload(config, services, windowTarget, {
    getDesktopSnapshot: options.getDesktopSnapshot,
    getSessionSnapshot: options.getSessionSnapshot,
    desktopThemePreview: options.getThemePreview(),
  });
}
