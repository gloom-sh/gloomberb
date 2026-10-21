import type { Dispatch } from "react";
import { apiClient } from "../../../api-client";
import { t } from "../../../i18n";
import { teamCollectionLocalId } from "../../../team/collections";
import type { DataProvider } from "../../../types/data-provider";
import type { AppTickerRepositoryPort } from "../../../core/app-service-ports";
import type { PluginRegistry } from "../../../plugins/registry";
import type { AppAction, AppState } from "../../../state/app/context";
import {
  buildBrokerProfileConfig,
  validateBrokerProfileValues,
} from "../../../brokers/profile-form";
import type { SignedInBroker } from "../../../brokers/signed-in/client";
import { removeBrokerProfile } from "../../../brokers/remove-profile";
import { connectSignedInBrokerProfile } from "../../../brokers/signed-in/connect";
import {
  addTickerToPortfolio,
  adoptFirstPositionCurrency,
  LotCostFxMergeError,
  createManualPortfolio as createManualPortfolioConfig,
  deleteManualPortfolio,
  deleteWatchlist as deleteWatchlistConfig,
  hasOpenPortfolioPositions,
  isManualPortfolio,
  resolveManualPositionCurrency,
  positionQuantityLabel,
  setManualPortfolioPosition,
  validatePositionShares,
} from "../../../portfolio/mutations";
import { loadFuturesEntrySize } from "../../../portfolio/futures-terms";
import {
  FORM_COST_FX_WORDING, PositionCostFxError, readCostFxRate, readPurchaseDate, resolvePositionCostFx,
} from "../../../portfolio/cost-fx";
import { getManualPortfolioPositionPrefill } from "../../../portfolio/manual-lots";
import { resolvePortfolioTotalsCurrency } from "../../../portfolio/totals-currency";
import { createBaseConverter } from "../../../cli/base-converter";
import { heldCurrencyUnit } from "../../../utils/currency-units";
import { positionCostTermsPrefill } from "./portfolio-position";
import { wholeUnitQuantityProblem } from "../../../portfolio/position-quantity";
import type { CommandBarFieldValue } from "./types";
import type { WorkflowStringValues } from "./broker";
import { coerceFieldString } from "../helpers";
import { slugifyName } from "../../../utils/slugify";
import { readTypedNumber } from "../../../utils/decimal-comma";
import { resolveTickerInputOrThrow } from "./ops";
import { resolveCollectionTicker } from "./collection-ticker";

export type CommandBarNotifyFn = (
  body: string,
  options?: { type?: "info" | "success" | "error" },
) => void;

