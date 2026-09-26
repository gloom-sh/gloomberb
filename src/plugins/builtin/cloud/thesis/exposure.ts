import { useMemo } from "react";
import { useFxRatesMap } from "../../../../market-data/hooks";
import { buildPortfolioFinancialsMap } from "../../../../market-data/portfolio-financials";
import { useAppSelector, usePaneAppConfig } from "../../../../state/app/context";
import { useLiveTickerFinancialsMap } from "../../../../state/hooks/live-ticker-financials";
import type { TickerRecord } from "../../../../types/ticker";
import { getPortfolioPositionValue } from "../../kelly-sizer/portfolio";
import { calculatePortfolioSummaryTotals } from "../../portfolio-list/metrics";
import { buildTrackedCurrencies, getCollectionTickersFromConfig, getCollectionTypeFromConfig } from "../../portfolio-list/pane/data";
import type { SymbolExposure } from "./model";

const NO_INSTRUMENT_OPTIONS = {};

function holdsOptions(ticker: TickerRecord): boolean {
  if (ticker.metadata.assetCategory === "OPT") return true;
  if (ticker.metadata.broker_contracts?.some((contract) => contract.secType === "OPT")) return true;
  return ticker.metadata.positions.some((position) => (position.multiplier ?? 1) !== 1);
}

export interface BookScope {
  /** `null` is the whole book across every portfolio. */
  collectionId: string | null;
  kind: "all" | "portfolio" | "watchlist";
  label: string;
}

export interface BookExposure {
  scope: BookScope;
  bySymbol: Map<string, SymbolExposure>;
  /** Gross market value of the positions in scope, base currency. */
  bookValue: number;
  baseCurrency: string;
  /** Tickers in scope: held ones for the book or a portfolio, listed ones for a watchlist. */
  tickers: TickerRecord[];
  nameOf: (symbol: string) => string | null;
  /** Every scope the board can switch to, the whole book first. */
  scopes: BookScope[];
}

/**
 * Market value of every symbol in scope, in the base currency, the same way
 * the portfolio pane totals them. Theses match positions by symbol, so this
 * is the only portfolio data they need. A watchlist scope has no values,
 * only membership.
 */
export function useBookExposure(collectionId: string | null): BookExposure {
  const tickersBySymbol = useAppSelector((state) => state.tickers);
  const cachedFinancials = useAppSelector((state) => state.financials);
  // Not the whole config: every pane-state change rewrites its layout mirror.
  const config = usePaneAppConfig();
  const baseCurrency = config.baseCurrency;
  const scopes = useMemo<BookScope[]>(() => [
    { collectionId: null, kind: "all", label: "All portfolios" },
    ...config.portfolios.map((portfolio): BookScope => ({ collectionId: portfolio.id, kind: "portfolio", label: portfolio.name })),
    ...config.watchlists.map((watchlist): BookScope => ({ collectionId: watchlist.id, kind: "watchlist", label: watchlist.name })),
  ], [config.portfolios, config.watchlists]);
  const scope = scopes.find((entry) => entry.collectionId === collectionId) ?? scopes[0]!;
  const portfolioId = scope.kind === "portfolio" ? scope.collectionId : null;
  const tickers = useMemo(() => {
    if (scope.kind === "all") {
      return [...tickersBySymbol.values()].filter((ticker) => ticker.metadata.positions.some((position) => position.shares !== 0));
    }
    const members = getCollectionTickersFromConfig(config, tickersBySymbol, scope.collectionId);
    return scope.kind === "portfolio"
      ? members.filter((ticker) => ticker.metadata.positions.some((position) => position.portfolio === portfolioId && position.shares !== 0))
      : members;
  }, [config, portfolioId, scope.collectionId, scope.kind, tickersBySymbol]);
  const instrumentOptions = useMemo(() => (portfolioId ? { portfolioId } : NO_INSTRUMENT_OPTIONS), [portfolioId]);
  // Values are compact currency totals, so the positions stream in the
  // background and merge with the portfolio pane's subscription.
  const liveFinancials = useLiveTickerFinancialsMap(tickers, {
    enabled: scope.kind !== "watchlist",
    surface: "portfolio",
    visible: false,
    weight: 20,
    instrumentOptions,
  });
  const financials = useMemo(
    () => buildPortfolioFinancialsMap(tickers, cachedFinancials, liveFinancials, instrumentOptions),
    [cachedFinancials, instrumentOptions, liveFinancials, tickers],
  );
  const trackedCurrencies = useMemo(
    () => buildTrackedCurrencies(tickers, financials, null, baseCurrency),
    [baseCurrency, financials, tickers],
  );
  const exchangeRates = useFxRatesMap(trackedCurrencies);
  return useMemo(() => {
    const priced = scope.kind !== "watchlist";
    const totals = priced
      ? calculatePortfolioSummaryTotals(tickers, financials, baseCurrency, exchangeRates, true, portfolioId)
      : null;
    const bySymbol = new Map<string, SymbolExposure>();
    for (const ticker of tickers) {
      const symbol = ticker.metadata.ticker.toUpperCase();
      const value = priced
        ? getPortfolioPositionValue({
          ticker,
          financials: financials.get(ticker.metadata.ticker) ?? null,
          portfolioId,
          baseCurrency,
          exchangeRates,
        })
        : 0;
      const options = holdsOptions(ticker);
      const spot = financials.get(ticker.metadata.ticker)?.quote?.price;
      const optionNotional = options && spot
        ? ticker.metadata.positions
          .filter((position) => !portfolioId || position.portfolio === portfolioId)
          .reduce((total, position) => total + Math.abs(position.shares) * (position.multiplier ?? 1) * spot, 0)
        : 0;
      bySymbol.set(symbol, { symbol, value, optionNotional, hasOptions: options });
    }
    return {
      scope,
      bySymbol,
      bookValue: totals?.totalMktValue ?? 0,
      baseCurrency,
      tickers,
      nameOf: (symbol: string) => {
        const name = tickersBySymbol.get(symbol)?.metadata.name ?? tickersBySymbol.get(symbol.toUpperCase())?.metadata.name;
        return name && name !== symbol ? name : null;
      },
      scopes,
    };
  }, [baseCurrency, exchangeRates, financials, portfolioId, scope, scopes, tickers, tickersBySymbol]);
}
