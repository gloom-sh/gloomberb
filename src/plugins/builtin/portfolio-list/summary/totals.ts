import type { TickerFinancials } from "../../../../types/financials";
import type { TickerRecord } from "../../../../types/ticker";
import { convertCurrency } from "../../../../utils/format";
import { getActiveQuoteDisplay } from "../../../../market-data/market/status";
import { isQuoteStaleForCurrentSession } from "../../../../market-data/quotes/freshness";
import {
  getPortfolioPositionMetrics,
  getPortfolioQuoteDisplay,
  resolvePortfolioMarketValue,
  resolvePortfolioPositionPnl,
  portfolioPnlPercent,
  type PortfolioPositionPnl,
} from "../position-metrics";

/** A position lot valued from a current quote, in the base currency. */
export interface PricedPortfolioLot {
  /** Stable for the lot while the positions stay as imported. */
  key: string;
  direction: 1 | -1;
  value: number;
  /** The broker's value for the lot at the last import, when it gave one. */
  brokerValue: number | null;
}

export interface PortfolioSummaryTotals {
  totalMktValue: number;
  netMktValue?: number;
  hasShorts?: boolean;
  unavailableSymbols?: string[];
  unavailableCostSymbols?: string[];
  brokerPnlSymbols?: string[];
  unrealizedPnlBasis?: PortfolioPositionPnl["basis"];
  dailyPnl: number;
  dailyPnlPct: number;
  totalCostBasis: number;
  hasPositions: boolean;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  avgWatchlistChange: number;
  watchlistCount: number;
  /** Currency pairs preventing the full portfolio from being valued. */
  unavailableConversions?: string[];
  /** Every position is valued from a current, real-time quote. */
  livePriced?: boolean;
  /** Lots with a current quote. Broker account snapshots move by these. */
  pricedLots?: PricedPortfolioLot[];
}

