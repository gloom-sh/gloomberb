import { useCallback, type Dispatch } from "react";
import {
  rebaseBrokerSyncConfig,
  restoreBrokerPortfoliosFromTickerPositions,
  syncBrokerInstance,
  syncBrokerInstances,
} from "../../brokers/sync-broker-instance";
import type { SyncBrokerInstanceResult } from "../../brokers/sync-broker-instance";
import type { AppTickerRepositoryPort } from "../../core/app-service-ports";
import type { PluginRegistry } from "../../plugins/registry";
import { saveConfigImmediately } from "../../state/config-save-scheduler";
import type { AppAction, AppState } from "../../state/app/context";
import type { AppConfig } from "../../types/config";
import type { TickerRecord } from "../../types/ticker";
import { getBrokerInstance } from "../../utils/broker-instances";

export interface AppBrokerImportRuntime {
  importBrokerPositions: (
    instanceId: string,
    tickerMap?: Map<string, TickerRecord>,
    options?: BrokerImportOptions,
  ) => Promise<SyncBrokerInstanceResult>;
  autoImportBrokerPositions: (tickerMap: Map<string, TickerRecord>) => Promise<void>;
}

export interface BrokerImportOptions {
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
    dispatch({ type: "SET_BROKER_ACCOUNTS", instanceId, accounts: result.brokerAccounts });

    const liveConfig = stateRef.current.config;
    const nextConfig = options?.callerOwnsConfig
      ? (result.config !== baseConfig ? result.config : liveConfig)
      : rebaseBrokerSyncConfig(liveConfig, baseConfig, result.config, instanceId);
    if (nextConfig !== liveConfig) {
      throwIfBrokerImportCancelled(options?.signal);
      dispatch({ type: "SET_CONFIG", config: nextConfig });
      await saveConfigImmediately(nextConfig);
      throwIfBrokerImportCancelled(options?.signal);
      pluginRegistry.events.emit("config:changed", { config: nextConfig });
    }

    for (const ticker of result.addedTickers) {
      throwIfBrokerImportCancelled(options?.signal);
      pluginRegistry.events.emit("ticker:added", { symbol: ticker.metadata.ticker, ticker });
    }
    for (const ticker of [...result.addedTickers, ...result.updatedTickers]) {
      throwIfBrokerImportCancelled(options?.signal);
      dispatch({ type: "UPDATE_TICKER", ticker: { ...ticker } });
    }

    for (const position of result.positions) {
      throwIfBrokerImportCancelled(options?.signal);
      // Skip Yahoo Finance for broker option symbols; position marks are already available.
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
      await result.commit();
      throwIfBrokerImportCancelled(options?.signal);
      await applyBrokerImportResult(instanceId, result, baseConfig, {
        ...options,
        callerOwnsConfig: options?.config !== undefined,
      });

      return result;
    } finally {
      if (commitStarted) options?.onCommitEnd?.();
    }
  }, [applyBrokerImportResult, pluginRegistry.brokers, pluginRegistry.persistence.resources, stateRef, tickerRepository]);

  const autoImportBrokerPositions = useCallback(async (tickerMap: Map<string, TickerRecord>) => {
    const restoredConfig = restoreBrokerPortfoliosFromTickerPositions(
      stateRef.current.config,
      tickerMap.values(),
      pluginRegistry.brokers,
    );
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
        await result.commit();
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
