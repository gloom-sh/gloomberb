import Electrobun, { ApplicationMenu, BrowserView, BrowserWindow, Utils } from "electrobun/bun";
import {
  APP_SESSION_ID,
  APP_SESSION_SCHEMA_VERSION,
  reconcileAppSessionSnapshot,
} from "../../../core/state/session-persistence";
import type { AppServices } from "../../../core/app-services";
import { saveConfig, setConfigStoreHost } from "../../../data/config/store";
import * as nodeConfigStoreHost from "../../../data/config/store/node";
import type { AppConfig } from "../../../types/config";
import type { AppSessionSnapshot } from "../../../core/state/session-persistence";
import { syncConfigActiveLayoutState, type PaneRuntimeState } from "../../../core/state/app/state";
import type { DesktopSharedStateSnapshot, DesktopThemePreviewState } from "../../../types/desktop-window";
import type { UpdateProgress } from "../../../updater";
import {
  ELECTROBUN_CONTEXT_MENU_ACTION,
  type DesktopBackendRequest,
  type DesktopBackendRequestPayload,
  type DesktopRestartMessage,
  type ElectrobunDesktopRpcSchema,
} from "../shared/protocol";
import { decodeRpcValue, encodeRpcValue } from "../view/rpc-codec";
import { contextMenuSelectionMessage } from "./context-menu/click";
import type { DesktopWorkspace } from "./desktop/workspace";
import { buildDesktopApplicationMenu } from "./application-menu";
import { applicationMenuCommand } from "./application-menu/click";
import { registerElectrobunCoreCapabilities } from "./core-capabilities";
import { setNativeIbkrGatewayModuleLoader } from "../../../plugins/ibkr-gateway/gateway/service";
import {
  runElectrobunDesktopUpdate,
} from "./desktop/update";
import { DesktopCapabilityBridge } from "./desktop/capability-bridge";
import {
  MAIN_WINDOW_MIN_SIZE,
  defaultMainWindowFrame,
  normalizeWindowFrameWithMinimum,
} from "./window/frame";
import { MAIN_WINDOW_RPC_KEY } from "./window/focus";
import { handleHttpFetch } from "./desktop/http-fetch";
import { collectExternalPluginBundles } from "./external-plugins";
import { handleDesktopPluginStateRequest } from "./desktop/plugin-state";
import { scheduleDesktopRelaunch } from "./desktop/relaunch";
import {
  applyWindowMoveEvent,
  applyWindowResizeEvent,
  updateWindowFrameCache,
  type WindowMoveEvent,
  type WindowResizeEvent,
} from "./desktop/window-events";
import { createDesktopRpcRegistry } from "./desktop/rpc-registry";
import { DesktopStateBroadcaster } from "./desktop/state-broadcaster";
import { DesktopDetachedWindowManager } from "./desktop/detached-windows";
import { handleDesktopHostRequest } from "./desktop/host-requests";
import { handleDesktopWorkspaceRequest } from "./desktop/workspace/requests";
import { handleDesktopBackendRequest } from "./desktop/backend-requests";
import { resolveDesktopLiveStream } from "./desktop/media";
import { initializeDesktopBackend } from "./desktop/initialization";
import { applyWindowsCustomChrome } from "./desktop/windows-custom-chrome";
import { applyWindowsWindowIcon } from "./desktop/windows-icons";
import {
  desktopTitleBarStyle,
  desktopWindowRenderer,
  desktopWindowStyleMask,
} from "./desktop/window-style";
import { applyDesktopWindowControl, type DesktopWindowControlAction } from "./desktop/window-controls";
import { startRemoteControlServer, type RemoteControlServer } from "../../../remote/server";
import type { RemoteControlRequest, RemoteControlResponse } from "../../../remote/types";

type DesktopRpc = ReturnType<typeof BrowserView.defineRPC<ElectrobunDesktopRpcSchema>>;

console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);
console.warn = (...args) => console.error(...args);

