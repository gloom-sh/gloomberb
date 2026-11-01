import Electrobun, { ApplicationMenu, BrowserView, Screen, Utils, type BrowserWindow } from "electrobun/bun";
import { homedir } from "os";
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
import { createStallClocks } from "../../../../telemetry/stall-clocks";
import { installStallReporter, parseStallEvent, recordStall } from "../../../../telemetry/stall-reports";
import { createNodeStallReporterHost } from "../../../../telemetry/stall-reports-node";
import { installUpdateFailureReporter, reviewLastUpdateAttempt } from "../../../../telemetry/update-failures";
import { createNodeUpdateFailureHost } from "../../../../telemetry/update-failures-node";
import type { AppConfig } from "../../../../types/config";
import { linkDesktopCommands } from "../../../../updater/command-names";
import { debugLog } from "../../../../utils/debug-log";
import { setStallClocks, setStallSink, startMainThreadStallMonitor } from "../../../../utils/main-thread-stall";
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
  deactivateExternalPlugin,
  desktopPluginManager,
  prefetchExternalPluginBundles,
  takeExternalPluginBundles,
} from "../external-plugins";
import { MAIN_WINDOW_RPC_KEY, paneIdFromDetachedRpcKey } from "../window/focus";
import { measureNativeWindowCalls } from "../window/native-timing";
import { createAppWindow } from "../window/create";
import { desktopBootFramePath, desktopBootFramePreload, readDesktopBootFrame } from "../window/boot-frame";
import { MAIN_WINDOW_MIN_SIZE, defaultMainWindowFrame } from "../window/frame";
import { ElectrobunWindowHost } from "../window/electrobun-window-host";
import { quitWindowsEventLoopOnItsThread } from "../window/windows-quit";
import { readRememberedDesktopWindow, rememberedDesktopWindowPath } from "../window/remembered-frame";
import { DesktopWindowController } from "../../../desktop/window-controller";
import { SequentialWindowHost } from "../../../desktop/sequential-window-host";
import { createExtraWindowId, MAIN_WINDOW_ID } from "../../../desktop/screen-setup";
import type { OpenWindowSpec } from "../../../desktop/window-host";
import type { DesktopWindowInfo, OtherWindowTab } from "../../../../types/desktop-window";
import { desktopScreenSetupStore } from "./screen-setup-file";
import { handleDesktopBackendRequest } from "./backend-requests";
import { detectDesktopInstallKind, removeUpdateAsides } from "./update";
import { removeLegacyMacApp } from "./app-name";
import { DesktopCapabilityBridge } from "./capability-bridge";
import { DesktopDetachedWindowManager } from "./detached-windows";
import { handleDesktopHostRequest } from "./host-requests";
import { handleHttpFetch } from "./http-fetch";
import { DesktopHttpStreamBridge } from "./http-stream";
import { initializeDesktopBackend, joinDesktopBackendLaunch } from "./initialization";
import { applyMacosDockIcon } from "./macos-dock-icon";
import { handleDesktopPluginStateRequest } from "./plugin-state";
import { scheduleDesktopRelaunch } from "./relaunch";
import { createDesktopRpcRegistry } from "./rpc-registry";
import { measureRpcTraffic } from "./rpc-timing";
import { DesktopStateBroadcaster } from "./state-broadcaster";
import { createDesktopWorkspace, type DesktopWorkspace } from "./workspace";
import { handleDesktopWorkspaceRequest } from "./workspace/requests";

export type DesktopRpc = ReturnType<typeof BrowserView.defineRPC<ElectrobunDesktopRpcSchema>>;

