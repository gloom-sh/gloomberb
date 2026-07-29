import type { Dispatch } from "react";
import type { DataProvider } from "../../../types/data-provider";
import type { AppTickerRepositoryPort } from "../../../core/app-service-ports";
import type { PluginRegistry } from "../../../plugins/registry";
import type { AppAction, AppState } from "../../../state/app/context";
import {
  buildBrokerProfileConfig,
  validateBrokerProfileValues,
} from "../../../brokers/profile-form";
import {
  addTickerToPortfolio,
  createManualPortfolio as createManualPortfolioConfig,
  deleteManualPortfolio,
  isManualPortfolio,
  resolveManualPositionCurrency,
  setManualPortfolioPosition,
} from "../../../plugins/builtin/portfolio-list/mutations";
import type { CommandBarFieldValue } from "./types";
import type { WorkflowStringValues } from "./broker";
import { coerceFieldString, slugifyName } from "../helpers";
import { resolveTickerInputOrThrow } from "./ops";

export type CommandBarNotifyFn = (
  body: string,
  options?: { type?: "info" | "success" | "error" },
) => void;

export interface CommandBarCollectionWorkflowActions {
  connectBrokerProfile: (brokerId: string, values: WorkflowStringValues) => Promise<void>;
  createManualPortfolio: (name: string) => Promise<void>;
  createWatchlist: (name: string) => Promise<void>;
  deletePortfolio: (portfolioId: string) => Promise<void>;
  deleteWatchlist: (watchlistId: string) => Promise<void>;
  disconnectBrokerInstance: (instanceId: string) => Promise<void>;
  setPortfolioPositionFromWorkflow: (values: Record<string, CommandBarFieldValue>) => Promise<void>;
  addTickerMembershipFromWorkflow: (values: Record<string, CommandBarFieldValue>) => Promise<void>;
}

