import { existsSync, mkdirSync } from "fs";
import { homedir, hostname } from "os";
import { getGloomberbDirs } from "../../../../data/config/home";
import type { AppServices } from "../../../../core/app-services";
import { restoreExtractedPlugins } from "../../../../cli/restore-plugins";
import { takePluginSeedNotice } from "../../../../plugins/seed-notice";
import {
  getDataDir,
  initDataDir,
} from "../../../../data/config/store";
import type { AppConfig } from "../../../../types/config";
import { listPersistedBrokerAccountRecords } from "../../../../brokers/account-cache";
import type { CachedResourceRecord } from "../../../../data/resource-store";
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
import { readDesktopViewIds } from "./view-ids";
import { markStartupComplete } from "../../../../utils/main-thread-stall";

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

/** The view's resource store lives in memory; it starts from the account snapshots saved here. */
function loadSavedResources(services: AppServices, config: AppConfig): CachedResourceRecord[] {
  try {
    return listPersistedBrokerAccountRecords(services.persistence.resources, config.brokerInstances);
  } catch (error) {
    console.warn("saved broker accounts could not be read", error);
    return [];
  }
}

function buildInitializationPayload(
  backend: DesktopBackend,
  config: AppConfig,
  services: AppServices,
  windowTarget: DesktopWindowTarget,
): ElectrobunBackendInit {
  // The main window says once what the launch's seed could not install.
  const pluginSeedNotice = windowTarget.kind === "main" ? takePluginSeedNotice() : null;
  return {
    config,
    sessionSnapshot: backend.getSessionSnapshot(),
    desktopSnapshot: backend.workspace?.getSnapshot() ?? null,
    desktopThemePreview: backend.stateBroadcaster.currentThemePreview,
    pluginState: loadDesktopPluginState(services.pluginRegistry),
    savedResources: loadSavedResources(services, config),
    capabilityManifests: desktopRendererCapabilityManifests(services.pluginRegistry.capabilities),
    desktopPlatform: process.platform,
    hostName: hostname(),
    windowKind: windowTarget.kind,
    paneId: windowTarget.paneId,
    ...(pluginSeedNotice ? { pluginSeedNotice } : {}),
    telemetry: {
      installId: readOrCreateInstallId(config.dataDir),
      os: describeNodeOs(),
      homeDir: homedir(),
      optedOut: telemetryOptedOut(process.env),
    },
    viewIds: readDesktopViewIds(config.dataDir),
  };
}

async function resolveDesktopDataDir(): Promise<string> {
  const dataDir = await getDataDir() ?? getGloomberbDirs().data;
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}

/** The launch work, in order. Injected so a test can watch the order without a data folder. */
export interface DesktopLaunchSteps {
  readConfig(): Promise<AppConfig>;
  /** Installs plugins that moved into their own repositories; returns the seed record to merge. */
  restorePlugins(): Promise<Partial<AppConfig> | null>;
  startServices(config: AppConfig): Promise<unknown>;
  /** Starts compiling the plugins for the view; not awaited. */
  prefetchPluginBundles(): void;
}

function desktopLaunchSteps(backend: DesktopBackend): DesktopLaunchSteps {
  return {
    readConfig: async () => initDataDir(await resolveDesktopDataDir()),
    // Restore plugins that moved into their own repositories before the
    // catalog is read, the same as the terminal does at startup. Without it a
    // desktop-only user silently loses a feature the day it is extracted,
    // since nothing else installs it for them.
    restorePlugins: restoreExtractedPlugins,
    startServices: (config) => backend.startServices(config),
    prefetchPluginBundles: () => backend.prefetchExternalPluginBundles(),
  };
}

const launches = new WeakMap<object, Promise<void>>();

/**
 * Opens the data folder and starts the services every window shares: the
 * config, restored plugins, and every plugin registered. That takes most of
 * a second, and it used to wait for the view to load its bundle and ask for
 * `init`. Started when the process starts, it runs while the window opens
 * and the view loads, and `init` finds it done or nearly so. The plugins the
 * view runs then start compiling, still before the view asks for them, and
 * after the services imported them, so two loads never link one plugin at once.
 *
 * Callers share a run in flight. With the services up it does nothing; after
 * they were torn down (all data reset) or a run failed, it starts over.
 */
export function startDesktopBackend(
  backend: DesktopBackend,
  steps: DesktopLaunchSteps = desktopLaunchSteps(backend),
): Promise<void> {
  const running = launches.get(backend);
  if (running) return running;
  if (backend.config && backend.services) return Promise.resolve();
  const launch = (async () => {
    const initialConfig = await steps.readConfig();
    const seed = await steps.restorePlugins();
    await steps.startServices(seed ? { ...initialConfig, ...seed } : initialConfig);
    steps.prefetchPluginBundles();
  })();
  launches.set(backend, launch);
  const settled = () => {
    if (launches.get(backend) === launch) launches.delete(backend);
  };
  // The caller that awaits the launch reports a failure; this only lets the next one start over.
  launch.then(settled, settled);
  return launch;
}

/**
 * Waits for a launch in flight, and starts none: for a request that wants
 * what the launch makes but must not start the services itself. Only `init`
 * (and the process start) launches, so services torn down by a config import
 * or a reset are not brought up twice. Settles either way; a failed launch
 * is for `init` to report.
 */
export function joinDesktopBackendLaunch(backend: DesktopBackend): Promise<void> {
  const running = launches.get(backend);
  return running ? running.then(() => {}, () => {}) : Promise.resolve();
}

export async function initializeDesktopBackend(
  backend: DesktopBackend,
  rpc: DesktopRpc,
  payload: DesktopBackendRequestPayload<"init">,
): Promise<ElectrobunBackendInit> {
  const windowTarget = normalizeInitWindowTarget(backend.rpcs.getRpcWindowKey(rpc), payload);
  backend.rpcs.markWindowRpcReady(rpc);
  backend.stateBroadcaster.forgetWindowState(rpc);

  await startDesktopBackend(backend);
  const config = backend.requireConfig();
  const services = backend.requireServices();
  if (!backend.workspace) {
    backend.workspace = createDesktopWorkspace(config, backend.getSessionSnapshot());
    backend.detachedWindows.reconcile();
  }
  const init = buildInitializationPayload(backend, config, services, windowTarget);
  // The main window has what it needs to draw: this process is up.
  if (windowTarget.kind === "main") markStartupComplete();
  return init;
}
