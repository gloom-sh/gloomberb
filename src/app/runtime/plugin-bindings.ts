import { logFailure } from "../../utils/log-failure";
import type { Dispatch } from "react";
import {
  clearPersistedBrokerAccounts,
  getBrokerAccountCacheSourceKey,
} from "../../brokers/account-cache";
import { accountsShownFor, clearLeftoverBrokerHoldings, findPortfolioHeir, knownBrokerHoldings } from "../../brokers/broker-portfolio-sync";
import type { AppTickerRepositoryPort } from "../../core/app-service-ports";
import type { MarketDataCoordinator } from "../../market-data/coordinator";
import { instrumentFromTicker } from "../../market-data/request-types";
import type { PluginRegistry } from "../../plugins/registry";
import { saveConfigImmediately } from "../../state/config-save-scheduler";
import { persistTickerCleanup } from "../../state/ticker-cleanup";
import { hasPendingTickerWrites } from "../../data/ticker-writes";
import { settleWithin } from "../../utils/async-deadline";
import type { AppAction, AppState } from "../../state/app/context";
import type { AppConfig, BrokerInstanceConfig } from "../../types/config";
import type { DataProvider } from "../../types/data-provider";
import type { TickerRecord } from "../../types/ticker";
import {
  createBrokerInstanceId,
  getBrokerInstance,
} from "../../utils/broker-instances";

/** How long removing a profile waits for its adapter to disconnect before going on without it. */
const ADAPTER_DISCONNECT_WAIT_MS = 5_000;

