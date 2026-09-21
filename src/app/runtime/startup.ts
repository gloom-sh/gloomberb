import { useCallback, useEffect, type Dispatch } from "react";
import { loadPersistedBrokerAccountMap } from "../../brokers/account-cache";
import type { AppSessionSnapshot } from "../../core/state/session-persistence";
import type { AppTickerRepositoryPort } from "../../core/app-service-ports";
import type { MarketDataCoordinator } from "../../market-data/coordinator";
import { instrumentFromTicker, type InstrumentRef } from "../../market-data/request-types";
import { useSavedLayoutWarmup } from "./layout-warmup";
import { chatController } from "../../plugins/builtin/chat/controller";
import { PLUGIN_MARKETPLACE_PANE_ID } from "../../plugins/builtin/plugin-marketplace/ids";
import type { LoadedExternalPlugin } from "../../plugins/loader";
import type { PluginRegistry } from "../../plugins/registry";
import type {
  AppAction,
  AppState,
} from "../../state/app/context";
import {
  initializeAppState,
  type InitializeAppStateArgs,
} from "../../state/app/bootstrap";
import type { DataProvider } from "../../types/data-provider";
import type { BrokerAccount } from "../../types/trading";
import { debugLog } from "../../utils/debug-log";
import { startMainThreadStallMonitor } from "../../utils/main-thread-stall";
import { measurePerfAsync } from "../../utils/perf-marks";

const appLog = debugLog.createLogger("app");

interface UseAppStartupRuntimeOptions {
  appActive: boolean;
  autoImportBrokerPositions: InitializeAppStateArgs["autoImportBrokerPositions"];
  dataProvider: DataProvider;
  dispatch: Dispatch<AppAction>;
  externalPlugins: readonly LoadedExternalPlugin[];
  focusedTickerSymbol: string | null;
  getState: () => AppState;
  isDetachedWindow?: boolean;
  marketData: MarketDataCoordinator;
  pluginRegistry: PluginRegistry;
  primeCachedFinancials: InitializeAppStateArgs["primeCachedFinancials"];
  refreshQuote: InitializeAppStateArgs["refreshQuote"];
  refreshQuotesBatch: InitializeAppStateArgs["refreshQuotesBatch"];
  refreshTicker: InitializeAppStateArgs["refreshTicker"];
  refreshTickersBatch: InitializeAppStateArgs["refreshTickersBatch"];
  sessionSnapshot?: AppSessionSnapshot | null;
  state: AppState;
  tickerRepository: AppTickerRepositoryPort;
}

export function useAppStartupRuntime({
  appActive,
  autoImportBrokerPositions,
  dataProvider,
  dispatch,
  externalPlugins,
  focusedTickerSymbol,
  getState,
  isDetachedWindow = false,
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
}: UseAppStartupRuntimeOptions): void {
  useEffect(() => {
    chatController.setAppActive(appActive);
    appLog.info("app activity propagated", { active: appActive });
  }, [appActive]);

  // Runs for the life of the app: a freeze is only reportable if something
  // was watching the clock while it happened.
  useEffect(() => startMainThreadStallMonitor(), []);

  useEffect(() => {
    if (state.initialized || (globalThis as any).__gloomInitStarted) return;
    (globalThis as any).__gloomInitStarted = true;
    (async () => {
      try {
        let persistedBrokerAccounts: Record<string, BrokerAccount[]> = {};
        try {
          persistedBrokerAccounts = loadPersistedBrokerAccountMap(
            pluginRegistry.persistence.resources,
            state.config.brokerInstances,
            pluginRegistry.brokers,
          );
        } catch (error) {
          console.error("[startup] Failed to load persisted broker accounts:", error);
          pluginRegistry.notify({
            body: "Failed to load saved broker account data. Check local storage permissions.",
            type: "error",
          });
        }
        await measurePerfAsync("startup.app.initialize-state", () => initializeAppState({
          config: state.config,
          tickerRepository,
          dataProvider,
          sessionSnapshot,
          paneState: state.paneState,
          getPaneState: () => getState().paneState,
          dispatch,
          primeCachedFinancials,
          refreshTicker,
          refreshQuote,
          refreshTickersBatch,
          refreshQuotesBatch,
          autoImportBrokerPositions,
          persistedBrokerAccounts,
        }), {
          brokerInstanceCount: state.config.brokerInstances.length,
          layoutPaneCount: state.config.layout.instances.length,
          sessionHydrationTargetCount: sessionSnapshot?.hydrationTargets.length ?? 0,
        });
      } catch (err) {
        // Will show empty state.
      }
    })();
  }, [
    autoImportBrokerPositions,
    dataProvider,
    dispatch,
    getState,
    pluginRegistry.brokers,
    pluginRegistry.persistence.resources,
    primeCachedFinancials,
    refreshQuote,
    refreshQuotesBatch,
    refreshTicker,
    refreshTickersBatch,
    sessionSnapshot,
    state.config,
    state.initialized,
    tickerRepository,
  ]);

  // A plugin that failed to import is otherwise silent: its panes are simply
  // absent, and the reason sits in a pane the user has no cause to open. Say
  // so once, with a way in. Unsupported-renderer entries are not failures.
  useEffect(() => {
    // Popped-out desktop panes load the same list; the main window owns the notice.
    if (!state.initialized || isDetachedWindow) return;
    const failed = externalPlugins.filter((entry) => entry.error && !entry.unsupportedTarget);
    if (failed.length === 0) return;
    const names = failed.map((entry) => entry.plugin.name);
    const body = failed.length === 1
      ? `${names[0]} failed to load.`
      : `${failed.length} plugins failed to load: ${names.join(", ")}.`;
    appLog.warn("external plugins failed to load", { plugins: failed.map((entry) => ({ id: entry.plugin.id, error: entry.error })) });
    pluginRegistry.notify({
      body,
      type: "error",
      persistent: true,
      action: {
        label: "Open Plugins",
        onClick: () => pluginRegistry.showPane(PLUGIN_MARKETPLACE_PANE_ID),
      },
    });
    // Once per process: `externalPlugins` is the startup list and never changes
    // identity, so this runs when initialization flips and not again.
  }, [externalPlugins, isDetachedWindow, pluginRegistry, state.initialized]);

  useEffect(() => {
    if (!focusedTickerSymbol) return;
    const ticker = state.tickers.get(focusedTickerSymbol);
    if (!ticker) return;
    appLog.info("focused ticker prefetch scheduled", {
      symbol: ticker.metadata.ticker,
      exchange: ticker.metadata.exchange,
    });
    marketData.prefetchTicker(instrumentFromTicker(ticker, ticker.metadata.ticker));
  }, [focusedTickerSymbol, marketData, state.tickers]);

  const prefetchInstrument = useCallback((instrument: InstrumentRef) => {
    marketData.prefetchTicker(instrument);
  }, [marketData]);
  useSavedLayoutWarmup({
    appActive,
    config: state.config,
    initialized: state.initialized,
    prefetch: prefetchInstrument,
    tickers: state.tickers,
  });
}