setConfigStoreHost(nodeConfigStoreHost);
setNativeIbkrGatewayModuleLoader(() => import("../../../plugins/ibkr-gateway/gateway/service/native"));

let currentConfig: AppConfig | null = null;
let services: AppServices | null = null;
let mainWindow: BrowserWindow | null = null;
let desktopWorkspace: DesktopWorkspace | null = null;
let desktopRestartInProgress = false;
let desktopRemoteControlServer: RemoteControlServer | null = null;

const windowRpcRegistry = createDesktopRpcRegistry<DesktopRpc>();
const contextMenuRequestRpcs = new Map<string, DesktopRpc>();

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function requireServices(): AppServices {
  if (!services) throw new Error("Backend services have not been initialized.");
  return services;
}

function requireConfig(): AppConfig {
  if (!currentConfig) throw new Error("Backend config has not been initialized.");
  return currentConfig;
}

function registerCoreCapabilities(): void {
  registerElectrobunCoreCapabilities({
    getConfig: requireConfig,
    getServices: requireServices,
  });
}

function requireDesktopWorkspace(): DesktopWorkspace {
  if (!desktopWorkspace) throw new Error("Desktop workspace has not been initialized.");
  return desktopWorkspace;
}

const pendingDesktopDeepLinks: string[] = [];

function isGloomberbDeepLink(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).protocol === "gloomberb:";
  } catch {
    return false;
  }
}

function readOpenUrlEvent(event: unknown): string | null {
  const data = event && typeof event === "object" ? (event as { data?: unknown }).data : null;
  if (!data || typeof data !== "object") return null;
  const url = (data as { url?: unknown }).url;
  return typeof url === "string" && url ? url : null;
}

function sendDesktopDeepLink(rawUrl: string): void {
  if (!isGloomberbDeepLink(rawUrl)) return;
  const rpc = getWindowRpc(MAIN_WINDOW_RPC_KEY);
  if (!rpc || !isWindowRpcReady(MAIN_WINDOW_RPC_KEY)) {
    pendingDesktopDeepLinks.push(rawUrl);
    if (pendingDesktopDeepLinks.length > 20) pendingDesktopDeepLinks.shift();
    return;
  }
  detachedWindowManager.focusWindowForRpcKey(MAIN_WINDOW_RPC_KEY);
  rpc.send["desktop.deepLink"]({ url: rawUrl });
}

function flushPendingDesktopDeepLinks(): void {
  if (pendingDesktopDeepLinks.length === 0) return;
  const urls = pendingDesktopDeepLinks.splice(0);
  for (const url of urls) sendDesktopDeepLink(url);
}

function remoteFailure(code: string, message: string): RemoteControlResponse {
  return { ok: false, error: { code, message } };
}

const {
  forEachReadyWindowRpc,
  getRpcWindowKey,
  getWindowRpc,
  isWindowRpcReady,
  markWindowRpcReady,
  registerWindowRpc,
  unregisterWindowRpc,
} = windowRpcRegistry;

const capabilityBridge = new DesktopCapabilityBridge<DesktopRpc>({
  getRegistry: () => requireServices().pluginRegistry.capabilities,
  getWindowKey: getRpcWindowKey,
});
const desktopStateBroadcaster = new DesktopStateBroadcaster<DesktopRpc>({
  forEachReadyWindowRpc,
});
const detachedWindowManager = new DesktopDetachedWindowManager<DesktopRpc>({
  createRpc: createWindowRpc,
  getConfig: requireConfig,
  getCurrentConfig: () => currentConfig,
  getDesktopWorkspace: requireDesktopWorkspace,
  getDesktopWorkspaceOrNull: () => desktopWorkspace,
  getMainWindow: () => mainWindow,
  commitDesktopSnapshot,
  disposeWindowScopedResources,
  unregisterWindowRpc,
  stateBroadcaster: desktopStateBroadcaster,
});

