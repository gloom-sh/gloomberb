import { ApplicationMenu, BrowserView, Utils, type BrowserWindow } from "electrobun/bun";
import { createAppServices, type AppServices } from "../../../../core/app-services";
import { syncConfigActiveLayoutState, type PaneRuntimeState } from "../../../../core/state/app/state";
import {
  APP_SESSION_ID,
  APP_SESSION_SCHEMA_VERSION,
  reconcileAppSessionSnapshot,
  type AppSessionSnapshot,
} from "../../../../core/state/session-persistence";
import { saveConfig } from "../../../../data/config/store";
import { pluginAutoUpdateEnabled } from "../../../../plugins/auto-update";
import { startNodePluginAutoUpdates } from "../../../../plugins/auto-update-node";
import { loadDesktopBackendPlugins } from "../../../../plugins/catalog-backend";
import { startRemoteControlServer, type RemoteControlServer } from "../../../../remote/server";
import type { RemoteControlRequest, RemoteControlResponse } from "../../../../remote/types";
import { installCrashReporter } from "../../../../telemetry/crash-reports";
import { createNodeCrashReporterHost } from "../../../../telemetry/crash-reports-node";
import type { AppConfig } from "../../../../types/config";
import type { DesktopSharedStateSnapshot } from "../../../../types/desktop-window";
import type {
  ContextMenuSelectMessage,
  DesktopBackendRequest,
  DesktopBackendRequestPayload,
  DesktopRestartMessage,
  ElectrobunBackendInit,
  ElectrobunDesktopRpcSchema,
} from "../../shared/protocol";
import { decodeRpcValue, encodeRpcResponse, encodeRpcValue } from "../../shared/rpc-codec";
import { buildDesktopApplicationMenu, type ElectrobunApplicationMenuCommand } from "../application-menu";
import { registerElectrobunCoreCapabilities } from "../core-capabilities";
import {
  activateExternalPlugin,
  bundleExternalPluginDirectory,
  collectExternalPluginBundles,
  deactivateExternalPlugin,
  desktopPluginManager,
} from "../external-plugins";
import { MAIN_WINDOW_RPC_KEY } from "../window/focus";
import { handleDesktopBackendRequest } from "./backend-requests";
import { DesktopCapabilityBridge } from "./capability-bridge";
import { DesktopDetachedWindowManager } from "./detached-windows";
import { handleDesktopHostRequest } from "./host-requests";
import { handleHttpFetch } from "./http-fetch";
import { DesktopHttpStreamBridge } from "./http-stream";
import { initializeDesktopBackend } from "./initialization";
import { applyMacosDockIcon } from "./macos-dock-icon";
import { handleDesktopPluginStateRequest } from "./plugin-state";
import { scheduleDesktopRelaunch } from "./relaunch";
import { createDesktopRpcRegistry } from "./rpc-registry";
import { DesktopStateBroadcaster } from "./state-broadcaster";
import { createDesktopWorkspace, type DesktopWorkspace } from "./workspace";
import { handleDesktopWorkspaceRequest } from "./workspace/requests";

export type DesktopRpc = ReturnType<typeof BrowserView.defineRPC<ElectrobunDesktopRpcSchema>>;

/** How long a quit waits for the view to flush and exit on its own. */
const QUIT_FALLBACK_MS = 2_500;
const MAX_PENDING_DEEP_LINKS = 20;

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function remoteFailure(code: string, message: string): RemoteControlResponse {
  return { ok: false, error: { code, message } };
}

function isGloomberbDeepLink(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).protocol === "gloomberb:";
  } catch {
    return false;
  }
}

function syncActiveLayout(
  config: AppConfig,
  paneState: Record<string, PaneRuntimeState> = config.layouts[config.activeLayoutIndex]?.paneState ?? {},
  focusedPaneId: string | null = config.layouts[config.activeLayoutIndex]?.focusedPaneId ?? null,
): AppConfig {
  return syncConfigActiveLayoutState(config, paneState, focusedPaneId);
}

/**
 * Everything the desktop Bun process holds for its windows: the config and
 * services they share, the workspace that owns popped-out panes, the native
 * windows and one RPC channel per window. Request handlers read and change it
 * through this object.
 */
export class DesktopBackend {
  config: AppConfig | null = null;
  services: AppServices | null = null;
  workspace: DesktopWorkspace | null = null;
  mainWindow: BrowserWindow | null = null;

