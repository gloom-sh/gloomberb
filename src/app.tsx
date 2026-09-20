import { Box, ContextMenuProvider, useNativeRenderer, useRendererHost } from "./ui";
import { ToastViewport, useToastHost } from "./ui/toast";
import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from "react";
import {
  AppProvider,
  getFocusedTickerSymbol,
  useAppDispatch,
  useAppSelector,
  useAppStateRef,
  type AppState,
} from "./state/app/context";
import { bindAppActivity, useAppActive } from "./state/app/activity";
import { Header } from "./components/layout/header";
import { StatusBar } from "./components/layout/status-bar";
import { useLinkedLayoutSync } from "./layout-marketplace/linked-sync";
import { useTeamCollectionsSync } from "./plugins/builtin/cloud/team/collections-sync";
import { Shell } from "./components/layout/shell";
import { DetachedPaneShell } from "./components/layout/detached-pane-shell";
import { TransientLayoutProvider } from "./components/layout/transient-layout";
import { CommandBar } from "./components/command-bar/surface";
import { OnboardingWizard } from "./components/onboarding/onboarding-wizard";
import { SignInGate } from "./components/sign-in-gate";
import { useDialog } from "./ui/dialog";
import { PluginRegistry } from "./plugins/registry";
import type { LoadedExternalPlugin } from "./plugins/loader";
import type { AppServicesFactory, AppTickerRepositoryPort } from "./core/app-service-ports";
import { useThemeColors } from "./theme/theme-context";
import type { AppConfig } from "./types/config";
import type { DesktopDeepLinkBridge } from "./types/desktop-deeplink";
import type { CliLaunchRequest, GloomPlugin } from "./types/plugin";
import type { DataProvider } from "./types/data-provider";
import type { DesktopDockPreviewState, DesktopSharedStateSnapshot, DesktopThemePreviewState, DesktopWindowBridge } from "./types/desktop-window";
import type { DesktopApplicationMenuBridge } from "./types/desktop-menu";
import type { LayoutBounds } from "./plugins/pane-manager";
import type { AppSessionSnapshot } from "./core/state/session-persistence";
import type { MarketDataCoordinator } from "./market-data/coordinator";
import { createAppNotifier } from "./notifications/app-notifier";
import { useBrokerImportRuntime } from "./app/runtime/broker-import";
import { useDesktopDeepLinkRuntime } from "./app/runtime/desktop-deeplink";
import { useDesktopApplicationMenuRuntime } from "./app/runtime/desktop-menu";
import { useAppGlobalShortcuts } from "./app/global-shortcuts";
import { KeybindingsProvider, useResolvedKeybindings } from "./app/keybindings";
import { useAppPaneRuntime } from "./app/pane-runtime";
import { bindPluginRegistryRuntimeAccess } from "./app/runtime/plugin-bindings";
import { useAppStartupRuntime } from "./app/runtime/startup";
import { useTickerRefreshRuntime } from "./app/runtime/ticker-refresh";
import { useAppUpdateRuntime } from "./app/runtime/update";
import { createCoreSyncContributors } from "./sync/core-contributors";
import { useCloudSyncRuntime } from "./sync/react";
import { RemoteControlHost, type RemoteControlAdapter } from "./remote/app-host";
import { RemoteUiRegistryProvider } from "./remote/semantic-tree";
import {
  resolveAppSessionSnapshot,
  resolveCliLaunchConfig,
  resolveInitialAppConfig,
} from "./app/app-bootstrap-state";
import { scheduleConfigSave } from "./state/config-save-scheduler";
import { LOW_PRIORITY_CONFIG_SAVE_DEBOUNCE_MS } from "./state/persist-scheduler";
import { savedLayoutsDifferOnlyInMirror } from "./core/state/app/layout";
import { measurePerf } from "./utils/perf-marks";
import { useAppLanguage } from "./i18n/react";
import { AppLanguageConfigObserver } from "./app/language-observer";
import { isPaneShareHandoff } from "./shares/location";
import { apiClient } from "./api-client";

