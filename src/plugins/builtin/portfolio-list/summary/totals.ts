import type { TickerFinancials } from "../../../../types/financials";
import type { TickerRecord } from "../../../../types/ticker";
import { convertCurrency } from "../../../../utils/format";
import { getActiveQuoteDisplay } from "../../../../market-data/market/status";
import {
  getPortfolioPositionMetrics,
  resolveBrokerFallbackMarketValue,
  resolveBrokerFallbackPnl,
} from "../position-metrics";

export interface PortfolioSummaryTotals {
  totalMktValue: number;
  netMktValue?: number;
  hasShorts?: boolean;
  unavailableSymbols?: string[];
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
  let totalPrevValue = 0;
  let totalCostBasis = 0;
  let signedDailyPnl = 0;
  let signedUnrealizedPnl = 0;
  let hasPositions = false;
  let watchlistChangeSum = 0;
  let watchlistCount = 0;
  const unavailableConversions = new Set<string>();
  const toBase = (value: number, currency: string) => {
    const converted = convertCurrency(value, currency, baseCurrency, exchangeRates);
    if (Number.isFinite(value) && !Number.isFinite(converted)) unavailableConversions.add(`${currency}/${baseCurrency}`);
    return converted;
  };

  for (const ticker of tickers) {
    const financials = financialsMap.get(ticker.metadata.ticker);
    const quote = financials?.quote;
    const activeQuote = getActiveQuoteDisplay(quote);
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
    });
    const { totalPriceUnits, grossPriceUnits, totalCost, signedCost } = positionMetrics;
    if (positionMetrics.positionCount === 0) continue;
    hasPositions = true;
    hasShorts ||= positionMetrics.hasShorts;
    totalCostBasis += totalCost;
    const brokerFallbackMktValue = resolveBrokerFallbackMarketValue(positionMetrics);
    const toBaseQuote = (value: number) => toBase(value, quoteCurrency);

    if (quote && activeQuote) {
      const previousClose = activeQuote.change != null ? activeQuote.price - activeQuote.change : Number.NaN;
      totalMktValue += toBaseQuote(grossPriceUnits * activeQuote.price);
      netMktValue += toBaseQuote(totalPriceUnits * activeQuote.price);
      totalPrevValue += toBaseQuote(grossPriceUnits * previousClose);
      signedDailyPnl += toBaseQuote(totalPriceUnits * (activeQuote.price - previousClose));
      signedUnrealizedPnl += toBaseQuote(totalPriceUnits * activeQuote.price) - signedCost;
    } else if (brokerFallbackMktValue != null) {
      totalMktValue += brokerFallbackMktValue;
      netMktValue += positionMetrics.brokerNetMktValue;
      // A broker mark is not evidence of an unchanged day.
      signedDailyPnl = Number.NaN;
      totalPrevValue = Number.NaN;
      const brokerPnl = resolveBrokerFallbackPnl(positionMetrics);
      signedUnrealizedPnl += brokerPnl ?? Number.NaN;
    } else {
      unavailableSymbols.add(ticker.metadata.ticker);
      totalMktValue = netMktValue = totalPrevValue = signedDailyPnl = signedUnrealizedPnl = Number.NaN;
    }
  }

  const dailyPnl = signedDailyPnl;
  const dailyPnlPct = totalPrevValue !== 0 ? (dailyPnl / totalPrevValue) * 100 : 0;
  const unrealizedPnl = signedUnrealizedPnl;
  const unrealizedPnlPct = totalCostBasis !== 0 ? (unrealizedPnl / totalCostBasis) * 100 : 0;
  const avgWatchlistChange = watchlistCount > 0 ? watchlistChangeSum / watchlistCount : 0;

  return {
    totalMktValue,
    netMktValue,
    hasShorts,
    ...(unavailableSymbols.size ? { unavailableSymbols: [...unavailableSymbols].sort() } : {}),
    dailyPnl,
    dailyPnlPct,
    totalCostBasis,
    hasPositions,
    unrealizedPnl,
    unrealizedPnlPct,
    avgWatchlistChange,
    watchlistCount,
    ...(unavailableConversions.size > 0 ? { unavailableConversions: [...unavailableConversions].sort() } : {}),
  };
}