export function bindPluginRegistryRuntimeAccess({
  dataProvider,
  dispatch,
  importBrokerPositions,
  marketData,
  pluginRegistry,
  stateRef,
  tickerRepository,
}: {
  dataProvider: DataProvider;
  dispatch: Dispatch<AppAction>;
  importBrokerPositions: (instanceId: string) => Promise<unknown>;
  marketData: MarketDataCoordinator;
  pluginRegistry: PluginRegistry;
  stateRef: { current: AppState };
  tickerRepository: AppTickerRepositoryPort;
}) {
  const configurableProvider = dataProvider as DataProvider & {
    setConfigAccessor?: (accessor: () => AppConfig) => void;
  };
  if (typeof configurableProvider.setConfigAccessor === "function") {
    configurableProvider.setConfigAccessor(() => stateRef.current.config);
  }

  const setPluginConfigValues = async (pluginId: string, values: Record<string, unknown>) => {
    const currentConfig = stateRef.current.config;
    const nextConfig = {
      ...currentConfig,
      pluginConfig: {
        ...currentConfig.pluginConfig,
        [pluginId]: {
          ...(currentConfig.pluginConfig[pluginId] ?? {}),
          ...values,
        },
      },
    };
    dispatch({ type: "SET_CONFIG", config: nextConfig });
    await saveConfigImmediately(nextConfig);
    pluginRegistry.events.emit("config:changed", { config: nextConfig });
  };

  pluginRegistry.bindHost({
    getTicker: (symbol) => stateRef.current.tickers.get(symbol) ?? null,
    getData: (symbol) => {
      const ticker = stateRef.current.tickers.get(symbol) ?? null;
      const instrument = instrumentFromTicker(ticker, symbol);
      return instrument ? marketData.getTickerFinancialsSync(instrument) : null;
    },
    getConfig: () => stateRef.current.config,
    getPaneRuntimeState: (paneId) => stateRef.current.paneState[paneId] ?? null,
    updatePaneRuntimeState: (paneId, patch) => {
      dispatch({ type: "UPDATE_PANE_STATE", paneId, patch });
    },

    setPluginConfigValue: async (pluginId, key, value) => {
      await setPluginConfigValues(pluginId, { [key]: value });
    },
    setPluginConfigValues,
    deletePluginConfigValue: async (pluginId, key) => {
      const currentConfig = stateRef.current.config;
      const currentPluginConfig = currentConfig.pluginConfig[pluginId];
      if (!currentPluginConfig || !(key in currentPluginConfig)) return;

      const nextPluginConfig = { ...currentPluginConfig };
      delete nextPluginConfig[key];

      const nextAllPluginConfig = { ...currentConfig.pluginConfig };
      if (Object.keys(nextPluginConfig).length === 0) {
        delete nextAllPluginConfig[pluginId];
      } else {
        nextAllPluginConfig[pluginId] = nextPluginConfig;
      }

      const nextConfig = {
        ...currentConfig,
        pluginConfig: nextAllPluginConfig,
      };
      dispatch({ type: "SET_CONFIG", config: nextConfig });
      await saveConfigImmediately(nextConfig);
      pluginRegistry.events.emit("config:changed", { config: nextConfig });
    },

    createBrokerInstance: async (brokerType, label, values, options = {}) => {
      const instanceId = createBrokerInstanceId(
        brokerType,
        label,
        stateRef.current.config.brokerInstances.map((instance) => instance.id),
      );
      const instance: BrokerInstanceConfig = {
        id: instanceId,
        brokerType,
        label,
        connectionMode: typeof values.connectionMode === "string" ? values.connectionMode : undefined,
        config: values,
        enabled: true,
        ...(options.localOnly ? { localOnly: true } : {}),
      };
      const nextConfig = {
        ...stateRef.current.config,
        brokerInstances: [...stateRef.current.config.brokerInstances, instance],
      };
      dispatch({ type: "SET_CONFIG", config: nextConfig });
      await saveConfigImmediately(nextConfig);
      pluginRegistry.events.emit("config:changed", { config: nextConfig });
      return instance;
    },

    connectBrokerInstance: async (instanceId) => {
      const instance = getBrokerInstance(stateRef.current.config.brokerInstances, instanceId);
      if (!instance) throw new Error("Broker profile not found.");
      if (instance.enabled === false) throw new Error(`Broker profile "${instance.label}" is disabled.`);

      const broker = pluginRegistry.brokers.get(instance.brokerType);
      if (!broker) throw new Error(`Broker "${instance.brokerType}" is not available.`);

      const valid = await broker.validate(instance).catch(logFailure("app.runtime.plugin-bindings", "Broker setup validation failed", false));
      if (!valid) throw new Error(`${broker.name} setup is incomplete.`);

      await broker.connect?.(instance);
      if (broker.listAccounts) {
        const accounts = accountsShownFor(stateRef.current.config, instance, await broker.listAccounts(instance));
        dispatch({ type: "SET_BROKER_ACCOUNTS", instanceId, accounts });
      }
    },

    updateBrokerInstance: async (instanceId, values, options = {}) => {
      const currentInstance = stateRef.current.config.brokerInstances.find((instance) => instance.id === instanceId);
      const nextInstances = stateRef.current.config.brokerInstances.map((instance) =>
        instance.id === instanceId
          ? (() => {
            const nextValues = options.replaceConfig ? values : { ...instance.config, ...values };
            const { localOnly: wasLocalOnly, ...rest } = instance;
            const localOnly = options.localOnly ?? wasLocalOnly === true;
            return {
              ...rest,
              label: options.label ?? instance.label,
              enabled: options.enabled ?? instance.enabled,
              connectionMode: typeof nextValues.connectionMode === "string" ? nextValues.connectionMode : instance.connectionMode,
              config: nextValues,
              ...(localOnly ? { localOnly: true } : {}),
            };
          })()
          : instance,
      );
      const nextInstance = nextInstances.find((instance) => instance.id === instanceId);
      const broker = currentInstance ? pluginRegistry.brokers.get(currentInstance.brokerType) : null;
      const shouldClearBrokerAccounts = currentInstance
        && nextInstance
        && currentInstance.brokerType === nextInstance.brokerType
        && getBrokerAccountCacheSourceKey(currentInstance, broker) !== getBrokerAccountCacheSourceKey(nextInstance, broker);
      if (shouldClearBrokerAccounts) {
        clearPersistedBrokerAccounts(pluginRegistry.persistence.resources, currentInstance);
      }
      const nextConfig = {
        ...stateRef.current.config,
        brokerInstances: nextInstances,
      };
      dispatch({ type: "SET_CONFIG", config: nextConfig });
      await saveConfigImmediately(nextConfig);
      pluginRegistry.events.emit("config:changed", { config: nextConfig });
    },

    syncBrokerInstance: async (instanceId) => {
      await importBrokerPositions(instanceId);
    },

    removeBrokerInstance: async (instanceId) => {
      const instance = getBrokerInstance(stateRef.current.config.brokerInstances, instanceId);
      if (!instance) return;

      clearPersistedBrokerAccounts(pluginRegistry.persistence.resources, instance);

      // Best effort: an adapter that throws, rejects or never answers (a desktop
      // call to a busy Bun process) must not keep the profile.
      const broker = pluginRegistry.brokers.get(instance.brokerType);
      await settleWithin(Promise.resolve().then(() => broker?.disconnect?.(instance)), ADAPTER_DISCONNECT_WAIT_MS);

      // A portfolio another profile of the account can keep (the account switched
      // to or from sign-in) goes to that profile; only this profile's positions go.
      const syncsAccount = (candidate: BrokerInstanceConfig, accountId: string) =>
        (stateRef.current.brokerAccounts[candidate.id] ?? []).some((account) => account.accountId === accountId)
        || [...stateRef.current.tickers.values()].some((ticker) => ticker.metadata.positions.some((position) =>
          position.brokerInstanceId === candidate.id && position.brokerAccountId === accountId));
      const heirs = new Map<string, string>();
      const removedPortfolioIds = new Set<string>();
      for (const portfolio of stateRef.current.config.portfolios) {
        if (portfolio.brokerInstanceId !== instanceId) continue;
        const heir = findPortfolioHeir(stateRef.current.config, instance, portfolio, pluginRegistry.brokers, syncsAccount);
        if (heir) heirs.set(portfolio.id, heir.id);
        else removedPortfolioIds.add(portfolio.id);
      }

      const removeProfile = (config: AppConfig): AppConfig => ({
        ...config,
        brokerInstances: config.brokerInstances.filter((entry) => entry.id !== instanceId),
        portfolios: config.portfolios.flatMap((portfolio) => {
          if (removedPortfolioIds.has(portfolio.id)) return [];
          const heirId = heirs.get(portfolio.id);
          return [heirId ? { ...portfolio, brokerInstanceId: heirId } : portfolio];
        }),
      });

      const cleanTickers = () => persistTickerCleanup({
        tickerRepository,
        getTickers: () => stateRef.current.tickers,
        transform: (ticker) => {
          // A position without a profile came from another device's sync of this one.
          const nextPositions = ticker.metadata.positions.filter((position) => position.brokerInstanceId !== instanceId
            && !(removedPortfolioIds.has(position.portfolio) && !position.brokerInstanceId));
          const heldPortfolioIds = new Set(nextPositions.map((position) => position.portfolio));
          const nextPortfolioRefs = ticker.metadata.portfolios.filter((portfolioId) =>
            !removedPortfolioIds.has(portfolioId) && (!heirs.has(portfolioId) || heldPortfolioIds.has(portfolioId)));
          const nextBrokerContracts = (ticker.metadata.broker_contracts ?? []).filter((contract) => contract.brokerInstanceId !== instanceId);
          const changed = nextPositions.length !== ticker.metadata.positions.length
            || nextPortfolioRefs.length !== ticker.metadata.portfolios.length
            || nextBrokerContracts.length !== (ticker.metadata.broker_contracts ?? []).length;
          const removedTicker: TickerRecord = changed ? {
            ...ticker,
            metadata: {
              ...ticker.metadata,
              positions: nextPositions,
              portfolios: nextPortfolioRefs,
              broker_contracts: nextBrokerContracts,
            },
          } : ticker;
          // Also clear holdings left behind by older removals or pulls.
          const known = knownBrokerHoldings(removeProfile(stateRef.current.config));
          const nextTicker = clearLeftoverBrokerHoldings(removedTicker, known) ?? removedTicker;
          if (nextTicker === ticker) return ticker;
          const empty = nextTicker.metadata.positions.length === 0
            && nextTicker.metadata.portfolios.length === 0
            && nextTicker.metadata.watchlists.length === 0
            && (nextTicker.metadata.broker_contracts ?? []).length === 0
            && nextTicker.metadata.tags.length === 0
            && Object.keys(nextTicker.metadata.custom).length === 0;
          return empty ? null : nextTicker;
        },
        publish: (symbol, ticker) => {
          if (ticker) dispatch({ type: "UPDATE_TICKER", ticker });
          else {
            dispatch({ type: "REMOVE_TICKER", symbol });
            pluginRegistry.events.emit("ticker:removed", { symbol });
          }
        },
      });

      // Keep the profile available for retry until cleanup and config both
      // succeed. Rebase after callbacks and edits, including during config saves.
      let savedRemoval = false;
      for (;;) {
        const cleaned = await cleanTickers().catch(async (error: unknown) => {
          // A config acknowledgement can precede a late row write. If that
          // cleanup fails, keep its removal intent durable for a restart too.
          if (savedRemoval) await saveConfigImmediately(stateRef.current.config);
          throw error;
        });
        if (hasPendingTickerWrites(tickerRepository) || stateRef.current.tickers !== cleaned) continue;
        const source = stateRef.current.config;
        const nextConfig = removeProfile(source);
        await saveConfigImmediately(nextConfig);
        savedRemoval = true;
        if (stateRef.current.config !== source || stateRef.current.tickers !== cleaned
          || hasPendingTickerWrites(tickerRepository)) continue;
        dispatch({ type: "SET_CONFIG", config: nextConfig });
        pluginRegistry.events.emit("config:changed", { config: nextConfig });
        break;
      }
      // The profile that kept a portfolio fills in what the removed one held there.
      for (const heirId of new Set(heirs.values())) {
        void importBrokerPositions(heirId).catch(logFailure("app.runtime.plugin-bindings", "Replacement broker positions import failed"));
      }
    },
  });
}
