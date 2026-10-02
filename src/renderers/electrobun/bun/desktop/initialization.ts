import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { getGloomberbHome } from "../../../../data/config/home";
import type { AppServices } from "../../../../core/app-services";
import { restoreExtractedPlugins } from "../../../../cli/restore-plugins";
import {
  getDataDir,
  initDataDir,
} from "../../../../data/config/store";
import type { AppConfig } from "../../../../types/config";
import {
  loadDesktopPluginState,
} from "./plugin-state";
import { createDesktopWorkspace } from "./workspace";
import {
  MAIN_WINDOW_RPC_KEY,
  paneIdFromDetachedRpcKey,
} from "../window/focus";
import type { DesktopBackendRequestPayload, ElectrobunBackendInit } from "../../shared/protocol";
import type { CapabilityRegistry } from "../../../../capabilities";
import { telemetryOptedOut } from "../../../../telemetry/crash-reports";
import { describeNodeOs, readOrCreateInstallId } from "../../../../telemetry/crash-reports-node";
import type { DesktopBackend, DesktopRpc } from "./backend";

interface DesktopWindowTarget {
  kind: "main" | "detached";
  paneId?: string;
}

function normalizeInitWindowTarget(
  rpcKey: string | undefined,
  payload: DesktopBackendRequestPayload<"init">,
): DesktopWindowTarget {
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

export function desktopRendererCapabilityManifests(registry: CapabilityRegistry) {
  return registry.manifests({ rendererOnly: true, includeDisabled: true });
}

function buildInitializationPayload(
  backend: DesktopBackend,
  config: AppConfig,
  services: AppServices,
  windowTarget: DesktopWindowTarget,
): ElectrobunBackendInit {
  return {
    config,
    sessionSnapshot: backend.getSessionSnapshot(),
    desktopSnapshot: backend.workspace?.getSnapshot() ?? null,
    desktopThemePreview: backend.stateBroadcaster.currentThemePreview,
    pluginState: loadDesktopPluginState(services.pluginRegistry),
    capabilityManifests: desktopRendererCapabilityManifests(services.pluginRegistry.capabilities),
    desktopPlatform: process.platform,
    windowKind: windowTarget.kind,
    paneId: windowTarget.paneId,
    telemetry: {
      installId: readOrCreateInstallId(config.dataDir),
      os: describeNodeOs(),
      homeDir: homedir(),
      optedOut: telemetryOptedOut(process.env),
    },
  };
}

async function resolveDesktopDataDir(): Promise<string> {
  const dataDir = await getDataDir() ?? getGloomberbHome();
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}

export async function initializeDesktopBackend(
  backend: DesktopBackend,
  rpc: DesktopRpc,
  payload: DesktopBackendRequestPayload<"init">,
): Promise<ElectrobunBackendInit> {
  const windowTarget = normalizeInitWindowTarget(backend.rpcs.getRpcWindowKey(rpc), payload);
  backend.rpcs.markWindowRpcReady(rpc);

  const currentConfig = backend.config;
  const currentServices = backend.services;
  if (currentConfig && currentServices) {
    if (!backend.workspace) {
      backend.workspace = createDesktopWorkspace(currentConfig, backend.getSessionSnapshot());
      backend.detachedWindows.reconcile();
    }
    return buildInitializationPayload(backend, currentConfig, currentServices, windowTarget);
  }

  const initialConfig = await initDataDir(await resolveDesktopDataDir());
  // Restore plugins that moved into their own repositories before the catalog
  // is read, the same as the terminal does at startup. Without it a
  // desktop-only user silently loses a feature the day it is extracted, since
  // nothing else installs it for them.
  const seededPlugins = await restoreExtractedPlugins();
  const { config, services } = await backend.startServices(
    seededPlugins ? { ...initialConfig, seededPlugins } : initialConfig,
  );
  return buildInitializationPayload(backend, config, services, windowTarget);
}