  readonly rpcs = createDesktopRpcRegistry<DesktopRpc>();
  readonly stateBroadcaster = new DesktopStateBroadcaster<DesktopRpc>({
    forEachReadyWindowRpc: this.rpcs.forEachReadyWindowRpc,
  });
  readonly capabilityBridge = new DesktopCapabilityBridge<DesktopRpc>({
    getRegistry: () => this.requireServices().pluginRegistry.capabilities,
    getWindowKey: this.rpcs.getRpcWindowKey,
  });
  readonly httpStreamBridge = new DesktopHttpStreamBridge<DesktopRpc>({
    getWindowKey: this.rpcs.getRpcWindowKey,
  });
  readonly detachedWindows = new DesktopDetachedWindowManager(this);

  private crashReporterInstalled = false;
  private restartInProgress = false;
  private pluginAutoUpdatesStarted = false;
  private remoteControlServer: RemoteControlServer | null = null;
  private readonly pendingDeepLinks: string[] = [];
  private readonly contextMenuRequestRpcs = new Map<string, DesktopRpc>();

  requireConfig(): AppConfig {
    if (!this.config) throw new Error("Backend config has not been initialized.");
    return this.config;
  }

  requireServices(): AppServices {
    if (!this.services) throw new Error("Backend services have not been initialized.");
    return this.services;
  }

  requireWorkspace(): DesktopWorkspace {
    if (!this.workspace) throw new Error("Desktop workspace has not been initialized.");
    return this.workspace;
  }

  setConfig(nextConfig: AppConfig): void {
    const previousKeybindings = JSON.stringify(this.config?.keybindings ?? null);
    const config = syncActiveLayout(nextConfig);
    this.config = config;
    this.syncConfigAccessors();
    if (!this.crashReporterInstalled) {
      this.crashReporterInstalled = true;
      installCrashReporter(createNodeCrashReporterHost({ surface: "desktop", getConfig: () => this.config }));
    }
    // The native menu shows the same accelerators the keys use, so a rebind
    // rebuilds it.
    if (JSON.stringify(config.keybindings ?? null) !== previousKeybindings) this.installApplicationMenu();
    applyMacosDockIcon(config.theme);
  }

  installApplicationMenu(): void {
    ApplicationMenu.setApplicationMenu(buildDesktopApplicationMenu(process.platform, this.config?.keybindings));
  }

  getSessionSnapshot(): AppSessionSnapshot | null {
    if (!this.config || !this.services) return null;
    const persisted = this.services.persistence.sessions
      .get<AppSessionSnapshot>(APP_SESSION_ID, APP_SESSION_SCHEMA_VERSION)?.value ?? null;
    return reconcileAppSessionSnapshot(this.config, persisted);
  }

  /**
   * Opens services for `nextConfig` and waits for its plugins to register
   * before the capabilities, workspace and popped-out windows are built on
   * them. Launch and an imported config both start this way.
   */
  async startServices(nextConfig: AppConfig): Promise<{ config: AppConfig; services: AppServices }> {
    this.setConfig(nextConfig);
    const config = this.requireConfig();
    const services = createAppServices({
      config,
      ...await loadDesktopBackendPlugins(),
    });
    this.services = services;
    await services.ready;
    this.syncConfigAccessors();
    registerElectrobunCoreCapabilities({
      getConfig: () => this.requireConfig(),
      getServices: () => this.requireServices(),
    });
    this.workspace = createDesktopWorkspace(config, this.getSessionSnapshot());
    this.detachedWindows.reconcile();
    return { config, services };
  }

  teardownServices(): void {
    this.stopRemoteControlServer();
    this.capabilityBridge.disposeAll();
    this.httpStreamBridge.disposeAll();
    this.services?.destroy();
    this.services = null;
  }

  async commitDesktopSnapshot(
    snapshot: DesktopSharedStateSnapshot,
    options: { persistConfig?: boolean; reconcileWindows?: boolean } = {},
  ): Promise<DesktopSharedStateSnapshot> {
    const nextConfig = syncActiveLayout(snapshot.config, snapshot.paneState, snapshot.focusedPaneId);
    this.setConfig(nextConfig);
    this.requireWorkspace().replaceConfig(nextConfig, { layoutChanged: snapshot.layoutChanged });
    if (options.persistConfig !== false) {
      await saveConfig(nextConfig);
    }
    if (options.reconcileWindows !== false) {
      this.detachedWindows.reconcile();
    }
    this.stateBroadcaster.sendDesktopState(this.requireWorkspace().getSnapshot());
    return this.requireWorkspace().getSnapshot();
  }

  /** Stops what a closed window was streaming or subscribed to. */
  disposeWindowResources(windowKey: string): void {
    this.capabilityBridge.disposeWindow(windowKey);
    this.httpStreamBridge.disposeWindow(windowKey);
  }

