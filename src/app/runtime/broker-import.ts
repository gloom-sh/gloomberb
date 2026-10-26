import { useCallback, useRef, type Dispatch } from "react";
import {
  rebaseBrokerSyncConfig,
  restoreBrokerPortfoliosFromTickerPositions,
  syncBrokerInstance,
  syncBrokerInstances,
} from "../../brokers/sync-broker-instance";
import type { SyncBrokerInstanceResult } from "../../brokers/sync-broker-instance";
import type { AppTickerRepositoryPort } from "../../core/app-service-ports";
import type { PluginRegistry } from "../../plugins/registry";
import { adoptHeldPortfolioCurrencies } from "../../portfolio/mutations";
import { saveConfigImmediately } from "../../state/config-save-scheduler";
import type { AppAction, AppState } from "../../state/app/context";
import type { AppConfig } from "../../types/config";
import type { TickerRecord } from "../../types/ticker";
import { getBrokerInstance } from "../../utils/broker-instances";

export interface AppBrokerImportRuntime {
  importBrokerPositions: (
    instanceId: string,
    /** What the sync reads. It lands on the app's tickers as they are when it commits, whatever was passed. */
    tickerMap?: Map<string, TickerRecord>,
    options?: BrokerImportOptions,
  ) => Promise<SyncBrokerInstanceResult>;
  autoImportBrokerPositions: (tickerMap: Map<string, TickerRecord>) => Promise<void>;
}

interface BrokerImportOptions {
  refreshImportedTickers?: boolean;
  config?: AppConfig;
  persistResolvedBrokerConfig?: boolean;
  signal?: AbortSignal;
  onCommitStart?: () => void;
  onCommitEnd?: () => void;
}

function throwIfBrokerImportCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Broker import was cancelled.");
  }
}