export interface CommandBarCollectionWorkflowActions {
  connectBrokerProfile: (brokerId: string, values: WorkflowStringValues) => Promise<void>;
  /**
   * Asks the user to connect `broker` (the form's connect step), then syncs
   * its profile. False when they backed out before it connected.
   */
  connectSignedInBroker: (broker: SignedInBroker) => Promise<boolean>;
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
  /** Shows the connect step for a signed-in broker; the app's connect dialog when missing. */
  requestBrokerSignIn?: (broker: SignedInBroker) => Promise<boolean>;
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
    requestBrokerSignIn,
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
    const freshConfig = pluginRegistry.getConfig();
    dispatch({ type: "SET_CONFIG", config: freshConfig });
    const brokerTab = freshConfig.portfolios.find((portfolio) => portfolio.brokerInstanceId === instanceId);
    if (brokerTab) setActiveCollection(brokerTab.id);
    notify(t("Connected! Positions will sync automatically."), { type: "success" });
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
      const instance = await pluginRegistry.createBrokerInstance(
        brokerId,
        adapter.name.trim(),
        brokerValues as Record<string, unknown>,
      );
      await pluginRegistry.syncBrokerInstance(instance.id);
      showConnectedBroker(instance.id);
    },

    async connectSignedInBroker(broker) {
      const connected = await connectSignedInBrokerProfile(broker, {
        getConfig: () => pluginRegistry.getConfig(),
        createBrokerInstance: (brokerType, label, values) => pluginRegistry.createBrokerInstance(brokerType, label, values),
        syncBrokerInstance: (instanceId) => pluginRegistry.syncBrokerInstance(instanceId),
        requestSignIn: requestBrokerSignIn,
      });
      if (!connected) return false;
      showConnectedBroker(connected.instance.id);
      return true;
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
      const { config: nextConfig, watchlist, tickers } = deleteWatchlistConfig(
        currentState.config,
        currentState.tickers.values(),
        watchlistId,
      );
      for (const ticker of tickers) {
        await tickerRepository.saveTicker(ticker);
        dispatch({ type: "UPDATE_TICKER", ticker });
      }

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

      const resolvedTicker = await resolveTickerInputOrThrow(
        coerceFieldString(values.ticker),
        activeTickerSymbol,
        portfolio.id,
        buildWorkflowDeps(),
      );
      const ticker = resolveCollectionTicker(resolvedTicker.ticker, getState().tickers, "portfolio", portfolio.id);

      // 18,50, 1.234,5 and 123.456 read as typed; 1,234 could be either reading and fails naming both.
      // Negative for a short; zero is no position. A future counts contracts, and the messages say so.
      const quantityLabel = positionQuantityLabel(ticker);
      const shares = readTypedNumber(coerceFieldString(values.shares), quantityLabel);
      // 1.250 on a listing held in whole lots could be 1,250 as well, and asks the same way.
      const lots = wholeUnitQuantityProblem(coerceFieldString(values.shares).trim(), ticker, { label: quantityLabel });
      if (lots) throw new Error(lots);
      const sharesError = validatePositionShares(shares, quantityLabel);
      if (sharesError) {
        throw new Error(t(sharesError));
      }

      const avgCost = readTypedNumber(coerceFieldString(values.avgCost), "Avg Cost");
      if (!Number.isFinite(avgCost)) {
        throw new Error("Avg Cost must be a valid number.");
      }

      // A future is entered in contracts, sized by its terms; a cost typed as corn is quoted counts cents.
      const size = await loadFuturesEntrySize(ticker);
      const currency = resolveManualPositionCurrency(
        coerceFieldString(values.currency),
        ticker,
        portfolio,
        currentState.config.baseCurrency,
        size?.currency,
      );
      // Purchase Date and Cost FX behave as `position set --date/--cost-fx`. A field left as it opened keeps
      // what the lots have; one emptied clears it; a new date reads that day's FX close unless a rate is typed.
      const firstPosition = !hasOpenPortfolioPositions(portfolio.id, getState().tickers.values());
      const adopted = firstPosition ? adoptFirstPositionCurrency(getState().config, portfolio.id, currency) : null;
      const valued = adopted ?? getState().config;
      const portfolioCurrency = resolvePortfolioTotalsCurrency(
        valued.portfolios.find((entry) => entry.id === portfolio.id) ?? portfolio, valued.baseCurrency);
      const opened = positionCostTermsPrefill(getManualPortfolioPositionPrefill(ticker, portfolio.id).position, portfolioCurrency);
      const dateText = coerceFieldString(values.dateAcquired).trim();
      const rateText = coerceFieldString(values.costFx).trim();
      const dateAcquired = dateText === opened.dateAcquired ? undefined : dateText ? readPurchaseDate(dateText, FORM_COST_FX_WORDING) : null;
      const typedRate = rateText && rateText !== opened.costFx ? readCostFxRate(rateText, FORM_COST_FX_WORDING) : undefined;
      const toPortfolio = createBaseConverter(dataProvider, heldCurrencyUnit(portfolioCurrency).currency);
      let result: ReturnType<typeof setManualPortfolioPosition>;
      try {
        const bought = await resolvePositionCostFx({
          date: dateAcquired ?? undefined, costFx: typedRate, history: apiClient,
          currency, portfolioCurrency, listing: ticker.metadata.ticker, wording: FORM_COST_FX_WORDING,
          // Today's rate, in the units the lot is held in: what a typed rate is checked against.
          todaysRate: async () => (await toPortfolio(1, heldCurrencyUnit(currency).currency))
            / heldCurrencyUnit(currency).divisor * heldCurrencyUnit(portfolioCurrency).divisor,
        });
        const costFx = bought ? bought.costFx : !rateText && opened.costFx ? null : undefined;
        result = setManualPortfolioPosition(ticker, portfolio.id, {
          shares,
          avgCost,
          currency,
          ...(size ? { multiplier: size.multiplier } : {}),
          ...(dateAcquired !== undefined ? { dateAcquired } : {}),
          ...(costFx !== undefined ? { costFx } : {}),
        });
      } catch (error) {
        // The form shows one message: what is wrong, then what to give instead.
        if (error instanceof PositionCostFxError && error.details) throw new Error(`${error.message} ${error.details}`);
        if (error instanceof LotCostFxMergeError) throw new Error(`${error.message} Give its Cost FX or Purchase Date.`);
        throw error;
      }
      await tickerRepository.saveTicker(result.ticker);
      dispatch({ type: "UPDATE_TICKER", ticker: result.ticker });
      if (adopted) {
        dispatch({ type: "SET_CONFIG", config: adopted });
        persistConfig(adopted);
      }
      pluginRegistry.events.emit("host:portfolio-ticker-saved", {
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

      pluginRegistry.events.emit("host:portfolio-ticker-saved", {
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
        throw new Error(t("Broker profile not found."));
      }
      const removal = await removeBrokerProfile(instance, instance.label, (id) => pluginRegistry.removeBrokerInstance(id));
      notify(removal.message, { type: removal.accountKept ? "info" : "success" });
    },
  };
}

type CollectionOwner = { kind: "user" } | { kind: "team"; teamId: string };

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