const EMPTY_EXTERNAL_PLUGINS: LoadedExternalPlugin[] = [];

interface AppInnerProps {
  externalPlugins: readonly LoadedExternalPlugin[];
  pluginRegistry: PluginRegistry;
  tickerRepository: AppTickerRepositoryPort;
  dataProvider: DataProvider;
  marketData: MarketDataCoordinator;
  sessionSnapshot?: AppSessionSnapshot | null;
  desktopWindowBridge?: DesktopWindowBridge;
  desktopApplicationMenuBridge?: DesktopApplicationMenuBridge;
  desktopDeepLinkBridge?: DesktopDeepLinkBridge;
  remoteControlAdapter?: RemoteControlAdapter;
  updatesEnabled?: boolean;
  onboardingActive?: boolean;
  onOnboardingComplete?: (config: AppConfig) => void | Promise<void>;
  /** Hosted browser terminal: nothing is reachable until a session exists. */
  signInGateActive?: boolean;
  /** Fires once the startup state is in place and the first real layout can paint. */
  onInitialized?: () => void;
}

function ThemedAppRoot({ children }: { children: ReactNode }) {
  const themeColors = useThemeColors();
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      flexBasis={0}
      minWidth={0}
      minHeight={0}
      overflow="hidden"
      backgroundColor={themeColors.bg}
    >
      {children}
    </Box>
  );
}

