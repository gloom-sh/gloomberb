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
import { Shell } from "./components/layout/shell";
import { DetachedPaneShell } from "./components/layout/detached-pane-shell";
import { TransientLayoutProvider } from "./components/layout/transient-layout";
import { CommandBar } from "./components/command-bar/surface";
import { OnboardingWizard } from "./components/onboarding/onboarding-wizard";
import { useDialog } from "./ui/dialog";
import { PluginRegistry } from "./plugins/registry";
import type { LoadedExternalPlugin } from "./plugins/loader";
import type { AppServicesFactory, AppTickerRepositoryPort } from "./core/app-service-ports";
import { useThemeColors } from "./theme/theme-context";
import type { AppConfig } from "./types/config";
import type { DesktopDeepLinkBridge } from "./types/desktop-deeplink";
import type { CliLaunchRequest } from "./types/plugin";
import type { DataProvider } from "./types/data-provider";
import type { DesktopDockPreviewState, DesktopSharedStateSnapshot, DesktopThemePreviewState, DesktopWindowBridge } from "./types/desktop-window";
import type { DesktopApplicationMenuBridge } from "./types/desktop-menu";
import type { LayoutBounds } from "./plugins/pane-manager";
import type { AppSessionSnapshot } from "./core/state/session-persistence";
import type { MarketDataCoordinator } from "./market-data/coordinator";
import { createAppNotifier } from "./notifications/app-notifier";
import { getLoadablePlugins } from "./plugins/catalog";
import { useBrokerImportRuntime } from "./app/runtime/broker-import";
import { useDesktopDeepLinkRuntime } from "./app/runtime/desktop-deeplink";
import { useDesktopApplicationMenuRuntime } from "./app/runtime/desktop-menu";
import { useAppGlobalShortcuts } from "./app/global-shortcuts";
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
import { measurePerf } from "./utils/perf-marks";
import { useAppLanguage } from "./i18n/react";
import { AppLanguageConfigObserver } from "./app/language-observer";

const EMPTY_EXTERNAL_PLUGINS: LoadedExternalPlugin[] = [];

interface AppInnerProps {
  pluginRegistry: PluginRegistry;
  tickerRepository: AppTickerRepositoryPort;
  dataProvider: DataProvider;
  marketData: MarketDataCoordinator;
  sessionSnapshot?: AppSessionSnapshot | null;
  desktopWindowBridge?: DesktopWindowBridge;
  desktopApplicationMenuBridge?: DesktopApplicationMenuBridge;
  desktopDeepLinkBridge?: DesktopDeepLinkBridge;
  remoteControlAdapter?: RemoteControlAdapter;
  onboardingActive?: boolean;
  onOnboardingComplete?: (config: AppConfig) => void | Promise<void>;
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
  pluginRegistry,
  tickerRepository,
  dataProvider,
  marketData,
  sessionSnapshot = null,
  desktopWindowBridge,
  desktopApplicationMenuBridge,
  desktopDeepLinkBridge,
  remoteControlAdapter,
  onboardingActive = false,
  onOnboardingComplete,
}: AppInnerProps) {
  const dispatch = useAppDispatch();
  const stateRef = useAppStateRef();
  const getRemoteState = useCallback(() => stateRef.current, [stateRef]);
  const config = useAppSelector((state) => state.config);
  const tickers = useAppSelector((state) => state.tickers);
  const paneState = useAppSelector((state) => state.paneState);
  const focusedPaneId = useAppSelector((state) => state.focusedPaneId);
  const initialized = useAppSelector((state) => state.initialized);
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
      const options = {
        duration: notification.duration,
        action: notification.action
          ? {
            label: notification.action.label,
            onClick: () => {
              try {
                notification.action?.onClick();
              } finally {
                if (toastId != null) toast.dismiss(toastId);
              }
            },
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
    dispatch,
    isDetachedWindow,
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
    pluginRegistry,
    stateRef,
  });

  const focusedTickerSymbol = getFocusedTickerSymbol(state);
  useAppStartupRuntime({
    appActive,
    autoImportBrokerPositions,
    dataProvider,
    dispatch,
    focusedTickerSymbol,
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
    state,
    tickerRepository,
  });

  useCloudSyncRuntime({
    state,
    getState: getRemoteState,
    dispatch,
    tickerRepository,
    pluginRegistry,
    // Keep a first-run workspace stable while the local guide is active. Once
    // onboarding finishes, the normal pull-before-push sync starts immediately.
    initialized: state.initialized
      && desktopWindowBridge?.kind !== "detached"
      && !onboardingActive,
  });

  useAppPaneRuntime({
    dataProvider,
    detachedPaneId,
    dialog,
    dispatch,
    isDetachedWindow,
    notify,
    pluginRegistry,
    state,
    stateRef,
    tickerRepository,
  });

  // Wire up app-level notifications.
  pluginRegistry.notifyFn = appNotifier.notify;

  // Persist layout changes (switching, saving, deleting, renaming layouts)
  const prevLayouts = useRef(state.config.layouts);
  useEffect(() => {
    if (state.config.layouts !== prevLayouts.current) {
      prevLayouts.current = state.config.layouts;
      scheduleConfigSave(state.config);
    }
  }, [state.config.layouts, state.config]);

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

  useAppGlobalShortcuts({
    dispatch,
    focusedTickerSymbol,
    isDetachedWindow,
    pluginRegistry,
    refreshTicker,
    startUpdate,
    state,
  });

  if (desktopWindowBridge?.kind === "detached" && desktopWindowBridge.paneId) {
    return (
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
    );
  }

  return (
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
            <StatusBar />
          </TransientLayoutProvider>
          {onboardingActive && onOnboardingComplete ? (
            <OnboardingWizard
              pluginRegistry={pluginRegistry}
              importBrokerPositions={importBrokerPositions}
              onComplete={onOnboardingComplete}
            />
          ) : null}
          {state.commandBarOpen && (
            <CommandBar
              dataProvider={dataProvider}
              tickerRepository={tickerRepository}
              pluginRegistry={pluginRegistry}
              quitApp={() => rendererHost.requestExit()}
              onCheckForUpdates={() => runUpdateCheck(true)}
              onNativeOccluderChange={setCommandBarNativeOccluder}
            />
          )}
          <ToastViewport position="bottom-right" />
        </ThemedAppRoot>
      </RemoteControlHost>
    </ContextMenuProvider>
  );
}