/** How long a quit waits for the view to flush and exit on its own. */
const QUIT_FALLBACK_MS = 2_500;
/** How long after the main window is up the app looks for its `gloomberb` command to add `gloom` beside it. */
const COMMAND_LINK_DELAY_MS = 10_000;
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
  /**
   * Every window and screen goes through these: the host, which opens
   * native windows one at a time, and the full windows' placement on the
   * screens. `nativeWindows` is the Electrobun host under it, for the calls
   * only this shell makes.
   */
  windowHost: SequentialWindowHost | null = null;
  windowController: DesktopWindowController | null = null;
  private nativeWindows: ElectrobunWindowHost | null = null;

  readonly rpcs = createDesktopRpcRegistry<DesktopRpc>();
  readonly stateBroadcaster = new DesktopStateBroadcaster<DesktopRpc>({
    forEachReadyWindowRpc: this.rpcs.forEachReadyWindowRpc,
    // A full window draws its own tabs; a popped-out pane's window draws the main window's.
    viewKey: (rpc) => {
      const key = this.rpcs.getRpcWindowKey(rpc) ?? MAIN_WINDOW_ID;
      return paneIdFromDetachedRpcKey(key) ? MAIN_WINDOW_ID : key;
    },
    // With one window its view is the shared state: nothing to project or keep.
    project: (viewKey, shared) => {
      const workspace = this.workspace;
      return workspace && workspace.windowIds().length > 1 ? workspace.peekWindowSnapshot(viewKey) ?? shared : shared;
    },
    delivered: (rpc, snapshot) => {
      const workspace = this.workspace;
      const key = this.rpcs.getRpcWindowKey(rpc);
      if (!workspace || !key || typeof snapshot.stateSeq !== "number" || workspace.windowIds().length <= 1) return;
      workspace.noteDelivered(key, snapshot.stateSeq, snapshot);
    },
  });
  readonly capabilityBridge = new DesktopCapabilityBridge<DesktopRpc>({
    getRegistry: () => this.requireServices().pluginRegistry.capabilities,
    getWindowKey: this.rpcs.getRpcWindowKey,
  });
  readonly httpStreamBridge = new DesktopHttpStreamBridge<DesktopRpc>({
    getWindowKey: this.rpcs.getRpcWindowKey,
  });
  readonly detachedWindows = new DesktopDetachedWindowManager(this);
  /** Each pane type's plugin, for hiding popped-out windows with their plugin. */
  paneOwners: ReadonlyMap<string, string> = new Map();

  private crashReporterInstalled = false;
  private restartInProgress = false;
  private pluginAutoUpdatesStarted = false;
  private commandLinksScheduled = false;
  private remoteControlServer: RemoteControlServer | null = null;
  private readonly pendingDeepLinks: string[] = [];
  private readonly contextMenuRequestRpcs = new Map<string, DesktopRpc>();
  /** Extra windows open once the main window has drawn, like popped-out panes. */
  private extraWindowsAllowed = false;
  private lastWindowList = "";
  /** What the main window was last told the other windows' tabs are. */
  private lastOtherWindowTabs = "[]";
  private quitting = false;

  /**
   * Makes the window host, opens the main window where it was left on these
   * screens, and starts watching them. Extra windows open once the main
   * window has its data.
   */
  startWindows(): void {
    if (this.windowHost) return;
    const shell = new ElectrobunWindowHost({
      create: (spec, hooks) => this.createNativeWindow(spec, hooks.onFrameChange),
      readDisplays: () => Screen.getAllDisplays(),
    });
    const host = new SequentialWindowHost(shell, {
      canReopen: (spec) => spec.id !== MAIN_WINDOW_ID,
      onNeverDrew: (id) => console.error("[desktop] a window never drew", { kind: paneIdFromDetachedRpcKey(id) ? "pane" : "app" }),
    });
    this.nativeWindows = shell;
    this.windowHost = host;
    const legacy = readRememberedDesktopWindow(rememberedDesktopWindowPath());
    this.windowController = new DesktopWindowController({
      host,
      store: desktopScreenSetupStore(),
      minSize: MAIN_WINDOW_MIN_SIZE,
      defaultMainFrame: defaultMainWindowFrame(),
      // Windows saved every window as full screen in builds whose frameless
      // window it took for full screen; it has no way into full screen here.
      legacyMainPlacement: legacy ? { ...legacy, fullscreen: legacy.fullscreen && process.platform !== "win32" } : null,
      onWindowClosed: (windowId) => this.handleExtraWindowClosed(windowId),
      onMainWindowClosed: () => this.quit(),
    });
    host.onWindowEvent((event) => {
      this.detachedWindows.handleWindowEvent(event);
      // A page that has not started yet draws as shown; it is told once it hides again.
      if (event.type !== "visibility" || !this.rpcs.isWindowRpcReady(event.id)) return;
      this.rpcs.getWindowRpc(event.id)?.send["desktop.windowVisibility"]({ visible: event.visible });
    });
    // A quit from outside the app (the Dock, logging out) does not come
    // through `quit`: where the windows are is written here. Registered
    // before the main window opens, so it runs before the shell's own
    // handlers wait for the windows to go.
    Electrobun.events.on("before-quit", () => {
      if (!this.quitting) this.windowController?.flush();
    });
    this.windowController.openWindow(MAIN_WINDOW_ID);
    this.windowController.focus(MAIN_WINDOW_ID);
  }

  /** The native window behind a full window or a popped-out pane, with its own RPC channel. */
  private createNativeWindow(spec: OpenWindowSpec, onFrameChange: () => void): BrowserWindow {
    const rpc = this.createWindowRpc(spec.id);
    const main = spec.id === MAIN_WINDOW_ID;
    const window = createAppWindow({
      title: spec.title,
      frame: spec.frame,
      rpc,
      minSize: spec.minSize,
      onFrameChange,
      // A full window's page draws a frame before its script has loaded: the
      // main window the layout it last drew (dom/boot-frame.ts), another the
      // bare shell. A popped-out pane's draws none.
      ...(spec.kind === "app"
        ? { preload: desktopBootFramePreload(main ? readDesktopBootFrame(desktopBootFramePath()) : null) }
        : {}),
    });
    if (main) quitWindowsEventLoopOnItsThread(window);
    return window;
  }

  /** Brings a window forward by its RPC key: a full window's or a popped-out pane's. False when there is none. */
  focusWindow(windowKey: string | undefined): boolean {
    const host = this.windowHost;
    if (!windowKey || !host?.hasWindow(windowKey)) return false;
    if (this.windowController?.isOpen(windowKey)) this.windowController.focus(windowKey);
    else host.focusWindow(windowKey);
    return true;
  }

  /** The Electrobun window for an RPC key, for the calls only this shell makes. */
  nativeWindow(windowKey: string | undefined): BrowserWindow | null {
    return windowKey ? this.nativeWindows?.browserWindow(windowKey) ?? null : null;
  }

  /** The main window has its data: popped-out panes and extra windows open shortly after. */
  openWindowsAfterMainWindow(): void {
    this.detachedWindows.openAfterMainWindow(() => {
      this.extraWindowsAllowed = true;
      this.reconcileWindows();
    });
  }

  /** Opens and closes windows to match the workspace: popped-out panes, and full windows. */
  reconcileWindows(): void {
    this.detachedWindows.reconcile();
    const controller = this.windowController;
    const workspace = this.workspace;
    if (!controller || !workspace) return;
    const wanted = workspace.windowIds();
    if (this.extraWindowsAllowed) {
      for (const windowId of wanted) {
        if (windowId !== MAIN_WINDOW_ID && !controller.isOpen(windowId)) controller.openWindow(windowId);
      }
    }
    for (const windowId of controller.openWindowIds()) {
      if (windowId === MAIN_WINDOW_ID || wanted.includes(windowId)) continue;
      controller.closeWindow(windowId, { forget: true });
      this.releaseWindow(windowId);
    }
    controller.rememberWindows(workspace.extraWindows());
    this.sendWindowList();
  }

  /** Every full window, labelled in the order they opened. */
  windowInfos(): DesktopWindowInfo[] {
    const workspace = this.workspace;
    if (!workspace) return [];
    return workspace.windowIds().map((id, index) => {
      const tabs = workspace.windowTabNames(id);
      return {
        id,
        number: index + 1,
        activeLayoutName: tabs?.active ?? "",
        tabCount: tabs?.count ?? 0,
      };
    });
  }

  /** Tells every full window which windows there are, when that changed. */
  private sendWindowList(): void {
    this.sendOtherWindowTabs();
    const windows = this.windowInfos();
    const key = JSON.stringify(windows);
    if (key === this.lastWindowList) return;
    this.lastWindowList = key;
    for (const { id } of windows) {
      if (!this.rpcs.isWindowRpcReady(id)) continue;
      this.rpcs.getWindowRpc(id)?.send["desktop.windows"]({ windows });
    }
  }

  /** The tabs the other windows hold, for the main window's init; later changes come as messages. */
  otherWindowTabsForInit(): OtherWindowTab[] {
    const tabs = this.workspace?.otherWindowTabs() ?? [];
    this.lastOtherWindowTabs = JSON.stringify(tabs);
    return tabs;
  }

  /** Tells the main window when the tabs the other windows hold changed: its cloud sync pushes every window's tabs. */
  private sendOtherWindowTabs(): void {
    const workspace = this.workspace;
    if (!workspace || !this.rpcs.isWindowRpcReady(MAIN_WINDOW_ID)) return;
    const tabs = workspace.otherWindowTabs();
    // One window: none, as the main window already knows.
    if (tabs.length === 0 && this.lastOtherWindowTabs === "[]") return;
    const key = JSON.stringify(tabs);
    if (key === this.lastOtherWindowTabs) return;
    this.lastOtherWindowTabs = key;
    this.rpcs.getWindowRpc(MAIN_WINDOW_ID)?.send["desktop.otherWindowTabs"]({ tabs: encodeRpcValue(tabs) });
  }

  /** A full window's id for a request, or null for a popped-out pane's window. */
  fullWindowKey(rpc: DesktopRpc): string | null {
    const key = this.rpcs.getRpcWindowKey(rpc);
    if (!key || paneIdFromDetachedRpcKey(key)) return null;
    return key;
  }

  /** Opens a new full window, on `layoutId` or an empty tab. Null when that tab cannot leave its window. */
  async openExtraWindow(holding?: { layoutId?: string; paneId?: string }): Promise<string | null> {
    const workspace = this.requireWorkspace();
    const windowId = createExtraWindowId();
    const snapshot = workspace.openWindow(windowId, holding);
    if (!snapshot) return null;
    this.extraWindowsAllowed = true;
    await this.commitDesktopSnapshot(snapshot);
    this.windowController?.focus(windowId);
    return windowId;
  }

  /**
   * Shows a pane wherever it is: brings its window forward, on its tab, and
   * has that window focus it. False when no window holds it.
   */
  async focusPaneAnywhere(paneId: string): Promise<boolean> {
    const workspace = this.requireWorkspace();
    const config = this.config;
    if (config && config.layout.detached.some((entry) => entry.instanceId === paneId)) {
      return this.detachedWindows.focusDetachedPane(paneId);
    }
    const located = workspace.locatePane(paneId);
    if (!located) return false;
    const before = workspace.getWindowSnapshot(located.windowId);
    const shown = before?.config.layouts[before.config.activeLayoutIndex]?.id;
    if (shown !== located.layoutId) {
      await this.commitDesktopSnapshot(workspace.activateLayout(located.windowId, located.layoutId), { persistConfig: false });
    }
    this.windowController?.focus(located.windowId);
    this.rpcs.getWindowRpc(located.windowId)?.send["desktop.focusPane"]({ paneId });
    return true;
  }

  private handleExtraWindowClosed(windowId: string): void {
    this.releaseWindow(windowId);
    // Closed by the quit itself: it opens again with its tabs at the next launch.
    if (this.quitting) return;
    const workspace = this.workspace;
    if (!workspace || !workspace.windowIds().includes(windowId)) return;
    void this.commitDesktopSnapshot(workspace.closeWindow(windowId));
  }

  /** What a closed full window held: its streams, its channel. */
  private releaseWindow(windowId: string): void {
    this.disposeWindowResources(windowId);
    this.rpcs.unregisterWindowRpc(windowId);
    this.workspace?.forgetWindow(windowId);
  }

  /**
   * Closes every window but the main one, without forgetting the extra
   * ones, which open again at the next launch or session. Where each window
   * is, the main one included, is written first.
   */
  closeAllWindows(): void {
    this.detachedWindows.closeAll();
    const controller = this.windowController;
    if (!controller) return;
    controller.flush();
    for (const windowId of controller.openWindowIds()) {
      if (windowId === MAIN_WINDOW_ID) continue;
      controller.closeWindow(windowId);
      this.releaseWindow(windowId);
    }
  }

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
      // This process runs the desktop update, so it reports how the last one ended and any that fail.
      installUpdateFailureReporter(createNodeUpdateFailureHost({
        installKind: detectDesktopInstallKind(),
        getDataDir: () => this.config?.dataDir ?? null,
      }));
      reviewLastUpdateAttempt();
      void removeUpdateAsides();
      // Desktop has no Debug Log: freezes of this process and of its windows go to the stall log in the data folder.
      installStallReporter(createNodeStallReporterHost({ getDataDir: () => this.config?.dataDir ?? null }));
      setStallSink((event) => recordStall("app", event));
      setStallClocks(createStallClocks());
      measureNativeWindowCalls();
      startMainThreadStallMonitor();
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
    const { paneOwners, ...backendPlugins } = await loadDesktopBackendPlugins();
    this.paneOwners = paneOwners;
    const services = createAppServices({
      config,
      ...backendPlugins,
    });
    this.services = services;
    await services.ready;
    this.syncConfigAccessors();
    registerElectrobunCoreCapabilities({
      getConfig: () => this.requireConfig(),
      getServices: () => this.requireServices(),
    });
    this.workspace = createDesktopWorkspace(config, this.getSessionSnapshot(), this.windowController?.screenSetup.windows);
    this.reconcileWindows();
    return { config, services };
  }

  /** Compiles the view's plugins ahead of its first `plugins.listExternal`. */
  prefetchExternalPluginBundles(): void {
    prefetchExternalPluginBundles();
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
      this.reconcileWindows();
    }
    this.stateBroadcaster.sendDesktopState(this.requireWorkspace().getSnapshot());
    this.sendWindowList();
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
          "runtime.stall": (message) => {
            const event = parseStallEvent(message);
            if (event) recordStall("window", event);
          },
        },
      },
    });
    measureRpcTraffic(rpc);
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
    this.focusWindow(MAIN_WINDOW_RPC_KEY);
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

  /** The full window the person used last, ready for messages; the main window otherwise. */
  private focusedFullWindow(): { key: string; rpc: DesktopRpc } | null {
    const focused = this.windowController?.focusedWindowId ?? MAIN_WINDOW_ID;
    for (const key of [focused, MAIN_WINDOW_RPC_KEY]) {
      const rpc = this.rpcs.getWindowRpc(key);
      if (rpc && this.rpcs.isWindowRpcReady(key)) return { key, rpc };
    }
    return null;
  }

  runApplicationMenuCommand(command: ElectrobunApplicationMenuCommand): void {
    if (command.type === "open-devtools") {
      this.nativeWindow(this.focusedFullWindow()?.key ?? MAIN_WINDOW_ID)?.webview.openDevTools();
      return;
    }
    if (command.type === "new-window") {
      if (this.workspace) void this.openExtraWindow().catch((error: unknown) => {
        console.error("[desktop] could not open a window", summarizeError(error));
      });
      return;
    }
    if (command.type === "quit") {
      const rpc = this.readyMainWindowRpc();
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
    // Menu commands go to the full window in front, or the one used last.
    const target = this.focusedFullWindow();
    if (!target) return;
    // The bar and every form open in that window; with a popped-out pane's
    // window in front, the keys would go there instead.
    if (command.type === "open-command-bar" || command.type === "open-builtin-workflow" || command.type === "open-plugin-workflow") {
      this.windowController?.focus(target.key);
    }
    target.rpc.send["application-menu.select"]({ command });
  }

  quit(): void {
    if (this.quitting) return;
    this.quitting = true;
    // The order a quit had with one window: the other windows close, the
    // services stop while the main window can still hear from them, and
    // the main window goes last.
    this.closeAllWindows();
    this.teardownServices();
    this.windowController?.closeWindow(MAIN_WINDOW_ID);
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
    scheduleDesktopRelaunch().then(
      // As a quit does: an app whose windows are gone ends at once on Windows.
      () => this.quit(),
      (error: unknown) => {
        this.restartInProgress = false;
        console.error("[desktop-recovery] failed to schedule restart", summarizeError(error));
      },
    );
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
      this.scheduleCommandLinks();
    }
    return init;
  }

  /**
   * An install from before the rename updates its bundle in place and keeps
   * only the `gloomberb` command its installer linked, so the app adds `gloom`
   * beside it. First, a Mac `Gloomberb.app` left beside this `Gloom.app` goes,
   * its links moved here. That looks through PATH, which can hold a slow
   * network folder, so it runs a while after the main window is up and never
   * in its way.
   */
  private scheduleCommandLinks(): void {
    if (this.commandLinksScheduled) return;
    this.commandLinksScheduled = true;
    const log = debugLog.createLogger("desktop-command");
    const where = {
      platform: process.platform,
      homeDir: homedir(),
      pathEnv: process.env.PATH ?? "",
    };
    const timer = setTimeout(() => {
      void removeLegacyMacApp({ ...where, execPath: process.execPath }).then((removed) => {
        if (removed) log.info("Removed the app's copy under its old name");
      }, (error: unknown) => {
        log.warn("Could not remove the app's copy under its old name", summarizeError(error));
      }).then(() => linkDesktopCommands({
        ...where,
        localAppData: process.env.LOCALAPPDATA,
      })).then((added) => {
        if (added.length > 0) log.info(`Added the gloom command in ${added.length} folder(s)`);
      }, (error: unknown) => {
        log.warn("Could not add the gloom command", summarizeError(error));
      });
    }, COMMAND_LINK_DELAY_MS);
    timer.unref?.();
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
      case "desktop.openWindow":
      case "desktop.moveLayoutToWindow":
      case "desktop.movePaneToWindow":
      case "desktop.focusWindow":
      case "desktop.focusPane":
        return handleDesktopWorkspaceRequest(this, rpc, request);
      case "pluginState.setMany":
      case "pluginState.delete":
        return handleDesktopPluginStateRequest(this.requireServices().persistence.pluginState, request);
      case "plugins.listExternal":
        // The view asks beside `init`. Waiting for a launch in flight takes
        // the bundles it compiles, and keeps a second load of the plugins
        // from running beside the one the services do. It never starts a
        // launch of its own: that is `init`'s.
        return joinDesktopBackendLaunch(this).then(takeExternalPluginBundles);
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
      case "host.windowMaximized":
      case "host.startWindowDrag":
      case "host.startWindowResize":
      case "host.openExternal":
      case "host.copyText":
      case "host.focusWindow":
      case "host.copyPngImage":
      case "host.readText":
      case "host.saveTextFile":
      case "host.notify":
      case "host.showContextMenu":
      case "host.saveBootFrame":
      case "host.saveViewIds":
      case "host.setAppBadge":
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