function AppInner({
  externalPlugins,
  pluginRegistry,
  tickerRepository,
  dataProvider,
  marketData,
  sessionSnapshot = null,
  desktopWindowBridge,
  desktopApplicationMenuBridge,
  desktopDeepLinkBridge,
  remoteControlAdapter,
  updatesEnabled = true,
  onboardingActive = false,
  onOnboardingComplete,
  signInGateActive = false,
  onInitialized,
}: AppInnerProps) {
  const dispatch = useAppDispatch();
  const stateRef = useAppStateRef();
  const getRemoteState = useCallback(() => stateRef.current, [stateRef]);
  useLinkedLayoutSync(pluginRegistry);
  const config = useAppSelector((state) => state.config);
  const tickers = useAppSelector((state) => state.tickers);
  const paneState = useAppSelector((state) => state.paneState);
  const focusedPaneId = useAppSelector((state) => state.focusedPaneId);
  const initialized = useAppSelector((state) => state.initialized);
  const onInitializedRef = useRef(onInitialized);
  onInitializedRef.current = onInitialized;
  useEffect(() => {
    if (initialized) onInitializedRef.current?.();
  }, [initialized]);
  const commandBarOpen = useAppSelector((state) => state.commandBarOpen);
  const inputCaptured = useAppSelector((state) => state.inputCaptured);
  const updateAvailable = useAppSelector((state) => state.updateAvailable);
  const updateProgress = useAppSelector((state) => state.updateProgress);
  const updateCheckInProgress = useAppSelector((state) => state.updateCheckInProgress);
  const state = useMemo(() => ({
    ...stateRef.current,
    config,
    tickers,
    paneState,
    focusedPaneId,
    initialized,
    commandBarOpen,
    inputCaptured,
    updateAvailable,
    updateProgress,
    updateCheckInProgress,
  }) as AppState, [
    commandBarOpen,
    config,
    focusedPaneId,
    initialized,
    inputCaptured,
    paneState,
    stateRef,
    tickers,
    updateAvailable,
    updateCheckInProgress,
    updateProgress,
  ]);
  const appActive = useAppActive();
  const appActiveRef = useRef(appActive);
  const rendererHost = useRendererHost();
  const dialog = useDialog();
  const toast = useToastHost();
  const isDetachedWindow = desktopWindowBridge?.kind === "detached";
  const detachedPaneId = isDetachedWindow ? desktopWindowBridge.paneId ?? null : null;
  const [desktopDockPreview, setDesktopDockPreview] = useState<DesktopDockPreviewState | null>(null);
  const [commandBarNativeOccluder, setCommandBarNativeOccluder] = useState<LayoutBounds | null>(null);
  appActiveRef.current = appActive;
  const appNotifier = useMemo(() => createAppNotifier({
    isAppActive: () => appActiveRef.current,
    renderToast: (notification) => {
      const type = notification.type ?? "info";
      let toastId: string | number | undefined;
      const dismissAfter = (run: () => void) => () => {
        try {
          run();
        } finally {
          if (toastId != null) toast.dismiss(toastId);
        }
      };
      const options = {
        title: notification.title,
        subtitle: notification.subtitle,
        duration: notification.persistent ? 0 : notification.duration,
        action: notification.action
          ? {
            label: notification.action.label,
            onClick: dismissAfter(() => notification.action?.onClick()),
          }
          : undefined,
        secondaryAction: notification.secondaryAction
          ? {
            label: notification.secondaryAction.label,
            onClick: dismissAfter(() => notification.secondaryAction?.onClick()),
          }
          : undefined,
      };
      if (type === "success") toastId = toast.success(notification.body, options);
      else if (type === "error") toastId = toast.error(notification.body, options);
      else toastId = toast.info(notification.body, options);
    },
    desktop: rendererHost.supportsNativeDesktopNotifications ? rendererHost : undefined,
  }), [rendererHost, toast]);
  const notify = useCallback((body: string, options?: { type?: "info" | "success" | "error" }) => {
    pluginRegistry.notify({ body, ...options });
  }, [pluginRegistry]);

  useEffect(() => {
    if (desktopWindowBridge?.kind !== "main" || !desktopWindowBridge.subscribeDockPreview) return;
    return desktopWindowBridge.subscribeDockPreview((preview) => {
      setDesktopDockPreview(preview);
    });
  }, [desktopWindowBridge]);

  useEffect(() => {
    const disposers = createCoreSyncContributors().map((contributor) => (
      pluginRegistry.registerSyncContributorForPlugin("core", contributor)
    ));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [pluginRegistry]);

  const {
    primeCachedFinancials,
    refreshQuote,
    refreshQuotesBatch,
    refreshTicker,
    refreshTickersBatch,
  } = useTickerRefreshRuntime({
    appActive,
    baseCurrency: state.config.baseCurrency,
    dispatch,
    marketData,
    pluginRegistry,
    tickers: state.tickers,
  });

  const { importBrokerPositions, autoImportBrokerPositions } = useBrokerImportRuntime({
    dispatch,
    pluginRegistry,
    refreshQuote,
    stateRef,
    tickerRepository,
  });

  const { runUpdateCheck, startUpdate } = useAppUpdateRuntime({
    enabled: updatesEnabled,
    dispatch,
    isDetachedWindow,
    pluginRegistry,
    stateRef,
    updateAvailable: state.updateAvailable,
    updateCheckInProgress: state.updateCheckInProgress,
    updateProgress: state.updateProgress,
  });

  useDesktopApplicationMenuRuntime({
    desktopApplicationMenuBridge,
    desktopWindowKind: desktopWindowBridge?.kind,
    dispatch,
    pluginRegistry,
    rendererHost,
    runUpdateCheck,
    stateRef,
  });

  useDesktopDeepLinkRuntime({
    desktopDeepLinkBridge,
    desktopWindowKind: desktopWindowBridge?.kind,
    dispatch,
    // The browser bridge re-emits from the URL on subscribe and nothing rewrites
    // it, so a `?layout=` / `?share=` intent survives the gate and lands once a
    // session exists. Running it earlier would only 401 behind the scrim.
    initialized: state.initialized && !signInGateActive,
    pluginRegistry,
    stateRef,
  });

  const focusedTickerSymbol = getFocusedTickerSymbol(state);
  useAppStartupRuntime({
    appActive,
    autoImportBrokerPositions,
    dataProvider,
    dispatch,
    externalPlugins,
    focusedTickerSymbol,
    getState: getRemoteState,
    isDetachedWindow,
    marketData,
    pluginRegistry,
    primeCachedFinancials,
    refreshQuote,
    refreshQuotesBatch,
    refreshTicker,
    refreshTickersBatch,
    sessionSnapshot,
    state,
    tickerRepository,
  });

  bindPluginRegistryRuntimeAccess({
    dataProvider,
    dispatch,
    importBrokerPositions,
    marketData,
    pluginRegistry,
    stateRef,
    tickerRepository,
  });

  useCloudSyncRuntime({
    state,
    getState: getRemoteState,
    dispatch,
    tickerRepository,
    pluginRegistry,
    appActive,
    // Keep a first-run workspace stable while the local guide is active. Once
    // onboarding finishes, the normal pull-before-push sync starts immediately.
    initialized: state.initialized
      && desktopWindowBridge?.kind !== "detached"
      && !onboardingActive
      && !signInGateActive,
  });

  const persistConfig = useCallback((nextConfig: AppState["config"]) => {
    scheduleConfigSave(nextConfig);
  }, []);
  useTeamCollectionsSync({ persistConfig, tickerRepository });

  useAppPaneRuntime({
    dataProvider,
    detachedPaneId,
    dialog,
    dispatch,
    externalPlugins,
    isDetachedWindow,
    notify,
    persistConfig,
    pluginRegistry,
    state,
    stateRef,
    tickerRepository,
  });

  // Wire up app-level notifications.
  pluginRegistry.notifyFn = appNotifier.notify;

  // Persist layout changes (switching, saving, deleting, renaming layouts).
  // The saved layouts also mirror live pane state and focus, so they change on
  // every cursor move; those updates are written on the low-priority delay
  // rather than paying a full config serialization per keystroke.
  const prevLayouts = useRef(state.config.layouts);
  useEffect(() => {
    if (state.config.layouts === prevLayouts.current) return;
    const mirrorOnly = savedLayoutsDifferOnlyInMirror(prevLayouts.current, state.config.layouts);
    prevLayouts.current = state.config.layouts;
    scheduleConfigSave(
      () => stateRef.current.config,
      mirrorOnly ? { delayMs: LOW_PRIORITY_CONFIG_SAVE_DEBOUNCE_MS } : {},
    );
  }, [state.config.layouts, state.config, stateRef]);

  // Emit ticker:selected events based on focused pane context.
  const prevSelectedRef = useRef(focusedTickerSymbol);
  useEffect(() => {
    if (focusedTickerSymbol !== prevSelectedRef.current) {
      pluginRegistry.events.emit("ticker:selected", {
        symbol: focusedTickerSymbol,
        previous: prevSelectedRef.current,
      });
      prevSelectedRef.current = focusedTickerSymbol;
    }
  }, [focusedTickerSymbol]);

  const keybindings = useResolvedKeybindings(state.config.keybindings);
  useAppGlobalShortcuts({
    dispatch,
    focusedTickerSymbol,
    isDetachedWindow,
    keybindings,
    pluginRegistry,
    refreshTicker,
    startUpdate,
    state,
  });

  if (desktopWindowBridge?.kind === "detached" && desktopWindowBridge.paneId) {
    return (
      <KeybindingsProvider value={keybindings}>
        <ContextMenuProvider pluginRegistry={pluginRegistry}>
          <RemoteControlHost
            adapter={remoteControlAdapter}
            dispatch={dispatch}
            getState={getRemoteState}
            pluginRegistry={pluginRegistry}
            desktopWindowBridge={desktopWindowBridge}
          >
            <ThemedAppRoot>
              <DetachedPaneShell
                pluginRegistry={pluginRegistry}
                desktopWindowBridge={{ ...desktopWindowBridge, kind: "detached", paneId: desktopWindowBridge.paneId }}
              />
              <ToastViewport position="bottom-right" />
            </ThemedAppRoot>
          </RemoteControlHost>
        </ContextMenuProvider>
      </KeybindingsProvider>
    );
  }

  return (
    <KeybindingsProvider value={keybindings}>
    <ContextMenuProvider pluginRegistry={pluginRegistry}>
      <RemoteControlHost
        adapter={remoteControlAdapter}
        dispatch={dispatch}
        getState={getRemoteState}
        pluginRegistry={pluginRegistry}
        desktopWindowBridge={desktopWindowBridge}
      >
        <ThemedAppRoot>
          <Header onOpenHelp={() => pluginRegistry.showPane("help")} />
          <TransientLayoutProvider>
            <Shell
              pluginRegistry={pluginRegistry}
              desktopWindowBridge={desktopWindowBridge}
              desktopDockPreview={desktopDockPreview}
              commandBarNativeOccluder={commandBarNativeOccluder}
            />
            <StatusBar
              onOpenChangelog={(version) => {
                void pluginRegistry.createPaneFromTemplateAsyncFn("changelog-pane", {
                  values: { version },
                }).catch(() => {});
              }}
            />
          </TransientLayoutProvider>
          {onboardingActive && onOnboardingComplete ? (
            <OnboardingWizard
              pluginRegistry={pluginRegistry}
              importBrokerPositions={importBrokerPositions}
              onComplete={onOnboardingComplete}
            />
          ) : null}
          {signInGateActive ? <SignInGate /> : null}
          {state.commandBarOpen && (
            <CommandBar
              dataProvider={dataProvider}
              tickerRepository={tickerRepository}
              pluginRegistry={pluginRegistry}
              quitApp={() => rendererHost.requestExit()}
              onCheckForUpdates={updatesEnabled ? () => runUpdateCheck(true) : undefined}
              onNativeOccluderChange={setCommandBarNativeOccluder}
            />
          )}
          <ToastViewport position="bottom-right" />
        </ThemedAppRoot>
      </RemoteControlHost>
    </ContextMenuProvider>
    </KeybindingsProvider>
  );
}

interface AppProps {
  config: AppConfig;
  servicesFactory: AppServicesFactory;
  externalPlugins?: LoadedExternalPlugin[];
  plugins: readonly GloomPlugin[];
  cliLaunchRequest?: CliLaunchRequest | null;
  desktopWindowBridge?: DesktopWindowBridge;
  desktopApplicationMenuBridge?: DesktopApplicationMenuBridge;
  desktopDeepLinkBridge?: DesktopDeepLinkBridge;
  desktopSnapshot?: DesktopSharedStateSnapshot | null;
  desktopThemePreview?: DesktopThemePreviewState | null;
  remoteControlAdapter?: RemoteControlAdapter;
  updatesEnabled?: boolean;
  /**
   * Requires a Gloom Cloud session before the app is usable. The hosted browser
   * terminal sets this; desktop and the TUI keep sign-in optional.
   */
  requireSignIn?: boolean;
  /** Fires once the startup state is in place and the first real layout can paint. */
  onInitialized?: () => void;
}

export function App({
  config: initialConfig,
  servicesFactory,
  externalPlugins: providedExternalPlugins,
  plugins,
  cliLaunchRequest = null,
  desktopWindowBridge,
  desktopApplicationMenuBridge,
  desktopDeepLinkBridge,
  desktopSnapshot = null,
  desktopThemePreview = null,
  remoteControlAdapter,
  updatesEnabled = true,
  requireSignIn = false,
  onInitialized,
}: AppProps) {
  useAppLanguage();
  const externalPlugins = providedExternalPlugins ?? EMPTY_EXTERNAL_PLUGINS;
  const renderer = useNativeRenderer();
  const effectiveInitialConfig = useMemo(() => {
    return resolveInitialAppConfig({
      initialConfig,
      desktopSnapshot,
      hasDesktopWindowBridge: !!desktopWindowBridge,
    });
  }, [desktopSnapshot, desktopWindowBridge, initialConfig]);
  const initialCliLaunch = useMemo(() => {
    return resolveCliLaunchConfig({
      cliLaunchRequest,
      config: effectiveInitialConfig,
      terminalWidth: renderer.terminalWidth,
      terminalHeight: renderer.terminalHeight,
    });
  }, [cliLaunchRequest, effectiveInitialConfig, renderer.terminalHeight, renderer.terminalWidth]);
  const cliLaunchStateRef = useRef(initialCliLaunch.launchState);

  const [config, setConfig] = useState(() => {
    return initialCliLaunch.config;
  });
  // Only the surfaces that require a session subscribe, so desktop and the
  // terminal keep their current render profile.
  const [signedIn, setSignedIn] = useState(() => !requireSignIn || apiClient.isSignedIn());
  useEffect(() => {
    if (!requireSignIn) return;
    const sync = () => setSignedIn(apiClient.isSignedIn());
    sync();
    return apiClient.subscribeCurrentUser(sync);
  }, [requireSignIn]);
  const signInGateActive = requireSignIn && !signedIn;
  const shareHandoff = isPaneShareHandoff();
  const [showOnboarding, setShowOnboarding] = useState(() => (
    desktopWindowBridge?.kind !== "detached"
    && !shareHandoff
    && (!effectiveInitialConfig.onboardingComplete || !!effectiveInitialConfig.onboardingProgress)
  ));

  useEffect(() => bindAppActivity(renderer), [renderer]);

  const services = useMemo(() => {
    return measurePerf("startup.app.create-services", () => (
      servicesFactory({
        config,
        plugins,
        externalPlugins,
      })
    ), {
      externalPluginCount: externalPlugins.length,
      disabledPluginCount: config.disabledPlugins.length,
      brokerInstanceCount: config.brokerInstances.length,
    });
  }, [config.dataDir, externalPlugins, plugins, servicesFactory]);

  useEffect(() => {
    return () => services.destroy();
  }, [services]);

  const sessionSnapshot = useMemo(() => {
    return resolveAppSessionSnapshot({
      cliLaunchRequest,
      config,
      cliLaunchState: cliLaunchStateRef.current,
      desktopSnapshot,
      desktopWindowKind: desktopWindowBridge?.kind,
      sessionStore: services.persistence.sessions,
    });
  }, [cliLaunchRequest, config, desktopSnapshot, desktopWindowBridge?.kind, services.persistence.sessions]);

  return (
    <RemoteUiRegistryProvider>
      <AppProvider
        config={config}
        sessionStore={desktopWindowBridge?.kind === "detached" ? undefined : services.persistence.sessions}
        sessionSnapshot={sessionSnapshot}
        desktopBridge={desktopWindowBridge}
        desktopSnapshot={desktopSnapshot}
        initialThemePreview={desktopThemePreview}
      >
        <AppLanguageConfigObserver />
        <AppInner
          externalPlugins={externalPlugins}
          pluginRegistry={services.pluginRegistry}
          tickerRepository={services.tickerRepository}
          dataProvider={services.dataProvider}
          marketData={services.marketData}
          sessionSnapshot={sessionSnapshot}
          desktopWindowBridge={desktopWindowBridge}
          desktopApplicationMenuBridge={desktopApplicationMenuBridge}
          desktopDeepLinkBridge={desktopDeepLinkBridge}
          remoteControlAdapter={remoteControlAdapter}
          updatesEnabled={updatesEnabled}
          onboardingActive={showOnboarding}
          signInGateActive={signInGateActive}
          onInitialized={onInitialized}
          onOnboardingComplete={(updatedConfig) => {
            setConfig(updatedConfig);
            setShowOnboarding(false);
          }}
        />
      </AppProvider>
    </RemoteUiRegistryProvider>
  );
}