interface AppProps {
  config: AppConfig;
  servicesFactory: AppServicesFactory;
  externalPlugins?: LoadedExternalPlugin[];
  cliLaunchRequest?: CliLaunchRequest | null;
  desktopWindowBridge?: DesktopWindowBridge;
  desktopApplicationMenuBridge?: DesktopApplicationMenuBridge;
  desktopDeepLinkBridge?: DesktopDeepLinkBridge;
  desktopSnapshot?: DesktopSharedStateSnapshot | null;
  desktopThemePreview?: DesktopThemePreviewState | null;
  remoteControlAdapter?: RemoteControlAdapter;
}

export function App({
  config: initialConfig,
  servicesFactory,
  externalPlugins: providedExternalPlugins,
  cliLaunchRequest = null,
  desktopWindowBridge,
  desktopApplicationMenuBridge,
  desktopDeepLinkBridge,
  desktopSnapshot = null,
  desktopThemePreview = null,
  remoteControlAdapter,
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
  const [showOnboarding, setShowOnboarding] = useState(() => (
    desktopWindowBridge?.kind !== "detached"
    && (!effectiveInitialConfig.onboardingComplete || !!effectiveInitialConfig.onboardingProgress)
  ));

  useEffect(() => bindAppActivity(renderer), [renderer]);

  const services = useMemo(() => {
    return measurePerf("startup.app.create-services", () => (
      servicesFactory({
        config,
        plugins: getLoadablePlugins(externalPlugins),
      })
    ), {
      externalPluginCount: externalPlugins.length,
      disabledPluginCount: config.disabledPlugins.length,
      brokerInstanceCount: config.brokerInstances.length,
    });
  }, [config.dataDir, externalPlugins, servicesFactory]);

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
          pluginRegistry={services.pluginRegistry}
          tickerRepository={services.tickerRepository}
          dataProvider={services.dataProvider}
          marketData={services.marketData}
          sessionSnapshot={sessionSnapshot}
          desktopWindowBridge={desktopWindowBridge}
          desktopApplicationMenuBridge={desktopApplicationMenuBridge}
          desktopDeepLinkBridge={desktopDeepLinkBridge}
          remoteControlAdapter={remoteControlAdapter}
          onboardingActive={showOnboarding}
          onOnboardingComplete={(updatedConfig) => {
            setConfig(updatedConfig);
            setShowOnboarding(false);
          }}
        />
      </AppProvider>
    </RemoteUiRegistryProvider>
  );
}