export function useBrokerImportRuntime({
  dispatch,
  pluginRegistry,
  refreshQuote,
  stateRef,
  tickerRepository,
}: {
  dispatch: Dispatch<AppAction>;
  pluginRegistry: PluginRegistry;
  refreshQuote: (symbol: string, exchange?: string, tickerOverride?: TickerRecord | null, priority?: number) => void;
  stateRef: { current: AppState };
  tickerRepository: AppTickerRepositoryPort;
}): AppBrokerImportRuntime {
  const syncRequests = useRef(new Map<string, object>());
  /**
   * Commits a sync: carried onto the app as it is now (a pull or an edit while
   * the broker answered stays) and handed to the app before anything is
   * written. With a wait in between, a pull landing in it would be overwritten
   * by this older copy and pushed from here as an edit. The writes start in
   * the same tick, so the copy of anyone writing after lands on disk after it.
   */
  const applyBrokerImportResult = useCallback(async (
    instanceId: string,
    result: SyncBrokerInstanceResult,
    baseConfig: AppConfig,
    options?: Pick<BrokerImportOptions, "refreshImportedTickers" | "signal"> & {
      /** The caller passed its own draft config, so the result replaces the live one. */
      callerOwnsConfig?: boolean;
    },
  ) => {
    throwIfBrokerImportCancelled(options?.signal);
    const live = stateRef.current;
    result.rebase(live);
    const nextConfig = options?.callerOwnsConfig
      ? (result.config !== baseConfig ? result.config : live.config)
      : rebaseBrokerSyncConfig(live.config, baseConfig, result.config, instanceId);
    const configChanged = nextConfig !== live.config;

    dispatch({ type: "SET_BROKER_ACCOUNTS", instanceId, accounts: result.brokerAccounts });
    if (configChanged) dispatch({ type: "SET_CONFIG", config: nextConfig });
    for (const ticker of [...result.addedTickers, ...result.updatedTickers]) {
      dispatch({ type: "UPDATE_TICKER", ticker });
    }
    await Promise.all([result.commit(), configChanged ? saveConfigImmediately(nextConfig) : undefined]);

    if (configChanged) pluginRegistry.events.emit("config:changed", { config: nextConfig });
    for (const ticker of result.addedTickers) {
      pluginRegistry.events.emit("ticker:added", { symbol: ticker.metadata.ticker, ticker });
    }

    for (const position of result.positions) {
      if (options?.signal?.aborted) break;
      // Skip market data for broker option symbols; position marks are already available.
      // Position data (markPrice, marketValue, unrealizedPnl) is used directly.
      if (options?.refreshImportedTickers !== false && position.assetCategory !== "OPT") {
        refreshQuote(position.ticker, position.exchange, undefined, 1);
      }
    }
  }, [dispatch, pluginRegistry.events, refreshQuote, stateRef]);

  const importBrokerPositions = useCallback(async (
    instanceId: string,
    tickerMap?: Map<string, TickerRecord>,
    options?: BrokerImportOptions,
  ) => {
    const request = {};
    syncRequests.current.set(instanceId, request);
    const report = (error: string | null) => {
      // A late read must not replace the outcome of a newer manual retry.
      if (syncRequests.current.get(instanceId) === request && !options?.signal?.aborted) {
        dispatch({ type: "SET_BROKER_SYNC_ERROR", instanceId, error });
      }
    };
    try {
      const baseConfig = options?.config ?? stateRef.current.config;
      const result = await syncBrokerInstance({
        config: baseConfig,
        instanceId,
        brokers: pluginRegistry.brokers,
        tickerRepository,
        existingTickers: tickerMap ?? new Map(stateRef.current.tickers),
        resources: pluginRegistry.persistence.resources,
        persistResolvedBrokerConfig: options?.persistResolvedBrokerConfig,
        signal: options?.signal,
        deferPersistence: true,
      });

      // A profile removed while its broker was answering stays removed, positions included.
      if (!options?.config && !getBrokerInstance(stateRef.current.config.brokerInstances, instanceId)) return result;
      let commitStarted = false;
      try {
        throwIfBrokerImportCancelled(options?.signal);
        options?.onCommitStart?.();
        commitStarted = true;
        await applyBrokerImportResult(instanceId, result, baseConfig, {
          ...options,
          callerOwnsConfig: options?.config !== undefined,
        });

        report(null);
        return result;
      } finally {
        if (commitStarted) options?.onCommitEnd?.();
      }
    } catch (error) {
      report("Positions could not be synced. Use Sync to retry.");
      throw error;
    } finally {
      if (syncRequests.current.get(instanceId) === request) syncRequests.current.delete(instanceId);
    }
  }, [applyBrokerImportResult, dispatch, pluginRegistry.brokers, pluginRegistry.persistence.resources, stateRef, tickerRepository]);

  const autoImportBrokerPositions = useCallback(async (tickerMap: Map<string, TickerRecord>) => {
    // Once per install, manual portfolios held in one other currency take it (see adoptHeldPortfolioCurrencies).
    const restoredConfig = adoptHeldPortfolioCurrencies(restoreBrokerPortfoliosFromTickerPositions(
      stateRef.current.config,
      tickerMap.values(),
      pluginRegistry.brokers,
    ), tickerMap.values());
    if (restoredConfig !== stateRef.current.config) {
      dispatch({ type: "SET_CONFIG", config: restoredConfig });
      await saveConfigImmediately(restoredConfig);
      pluginRegistry.events.emit("config:changed", { config: restoredConfig });
    }

    await syncBrokerInstances({
      config: restoredConfig,
      brokers: pluginRegistry.brokers,
      tickerRepository,
      existingTickers: tickerMap,
      resources: pluginRegistry.persistence.resources,
      deferPersistence: true,
      onResult: async (result, instance, previousConfig) => {
        if (!getBrokerInstance(stateRef.current.config.brokerInstances, instance.id)) return;
        // Startup syncs run beside the first pull: each lands on what it left.
        await applyBrokerImportResult(instance.id, result, previousConfig, {
          refreshImportedTickers: false,
        });
      },
    });
  }, [applyBrokerImportResult, dispatch, pluginRegistry.brokers, pluginRegistry.events, pluginRegistry.persistence.resources, stateRef, tickerRepository]);

  return {
    importBrokerPositions,
    autoImportBrokerPositions,
  };
}
