import type { Dispatch } from "react";
import { apiClient } from "../../../api-client";
import { teamCollectionLocalId } from "../../../plugins/builtin/cloud/team/collections";
import type { DataProvider } from "../../../types/data-provider";
import type { AppTickerRepositoryPort } from "../../../core/app-service-ports";
import type { PluginRegistry } from "../../../plugins/registry";
import type { AppAction, AppState } from "../../../state/app/context";
import {
  buildBrokerProfileConfig,
  validateBrokerProfileValues,
} from "../../../brokers/profile-form";
import type { SignedInBroker } from "../../../brokers/signed-in/client";
import { connectSignedInBrokerProfile } from "../../../brokers/signed-in/connect";
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
import { resolveCollectionTicker } from "./collection-ticker";
import { disconnectSignedInProfile } from "../../../brokers/signed-in/connect";

export type CommandBarNotifyFn = (
  body: string,
  options?: { type?: "info" | "success" | "error" },
) => void;

export interface CommandBarCollectionWorkflowActions {
  connectBrokerProfile: (brokerId: string, values: WorkflowStringValues) => Promise<void>;
  /** Opens the connect dialog; rejects with what to tell the user when it is not connected. */
  connectSignedInBroker: (broker: SignedInBroker) => Promise<void>;
  createManualPortfolio: (name: string, owner?: CollectionOwner) => Promise<void>;
  createWatchlist: (name: string, owner?: CollectionOwner) => Promise<void>;
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

  /** Lands on the synced profile's portfolio once a broker is connected. */
  const showConnectedBroker = (instanceId: string) => {
    const freshConfig = pluginRegistry.getConfigFn();
    dispatch({ type: "SET_CONFIG", config: freshConfig });
    const brokerTab = freshConfig.portfolios.find((portfolio) => portfolio.brokerInstanceId === instanceId);
    if (brokerTab) setActiveCollection(brokerTab.id);
    notify("Connected! Positions will sync automatically.", { type: "success" });
  };

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
      showConnectedBroker(instance.id);
    },

    async connectSignedInBroker(broker) {
      const connected = await connectSignedInBrokerProfile(broker, {
        getConfig: () => pluginRegistry.getConfigFn(),
        createBrokerInstance: (brokerType, label, values) => pluginRegistry.createBrokerInstanceFn(brokerType, label, values),
        syncBrokerInstance: (instanceId) => pluginRegistry.syncBrokerInstanceFn(instanceId),
      });
      if (!connected) throw new Error(`${broker.name} was not connected.`);
      showConnectedBroker(connected.instance.id);
    },

    async createManualPortfolio(name, owner) {
      if (owner?.kind === "team") {
        const created = await createTeamCollectionAndWait(owner.teamId, "portfolio", name, getState().config.baseCurrency);
        setActiveCollection(created);
        notify(`Created team portfolio "${name.trim()}".`, { type: "success" });
        return;
      }
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

    async createWatchlist(name, owner) {
      const currentState = getState();
      const trimmedName = name.trim();
      if (!trimmedName) {
        throw new Error("Watchlist name is required.");
      }
      if (owner?.kind === "team") {
        const created = await createTeamCollectionAndWait(owner.teamId, "watchlist", trimmedName);
        setActiveCollection(created);
        notify(`Created team watchlist "${trimmedName}".`, { type: "success" });
        return;
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

      const rawAvgCost = coerceFieldString(values.avgCost).trim();
      const avgCost = Number(rawAvgCost);
      if (!rawAvgCost || !Number.isFinite(avgCost)) {
        throw new Error("Avg Cost must be a valid number.");
      }

      const resolvedTicker = await resolveTickerInputOrThrow(
        coerceFieldString(values.ticker),
        activeTickerSymbol,
        portfolio.id,
        buildWorkflowDeps(),
      );
      const ticker = resolveCollectionTicker(resolvedTicker.ticker, getState().tickers, "portfolio", portfolio.id);

      const currency = resolveManualPositionCurrency(
        coerceFieldString(values.currency),
        ticker,
        portfolio,
        currentState.config.baseCurrency,
      );

      const result = setManualPortfolioPosition(ticker, portfolio.id, {
        shares,
        avgCost,
        currency,
      });
      await tickerRepository.saveTicker(result.ticker);
      dispatch({ type: "UPDATE_TICKER", ticker: result.ticker });
      pluginRegistry.events.emit("command-bar:portfolio-membership-persisted", {
        symbol: result.ticker.metadata.ticker,
        portfolioId: portfolio.id,
      });
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
        portfolio.id,
        buildWorkflowDeps(),
      );
      const ticker = resolveCollectionTicker(resolvedTicker.ticker, getState().tickers, "portfolio", portfolio.id);

      const result = addTickerToPortfolio(ticker, portfolio.id);
      if (result.changed) {
        await tickerRepository.saveTicker(result.ticker);
        dispatch({ type: "UPDATE_TICKER", ticker: result.ticker });
      }

      pluginRegistry.events.emit("command-bar:portfolio-membership-persisted", {
        symbol: result.ticker.metadata.ticker,
        portfolioId: portfolio.id,
      });
      notify(
        result.changed
          ? `Added ${result.ticker.metadata.ticker} to "${portfolio.name}".`
          : `${result.ticker.metadata.ticker} is already in "${portfolio.name}".`,
        { type: result.changed ? "success" : "info" },
      );
    },

    async disconnectBrokerInstance(instanceId) {
      const instance = getState().config.brokerInstances.find((entry) => entry.id === instanceId);
      if (!instance) {
        throw new Error("Broker profile not found.");
      }
      await disconnectSignedInProfile(instance);
      await pluginRegistry.removeBrokerInstanceFn(instanceId);
      const freshConfig = pluginRegistry.getConfigFn();
      dispatch({ type: "SET_CONFIG", config: freshConfig });
      notify(`Removed ${instance.label}.`, { type: "success" });
    },
  };
}

export type CollectionOwner = { kind: "user" } | { kind: "team"; teamId: string };

/**
 * Creates the collection on the server. The collection.updated frame brings
 * it into the config; the local id is known up front so the pane can switch
 * to it as soon as that lands.
 */
async function createTeamCollectionAndWait(
  teamId: string,
  kind: "watchlist" | "portfolio",
  name: string,
  currency?: string,
): Promise<string> {
  const created = await apiClient.createTeamCollection(teamId, {
    kind,
    name: name.trim(),
    ...(kind === "portfolio" ? { currency: (currency || "USD").toUpperCase() } : {}),
  });
  return teamCollectionLocalId(teamId, created.id);
}