  /** The main window's channel once its view has initialized. */
  private readyMainWindowRpc(): DesktopRpc | null {
    const rpc = this.rpcs.getWindowRpc(MAIN_WINDOW_RPC_KEY);
    return rpc && this.rpcs.isWindowRpcReady(MAIN_WINDOW_RPC_KEY) ? rpc : null;
  }

  createWindowRpc(key: string): DesktopRpc {
    let rpc!: DesktopRpc;
    rpc = BrowserView.defineRPC<ElectrobunDesktopRpcSchema>({
      handlers: {
        requests: {
          "backend.request": async ({ method, payload }) => {
            const request = {
              method,
              payload: decodeRpcValue(payload ?? null),
            } as DesktopBackendRequest;
            return encodeRpcResponse(() => this.handleRequest(rpc, request));
          },
        },
        messages: {
          "host.restart": (message) => {
            this.restart(message);
          },
        },
      },
    });
    this.rpcs.registerWindowRpc(key, rpc);
    return rpc;
  }

  openDeepLink(rawUrl: string): void {
    if (!isGloomberbDeepLink(rawUrl)) return;
    const rpc = this.readyMainWindowRpc();
    if (!rpc) {
      this.pendingDeepLinks.push(rawUrl);
      if (this.pendingDeepLinks.length > MAX_PENDING_DEEP_LINKS) this.pendingDeepLinks.shift();
      return;
    }
    this.detachedWindows.focusWindowForRpcKey(MAIN_WINDOW_RPC_KEY);
    rpc.send["desktop.deepLink"]({ url: rawUrl });
  }

  trackContextMenuRequest(requestId: string, rpc: DesktopRpc): void {
    this.contextMenuRequestRpcs.clear();
    this.contextMenuRequestRpcs.set(requestId, rpc);
  }

  /** Answers the window that opened the menu, or every window when that is unknown. */
  selectContextMenuItem(message: ContextMenuSelectMessage): void {
    const targetRpc = this.contextMenuRequestRpcs.get(message.requestId);
    this.contextMenuRequestRpcs.delete(message.requestId);
    if (targetRpc) {
      targetRpc.send["context-menu.select"](message);
      return;
    }
    this.rpcs.forEachReadyWindowRpc((windowRpc) => {
      windowRpc.send["context-menu.select"](message);
    });
  }

  runApplicationMenuCommand(command: ElectrobunApplicationMenuCommand): void {
    if (command.type === "open-devtools") {
      this.mainWindow?.webview.openDevTools();
      return;
    }
    const rpc = this.readyMainWindowRpc();
    if (command.type === "quit") {
      if (!rpc) {
        this.quit();
        return;
      }
      // The view sends its usage counts and then asks to exit; quit anyway if
      // it does not.
      rpc.send["application-menu.select"]({ command });
      setTimeout(() => this.quit(), QUIT_FALLBACK_MS);
      return;
    }
    if (!rpc) return;
    // The bar and every form open in the main window; with a detached window
    // key, the keys would go there instead.
    if (command.type === "open-command-bar" || command.type === "open-builtin-workflow" || command.type === "open-plugin-workflow") {
      this.detachedWindows.focusWindowForRpcKey(MAIN_WINDOW_RPC_KEY);
    }
    rpc.send["application-menu.select"]({ command });
  }

  private quit(): void {
    this.detachedWindows.closeAll();
    this.teardownServices();
    const window = this.mainWindow;
    this.mainWindow = null;
    window?.close();
    Utils.quit();
  }