async function forwardRemoteControlRequest(request: RemoteControlRequest): Promise<RemoteControlResponse> {
  const rpc = getWindowRpc(MAIN_WINDOW_RPC_KEY);
  if (!rpc || !isWindowRpcReady(MAIN_WINDOW_RPC_KEY)) {
    return remoteFailure("remote_unavailable", "The main desktop window is not ready for remote control requests.");
  }
  try {
    const response = await rpc.request["remote.request"]({
      request: encodeRpcValue(request) as RemoteControlRequest,
    });
    return decodeRpcValue<RemoteControlResponse>(response);
  } catch (error) {
    return remoteFailure(
      "remote_forward_error",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function ensureDesktopRemoteControlServer(): Promise<void> {
  if (desktopRemoteControlServer) return;
  const config = requireConfig();
  desktopRemoteControlServer = await startRemoteControlServer({
    dataDir: config.dataDir,
    appKind: "desktop",
    handle: forwardRemoteControlRequest,
  });
  console.error("[remote] desktop control endpoint started", {
    port: desktopRemoteControlServer.endpoint.port,
  });
}

function stopDesktopRemoteControlServer(): void {
  const server = desktopRemoteControlServer;
  desktopRemoteControlServer = null;
  if (!server) return;
  void server.close().catch((error) => {
    console.error("[remote] desktop control endpoint cleanup failed", summarizeError(error));
  });
}

function openMainWindowDevTools(): void {
  mainWindow?.webview.openDevTools();
}

function syncActiveLayout(
  config: AppConfig,
  paneState: Record<string, PaneRuntimeState> = config.layouts[config.activeLayoutIndex]?.paneState ?? {},
  focusedPaneId: string | null = config.layouts[config.activeLayoutIndex]?.focusedPaneId ?? null,
  activePanel: "left" | "right" = config.layouts[config.activeLayoutIndex]?.activePanel ?? "left",
): AppConfig {
  return syncConfigActiveLayoutState(config, paneState, focusedPaneId, activePanel);
}

function setCurrentConfig(nextConfig: AppConfig): void {
  currentConfig = syncActiveLayout(nextConfig);
  syncConfigAccessors();
}

function sendUpdateProgress(rpc: DesktopRpc, progress: UpdateProgress): void {
  try {
    rpc.send["update.progress"]({
      progress: encodeRpcValue(progress) as UpdateProgress,
    });
  } catch (error) {
    console.warn("update progress send failed", summarizeError(error));
  }
}

async function runDesktopUpdate(rpc: DesktopRpc, currentVersion: string): Promise<void> {
  await runElectrobunDesktopUpdate(currentVersion, (progress) => sendUpdateProgress(rpc, progress));
}


function syncConfigAccessors() {
  if (!services || !currentConfig) return;
  services.pluginRegistry.getConfigFn = () => currentConfig!;
  services.pluginRegistry.getLayoutFn = () => currentConfig!.layout;
  services.pluginRegistry.updateBrokerInstanceFn = async (instanceId, values, options = {}) => {
    const config = requireConfig();
    let found = false;
    const brokerInstances = config.brokerInstances.map((instance) => {
      if (instance.id !== instanceId) return instance;
      found = true;
      const nextValues = options.replaceConfig ? values : { ...instance.config, ...values };
      return {
        ...instance,
        label: options.label ?? instance.label,
        enabled: options.enabled ?? instance.enabled,
        connectionMode: typeof nextValues.connectionMode === "string" ? nextValues.connectionMode : instance.connectionMode,
        config: nextValues,
      };
    });
    if (!found) return;

    const nextConfig = {
      ...config,
      brokerInstances,
    };
    if (desktopWorkspace) {
      await commitDesktopSnapshot(desktopWorkspace.replaceConfig(nextConfig, { layoutChanged: false }));
      return;
    }
    setCurrentConfig(nextConfig);
    await saveConfig(requireConfig());
  };
  const configurableProvider = services.providerRouter as {
    setConfigAccessor?: (accessor: () => AppConfig) => void;
  };
  configurableProvider.setConfigAccessor?.(() => currentConfig!);
}

function getSessionSnapshot(): AppSessionSnapshot | null {
  if (!currentConfig || !services) return null;
  const persisted = services.persistence.sessions.get<AppSessionSnapshot>(APP_SESSION_ID, APP_SESSION_SCHEMA_VERSION)?.value ?? null;
  return reconcileAppSessionSnapshot(currentConfig, persisted);
}

function getDesktopSnapshot(): DesktopSharedStateSnapshot | null {
  return desktopWorkspace?.getSnapshot() ?? null;
}

function sendDesktopState(snapshot: DesktopSharedStateSnapshot | null = getDesktopSnapshot()): void {
  desktopStateBroadcaster.sendDesktopState(snapshot);
}

function sendThemePreview(preview: DesktopThemePreviewState): void {
  desktopStateBroadcaster.sendThemePreview(preview);
}

function clearDockPreview(paneId?: string): void {
  desktopStateBroadcaster.clearDockPreview(paneId);
}

function disposeWindowScopedResources(windowKey: string): void {
  capabilityBridge.disposeWindow(windowKey);
}

function teardownServices(): void {
  stopDesktopRemoteControlServer();
  capabilityBridge.disposeAll();
  services?.destroy();
  services = null;
}

function restartDesktopApp(message: DesktopRestartMessage = {}): void {
  if (desktopRestartInProgress) return;
  desktopRestartInProgress = true;
  console.error("[desktop-recovery] restart requested", {
    reason: message.reason,
    source: message.source,
    pid: process.pid,
    execPath: process.execPath,
    argv: process.argv,
  });
  try {
    scheduleDesktopRelaunch();
  } catch (error) {
    desktopRestartInProgress = false;
    console.error("[desktop-recovery] failed to schedule restart", summarizeError(error));
    throw error;
  }
  closeAllDetachedWindows();
  teardownServices();
  Utils.quit();
}

async function commitDesktopSnapshot(
  snapshot: DesktopSharedStateSnapshot,
  options: { persistConfig?: boolean; reconcileWindows?: boolean } = {},
): Promise<DesktopSharedStateSnapshot> {
  const nextConfig = syncActiveLayout(snapshot.config, snapshot.paneState, snapshot.focusedPaneId, snapshot.activePanel);
  setCurrentConfig(nextConfig);
  desktopWorkspace = requireDesktopWorkspace();
  desktopWorkspace.replaceConfig(nextConfig, { layoutChanged: snapshot.layoutChanged });
  if (options.persistConfig !== false) {
    await saveConfig(nextConfig);
  }
  if (options.reconcileWindows !== false) {
    reconcileDetachedWindows();
  }
  sendDesktopState(requireDesktopWorkspace().getSnapshot());
  return requireDesktopWorkspace().getSnapshot();
}

function reconcileDetachedWindows(): void {
  detachedWindowManager.reconcile();
}

function closeAllDetachedWindows(): void {
  detachedWindowManager.closeAll();
}

function quitDesktopApp(): void {
  closeAllDetachedWindows();
  teardownServices();
  const window = mainWindow;
  mainWindow = null;
  window?.close();
  Utils.quit();
}

function controlWindowForRpcKey(windowKey: string | undefined, action: DesktopWindowControlAction): boolean {
  const targetWindow = windowKey === MAIN_WINDOW_RPC_KEY
    ? mainWindow
    : detachedWindowManager.getWindowForRpcKey(windowKey);
  if (!targetWindow) return false;
  if (action !== "close") {
    detachedWindowManager.suppressAutoDockForRpcKey(windowKey);
  }
  applyDesktopWindowControl(targetWindow, action);
  return true;
}

async function initialize(
  rpc: DesktopRpc,
  payload: DesktopBackendRequestPayload<"init">,
) {
  const init = await initializeDesktopBackend({
    getCurrentConfig: () => currentConfig,
    getCurrentServices: () => services,
    getDesktopSnapshot,
    getDesktopWorkspace: () => desktopWorkspace,
    getRpcWindowKey,
    getSessionSnapshot,
    getThemePreview: () => desktopStateBroadcaster.currentThemePreview,
    markWindowRpcReady,
    payload,
    reconcileDetachedWindows,
    registerCoreCapabilities,
    rpc,
    setCurrentConfig,
    setDesktopWorkspace: (workspace) => {
      desktopWorkspace = workspace;
    },
    setServices: (nextServices) => {
      services = nextServices;
    },
    syncConfigAccessors,
  });
  if (init.windowKind === "main") {
    flushPendingDesktopDeepLinks();
    void ensureDesktopRemoteControlServer().catch((error) => {
      console.error("[remote] desktop control endpoint failed", summarizeError(error));
    });
  }
  return init;
}

async function handleBackendRequest(
  rpc: DesktopRpc,
  request: DesktopBackendRequest,
) {
  switch (request.method) {
    case "init":
      return initialize(rpc, request.payload);
    case "http.fetch":
      return handleHttpFetch(request.payload);
    case "media.resolveLiveStream":
      return resolveDesktopLiveStream(request.payload);
    case "remote.forward":
      return forwardRemoteControlRequest(request.payload.request);
    case "capability.invoke":
    case "capability.cancel":
    case "capability.subscribe":
    case "capability.unsubscribe":
      return capabilityBridge.handle(rpc, request);
    case "desktop.syncMainState":
    case "desktop.setThemePreview":
    case "desktop.replaceDetachedPaneState":
    case "desktop.popOutPane":
    case "desktop.dockDetachedPane":
    case "desktop.closeDetachedPane":
    case "desktop.focusDetachedPane":
      return handleDesktopWorkspaceRequest({
        workspace: requireDesktopWorkspace(),
        request,
        setCurrentConfig,
        sendThemePreview,
        clearDockPreview,
        sendDesktopState,
        reconcileDetachedWindows,
        commitDesktopSnapshot,
        resolveDetachedFrame: (paneId) => detachedWindowManager.resolveFrame(paneId),
        focusDetachedPane: (paneId) => detachedWindowManager.focusDetachedPane(paneId),
      });
    case "pluginState.set":
    case "pluginState.setMany":
    case "pluginState.delete":
      return handleDesktopPluginStateRequest(requireServices().persistence.pluginState, request);
    case "plugins.listExternal":
      return collectExternalPluginBundles();
    case "host.restart":
    case "host.exit":
    case "host.windowControl":
    case "host.openExternal":
    case "host.copyText":
    case "host.focusWindow":
    case "host.copyPngImage":
    case "host.readText":
    case "host.saveTextFile":
    case "host.notify":
    case "host.showContextMenu":
      return handleDesktopHostRequest({
        clearMainWindow: () => {
          mainWindow = null;
        },
        closeAllDetachedWindows,
        focusWindowForRpcKey: (windowKey) => detachedWindowManager.focusWindowForRpcKey(windowKey),
        getMainWindow: () => mainWindow,
        getRpcWindowKey,
        request,
        restartDesktopApp,
        rpc,
        teardownServices,
        controlWindowForRpcKey,
        trackContextMenuRequest: (requestId, targetRpc) => {
          contextMenuRequestRpcs.clear();
          contextMenuRequestRpcs.set(requestId, targetRpc);
        },
      });
    case "update.check":
    case "update.start":
    case "ticker.loadAll":
    case "ticker.load":
    case "ticker.save":
    case "ticker.delete":
    case "config.save":
    case "config.resetAllData":
    case "config.export":
    case "config.import":
    case "session.set":
    case "session.delete":
      return handleDesktopBackendRequest({
        clearCurrentConfig: () => {
          currentConfig = null;
        },
        closeAllDetachedWindows,
        commitDesktopSnapshot,
        getConfig: requireConfig,
        getDesktopWorkspace: () => desktopWorkspace,
        getServices: requireServices,
        getSessionSnapshot,
        request,
        reconcileDetachedWindows,
        registerCoreCapabilities,
        sendDesktopState,
        setCurrentConfig,
        setDesktopWorkspace: (workspace) => {
          desktopWorkspace = workspace;
        },
        setServices: (nextServices) => {
          services = nextServices;
        },
        startUpdate: (currentVersion) => {
          void runDesktopUpdate(rpc, currentVersion);
        },
        syncConfigAccessors,
        teardownServices,
      });
    default: {
      const exhaustive: never = request;
      throw new Error(`Unknown backend request: ${String(exhaustive)}`);
    }
  }
}

function installApplicationMenu() {
  ApplicationMenu.setApplicationMenu(buildDesktopApplicationMenu());
}

function createWindowRpc(key: string): DesktopRpc {
  let rpc!: DesktopRpc;
  rpc = BrowserView.defineRPC<ElectrobunDesktopRpcSchema>({
    handlers: {
      requests: {
        "backend.request": async ({ method, payload }) => {
          const request = {
            method,
            payload: decodeRpcValue(payload ?? null),
          } as DesktopBackendRequest;
          return encodeRpcValue(await handleBackendRequest(rpc, request));
        },
      },
      messages: {
        "host.restart": (message) => {
          restartDesktopApp(message);
        },
      },
    },
  });
  registerWindowRpc(key, rpc);
  return rpc;
}

Electrobun.events.on("context-menu-clicked", (event: unknown) => {
  const message = contextMenuSelectionMessage(event, ELECTROBUN_CONTEXT_MENU_ACTION);
  if (!message) return;
  const targetRpc = contextMenuRequestRpcs.get(message.requestId);
  contextMenuRequestRpcs.delete(message.requestId);
  if (targetRpc) {
    targetRpc.send["context-menu.select"](message);
    return;
  }
  forEachReadyWindowRpc((windowRpc) => {
    windowRpc.send["context-menu.select"](message);
  });
});

Electrobun.events.on("open-url", (event: unknown) => {
  const url = readOpenUrlEvent(event);
  if (!url) return;
  sendDesktopDeepLink(url);
});

ApplicationMenu.on("application-menu-clicked", (event: unknown) => {
  const command = applicationMenuCommand(event);
  if (!command) return;
  if (command.type === "open-devtools") {
    openMainWindowDevTools();
    return;
  }
  if (command.type === "quit") {
    quitDesktopApp();
    return;
  }
  if (!isWindowRpcReady(MAIN_WINDOW_RPC_KEY)) return;
  getWindowRpc(MAIN_WINDOW_RPC_KEY)?.send["application-menu.select"]({ command });
});

installApplicationMenu();

const mainRpc = createWindowRpc(MAIN_WINDOW_RPC_KEY);
const initialMainWindowFrame = normalizeWindowFrameWithMinimum(
  defaultMainWindowFrame(),
  defaultMainWindowFrame(),
  MAIN_WINDOW_MIN_SIZE,
);

mainWindow = new BrowserWindow({
  title: "Gloomberb",
  frame: initialMainWindowFrame,
  url: "views://mainview/index.html",
  renderer: desktopWindowRenderer(),
  rpc: mainRpc,
  styleMask: desktopWindowStyleMask(),
  titleBarStyle: desktopTitleBarStyle(),
  navigationRules: JSON.stringify(["views://*"]),
  sandbox: false,
});
applyWindowsWindowIcon("Gloomberb");
applyWindowsCustomChrome("Gloomberb");
updateWindowFrameCache(mainWindow, initialMainWindowFrame, MAIN_WINDOW_MIN_SIZE);
detachedWindowManager.focusWindowForRpcKey(MAIN_WINDOW_RPC_KEY);
(mainWindow as any).on?.("move", (event: WindowMoveEvent) => {
  applyWindowMoveEvent(mainWindow, event);
});
(mainWindow as any).on?.("resize", (event: WindowResizeEvent) => {
  applyWindowResizeEvent(mainWindow, event, MAIN_WINDOW_MIN_SIZE);
});