export function createCommandBarCollectionWorkflowActions(options: {
  activeCollectionId: string | null;
  activeTickerSymbol: string | null;
  dataProvider: DataProvider;
  dispatch: Dispatch<AppAction>;
  getState: () => AppState;
  notify: CommandBarNotifyFn;
  persistConfig: (nextConfig: AppState["config"]) => void;
  pluginRegistry: PluginRegistry;
  setActiveCollection: (collectionId: string) => void;
  tickerRepository: AppTickerRepositoryPort;
}): CommandBarCollectionWorkflowActions {
  const {
    activeCollectionId,
    activeTickerSymbol,
    dataProvider,
    dispatch,
    getState,
    notify,
    persistConfig,
    pluginRegistry,
    setActiveCollection,
    tickerRepository,
  } = options;

  const buildWorkflowDeps = () => ({
    dataProvider,
    tickerRepository,
    pluginRegistry,
    dispatch,
    getState,
  });

  return {
    async connectBrokerProfile(brokerId, values) {
      const adapter = pluginRegistry.brokers.get(brokerId);
      if (!adapter) {
        throw new Error(`Unknown broker "${brokerId}".`);
      }

      const validationError = validateBrokerProfileValues(adapter, values);
      if (validationError) throw new Error(validationError);

      const brokerValues = buildBrokerProfileConfig(adapter, values);
      const instance = await pluginRegistry.createBrokerInstanceFn(
        brokerId,
        adapter.name.trim(),
        brokerValues as Record<string, unknown>,
      );
      await pluginRegistry.syncBrokerInstanceFn(instance.id);
      const freshConfig = pluginRegistry.getConfigFn();
      dispatch({ type: "SET_CONFIG", config: freshConfig });
      const brokerTab = freshConfig.portfolios.find((portfolio) => portfolio.brokerInstanceId === instance.id);
      if (brokerTab) setActiveCollection(brokerTab.id);
      notify("Connected! Positions will sync automatically.", { type: "success" });
    },

    async createManualPortfolio(name) {
      const currentState = getState();
      const { config: nextConfig, portfolio } = createManualPortfolioConfig(
        currentState.config,
        name,
        currentState.config.baseCurrency,
      );
      dispatch({ type: "SET_CONFIG", config: nextConfig });
      setActiveCollection(portfolio.id);
      persistConfig(nextConfig);
      notify(`Created portfolio "${portfolio.name}".`, { type: "success" });
    },

    async createWatchlist(name) {
      const currentState = getState();
      const trimmedName = name.trim();
      if (!trimmedName) {
        throw new Error("Watchlist name is required.");
      }

      const id = slugifyName(trimmedName, "watchlist");
      const newWatchlist = { id, name: trimmedName };
      const nextConfig = {
        ...currentState.config,
        watchlists: [...currentState.config.watchlists, newWatchlist],
      };
      dispatch({ type: "SET_CONFIG", config: nextConfig });
      setActiveCollection(id);
      persistConfig(nextConfig);
      notify(`Created watchlist "${trimmedName}".`, { type: "success" });
    },

    async deleteWatchlist(watchlistId) {
      const currentState = getState();
      const watchlist = currentState.config.watchlists.find((entry) => entry.id === watchlistId);
      if (!watchlist) {
        throw new Error("Watchlist not found.");
      }

      const nextConfig = {
        ...currentState.config,
        watchlists: currentState.config.watchlists.filter((entry) => entry.id !== watchlistId),
      };
      dispatch({ type: "SET_CONFIG", config: nextConfig });
      if (activeCollectionId === watchlistId) {
        const fallback = nextConfig.portfolios[0]?.id || nextConfig.watchlists[0]?.id || "";
        if (fallback) setActiveCollection(fallback);
      }
      persistConfig(nextConfig);
      notify(`Deleted "${watchlist.name}".`, { type: "success" });
    },

    async deletePortfolio(portfolioId) {
      const currentState = getState();
      const portfolio = currentState.config.portfolios.find((entry) => entry.id === portfolioId);
      if (!portfolio) {
        throw new Error("Portfolio not found.");
      }
      if (!isManualPortfolio(portfolio)) {
        throw new Error("Broker-managed portfolios cannot be deleted here.");
      }

      const result = deleteManualPortfolio(
        currentState.config,
        [...currentState.tickers.values()],
        portfolioId,
      );
      for (const ticker of result.tickers) {
        await tickerRepository.saveTicker(ticker);
        dispatch({ type: "UPDATE_TICKER", ticker });
      }

      const nextConfig = result.config;
      dispatch({ type: "SET_CONFIG", config: nextConfig });
      if (activeCollectionId === portfolioId) {
        const fallback = nextConfig.portfolios[0]?.id || nextConfig.watchlists[0]?.id || "";
        if (fallback) setActiveCollection(fallback);
      }
      persistConfig(nextConfig);
      notify(`Deleted "${portfolio.name}".`, { type: "success" });
    },

    async setPortfolioPositionFromWorkflow(values) {
      const currentState = getState();
      const portfolioId = coerceFieldString(values.portfolioId).trim();
      const portfolio = currentState.config.portfolios.find((entry) => entry.id === portfolioId);
      if (!portfolio || !isManualPortfolio(portfolio)) {
        throw new Error("Choose a manual portfolio.");
      }

      const shares = Number(coerceFieldString(values.shares));
      if (!Number.isFinite(shares) || shares <= 0) {
        throw new Error("Shares must be greater than 0.");
      }

      const avgCost = Number(coerceFieldString(values.avgCost));
      if (!Number.isFinite(avgCost)) {
        throw new Error("Avg Cost must be a valid number.");
      }

      const resolvedTicker = await resolveTickerInputOrThrow(
        coerceFieldString(values.ticker),
        activeTickerSymbol,
        activeCollectionId,
        buildWorkflowDeps(),
      );

      const currency = resolveManualPositionCurrency(
        coerceFieldString(values.currency),
        resolvedTicker.ticker,
        portfolio,
        currentState.config.baseCurrency,
      );

      const result = setManualPortfolioPosition(resolvedTicker.ticker, portfolio.id, {
        shares,
        avgCost,
        currency,
      });
      await tickerRepository.saveTicker(result.ticker);
      dispatch({ type: "UPDATE_TICKER", ticker: result.ticker });
      notify(`Set position for ${result.ticker.metadata.ticker} in "${portfolio.name}".`, { type: "success" });
    },

    async addTickerMembershipFromWorkflow(values) {
      const currentState = getState();
      const portfolioId = coerceFieldString(values.portfolioId).trim();
      const portfolio = currentState.config.portfolios.find((entry) => entry.id === portfolioId);
      if (!portfolio || !isManualPortfolio(portfolio)) {
        throw new Error("Choose a manual portfolio.");
      }

      const resolvedTicker = await resolveTickerInputOrThrow(
        coerceFieldString(values.ticker),
        activeTickerSymbol,
        activeCollectionId,
        buildWorkflowDeps(),
      );

      const result = addTickerToPortfolio(resolvedTicker.ticker, portfolio.id);
      if (result.changed) {
        await tickerRepository.saveTicker(result.ticker);
        dispatch({ type: "UPDATE_TICKER", ticker: result.ticker });
        notify(`Added ${result.ticker.metadata.ticker} to "${portfolio.name}".`, { type: "success" });
        return;
      }

      notify(`${result.ticker.metadata.ticker} is already in "${portfolio.name}".`, { type: "info" });
    },

    async disconnectBrokerInstance(instanceId) {
      const instance = getState().config.brokerInstances.find((entry) => entry.id === instanceId);
      if (!instance) {
        throw new Error("Broker profile not found.");
      }
      await pluginRegistry.removeBrokerInstanceFn(instanceId);
      const freshConfig = pluginRegistry.getConfigFn();
      dispatch({ type: "SET_CONFIG", config: freshConfig });
      notify(`Removed ${instance.label}.`, { type: "success" });
    },
  };
}