  private restart(message: DesktopRestartMessage = {}): void {
    if (this.restartInProgress) return;
    this.restartInProgress = true;
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
      this.restartInProgress = false;
      console.error("[desktop-recovery] failed to schedule restart", summarizeError(error));
      throw error;
    }
    this.detachedWindows.closeAll();
    this.teardownServices();
    Utils.quit();
  }

  private syncConfigAccessors(): void {
    const services = this.services;
    if (!services || !this.config) return;
    services.pluginRegistry.bindHost({
      getConfig: () => this.config!,
      getLayout: () => this.config!.layout,
      updateBrokerInstance: async (instanceId, values, options = {}) => {
        const config = this.requireConfig();
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
        if (this.workspace) {
          await this.commitDesktopSnapshot(this.workspace.replaceConfig(nextConfig, { layoutChanged: false }));
          return;
        }
        this.setConfig(nextConfig);
        await saveConfig(this.requireConfig());
      },
    });
    const configurableProvider = services.providerRouter as {
      setConfigAccessor?: (accessor: () => AppConfig) => void;
    };
    configurableProvider.setConfigAccessor?.(() => this.config!);
  }

  private async initialize(
    rpc: DesktopRpc,
    payload: DesktopBackendRequestPayload<"init">,
  ): Promise<ElectrobunBackendInit> {
    const init = await initializeDesktopBackend(this, rpc, payload);
    if (init.windowKind === "main") {
      this.flushPendingDeepLinks();
      void this.ensureRemoteControlServer().catch((error) => {
        console.error("[remote] desktop control endpoint failed", summarizeError(error));
      });
      this.ensurePluginAutoUpdates();
    }
    return init;
  }

  private flushPendingDeepLinks(): void {
    if (this.pendingDeepLinks.length === 0) return;
    const urls = this.pendingDeepLinks.splice(0);
    for (const url of urls) this.openDeepLink(url);
  }

  private async forwardRemoteControlRequest(request: RemoteControlRequest): Promise<RemoteControlResponse> {
    const rpc = this.readyMainWindowRpc();
    if (!rpc) {
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

  private async ensureRemoteControlServer(): Promise<void> {
    if (this.remoteControlServer) return;
    const config = this.requireConfig();
    this.remoteControlServer = await startRemoteControlServer({
      dataDir: config.dataDir,
      appKind: "desktop",
      handle: (request) => this.forwardRemoteControlRequest(request),
    });
    console.error("[remote] desktop control endpoint started", {
      port: this.remoteControlServer.endpoint.port,
    });
  }

  private stopRemoteControlServer(): void {
    const server = this.remoteControlServer;
    this.remoteControlServer = null;
    if (!server) return;
    void server.close().catch((error) => {
      console.error("[remote] desktop control endpoint cleanup failed", summarizeError(error));
    });
  }

  /**
   * Official plugins update here, in the process that owns the plugins folder
   * for every window. The main window then brings what moved into its session
   * the way its Plugins pane does after an update.
   */
  private ensurePluginAutoUpdates(): void {
    if (this.pluginAutoUpdatesStarted) return;
    this.pluginAutoUpdatesStarted = true;
    startNodePluginAutoUpdates({
      manager: desktopPluginManager,
      isEnabled: () => pluginAutoUpdateEnabled(this.config),
      onUpdated: (directories) => {
        this.readyMainWindowRpc()?.send["plugins.updated"]({ directories });
      },
    });
  }

  private async handleRequest(rpc: DesktopRpc, request: DesktopBackendRequest) {
    switch (request.method) {
      case "init":
        return this.initialize(rpc, request.payload);
      case "http.fetch":
        return handleHttpFetch(request.payload);
      case "http.stream.open":
      case "http.stream.cancel":
        return this.httpStreamBridge.handle(rpc, request);
      case "capability.invoke":
      case "capability.cancel":
      case "capability.subscribe":
      case "capability.unsubscribe":
        return this.capabilityBridge.handle(rpc, request);
      case "desktop.syncMainState":
      case "desktop.setThemePreview":
      case "desktop.replaceDetachedPaneState":
      case "desktop.popOutPane":
      case "desktop.dockDetachedPane":
      case "desktop.closeDetachedPane":
      case "desktop.focusDetachedPane":
        return handleDesktopWorkspaceRequest(this, request);
      case "pluginState.setMany":
      case "pluginState.delete":
        return handleDesktopPluginStateRequest(this.requireServices().persistence.pluginState, request);
      case "plugins.listExternal":
        return collectExternalPluginBundles();
      case "plugins.install":
        return desktopPluginManager.install(request.payload.ref, request.payload.pin);
      case "plugins.update":
        return desktopPluginManager.update(request.payload.directory, request.payload.pin);
      case "plugins.remove":
        return desktopPluginManager.remove(request.payload.directory);
      case "plugins.remoteHeads":
        return desktopPluginManager.remoteHeads(request.payload.directories);
      case "plugins.bundle":
        return bundleExternalPluginDirectory(request.payload.directory);
      case "plugins.activate":
        return activateExternalPlugin(this.requireServices().pluginRegistry, request.payload.directory);
      case "plugins.deactivate":
        return deactivateExternalPlugin(this.requireServices().pluginRegistry, request.payload.pluginId);
      case "host.exit":
      case "host.windowControl":
      case "host.windowFullscreen":
      case "host.openExternal":
      case "host.copyText":
      case "host.focusWindow":
      case "host.copyPngImage":
      case "host.readText":
      case "host.saveTextFile":
      case "host.notify":
      case "host.showContextMenu":
        return handleDesktopHostRequest(this, rpc, request);
      case "update.check":
      case "update.start":
      case "update.apply":
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
      case "resources.set":
      case "resources.delete":
        return handleDesktopBackendRequest(this, rpc, request);
      default: {
        const exhaustive: never = request;
        throw new Error(`Unknown backend request: ${String(exhaustive)}`);
      }
    }
  }
}