export function calculatePortfolioSummaryTotals(
  tickers: TickerRecord[],
  financialsMap: Map<string, TickerFinancials>,
  baseCurrency: string,
  exchangeRates: Map<string, number>,
  isPortfolio: boolean,
  collectionId: string | null,
): PortfolioSummaryTotals {
  let totalMktValue = 0;
  let netMktValue = 0;
  let hasShorts = false;
  const unavailableSymbols = new Set<string>();
  const unavailableCostSymbols = new Set<string>();
  const brokerPnlSymbols = new Set<string>();
  const pnlBases = new Set<PortfolioPositionPnl["basis"]>();
  let totalPrevValue = 0;
  let totalCostBasis = 0;
  let signedDailyPnl = 0;
  let signedUnrealizedPnl = 0;
  let hasPositions = false;
  let watchlistChangeSum = 0;
  let watchlistCount = 0;
  const unavailableConversions = new Set<string>();
  let livePriced = true;
  const pricedLots: PricedPortfolioLot[] = [];
  const now = Date.now();
  const toBase = (value: number, currency: string) => {
    const converted = convertCurrency(value, currency, baseCurrency, exchangeRates);
    if (Number.isFinite(value) && !Number.isFinite(converted)) unavailableConversions.add(`${currency}/${baseCurrency}`);
    return converted;
  };

  for (const ticker of tickers) {
    const financials = financialsMap.get(ticker.metadata.ticker);
    const quote = financials?.quote;
    const displayedQuote = getActiveQuoteDisplay(quote);
    let activeQuote = displayedQuote && Number.isFinite(displayedQuote.price) ? displayedQuote : null;
    const quoteCurrency = quote?.currency || ticker.metadata.currency || "USD";

    if (!isPortfolio) {
      if (activeQuote?.changePercent != null) {
        watchlistChangeSum += activeQuote.changePercent;
        watchlistCount++;
      }
      continue;
    }

    const positionMetrics = getPortfolioPositionMetrics(ticker, collectionId ?? undefined, quoteCurrency, {
      currency: baseCurrency, convert: toBase,
    }, quote);
    activeQuote = getPortfolioQuoteDisplay(positionMetrics, quote);
    const { totalPriceUnits, grossPriceUnits, totalCost } = positionMetrics;
    if (positionMetrics.positionCount === 0) continue;
    hasPositions = true;
    hasShorts ||= positionMetrics.hasShorts;
    totalCostBasis += totalCost;
    if (!positionMetrics.hasCostBasis) unavailableCostSymbols.add(ticker.metadata.ticker);

    const toBaseQuote = (value: number) => toBase(value, quoteCurrency);
    const positionPnl = resolvePortfolioPositionPnl(positionMetrics,
      activeQuote ? toBaseQuote(activeQuote.price) : null);
    signedUnrealizedPnl += positionPnl.value ?? Number.NaN;
    pnlBases.add(positionPnl.basis);
    if (positionPnl.basis === "broker-snapshot" || positionPnl.basis === "mixed") brokerPnlSymbols.add(ticker.metadata.ticker);

    const currentUnitPrice = activeQuote ? toBaseQuote(activeQuote.price) : null;
    const freshQuote = currentUnitPrice != null && Number.isFinite(currentUnitPrice)
      && !!quote && !isQuoteStaleForCurrentSession(quote, now);
    if (!freshQuote || quote.dataSource === "delayed" || quote.dataSource === "snapshot") livePriced = false;
    for (let index = 0; index < positionMetrics.pnlLots.length; index++) {
      const lot = positionMetrics.pnlLots[index]!;
      const value = freshQuote ? Math.abs(lot.priceUnits) * currentUnitPrice : Number.NaN;
      if (!Number.isFinite(value)) {
        livePriced = false;
        continue;
      }
      pricedLots.push({
        key: `${ticker.metadata.ticker}:${index}`,
        direction: lot.direction,
        value,
        brokerValue: lot.brokerMarketValue !== null && Number.isFinite(lot.brokerMarketValue) ? lot.brokerMarketValue : null,
      });
    }

    const marketValue = resolvePortfolioMarketValue(positionMetrics, currentUnitPrice);
    if (marketValue) {
      totalMktValue += marketValue.gross;
      netMktValue += marketValue.net;
      if (activeQuote && Number.isFinite(grossPriceUnits)) {
        const previousClose = activeQuote.change != null ? activeQuote.price - activeQuote.change : Number.NaN;
        totalPrevValue += toBaseQuote(grossPriceUnits * previousClose);
        signedDailyPnl += toBaseQuote(totalPriceUnits * (activeQuote.price - previousClose));
      } else {
        // A broker mark is not evidence of an unchanged day.
        signedDailyPnl = Number.NaN;
        totalPrevValue = Number.NaN;
      }
    } else {
      unavailableSymbols.add(ticker.metadata.ticker);
      totalMktValue = netMktValue = totalPrevValue = signedDailyPnl = Number.NaN;
    }
  }

  const dailyPnl = signedDailyPnl;
  const dailyPnlPct = totalPrevValue !== 0 ? (dailyPnl / totalPrevValue) * 100 : 0;
  const unrealizedPnl = signedUnrealizedPnl;
  const unrealizedPnlPct = portfolioPnlPercent(unrealizedPnl, totalCostBasis) ?? Number.NaN;
  const avgWatchlistChange = watchlistCount > 0 ? watchlistChangeSum / watchlistCount : 0;

  return {
    totalMktValue,
    netMktValue,
    hasShorts,
    ...(unavailableSymbols.size ? { unavailableSymbols: [...unavailableSymbols].sort() } : {}),
    ...(unavailableCostSymbols.size ? { unavailableCostSymbols: [...unavailableCostSymbols].sort() } : {}),
    ...(brokerPnlSymbols.size ? { brokerPnlSymbols: [...brokerPnlSymbols].sort() } : {}),
    unrealizedPnlBasis: !Number.isFinite(unrealizedPnl) || pnlBases.size === 0 ? "unavailable"
      : pnlBases.size > 1 ? "mixed" : [...pnlBases][0],
    dailyPnl,
    dailyPnlPct,
    totalCostBasis,
    hasPositions,
    unrealizedPnl,
    unrealizedPnlPct,
    avgWatchlistChange,
    watchlistCount,
    ...(unavailableConversions.size > 0 ? { unavailableConversions: [...unavailableConversions].sort() } : {}),
    ...(isPortfolio ? { livePriced: hasPositions && livePriced } : {}),
    ...(pricedLots.length > 0 ? { pricedLots } : {}),
  };
}
