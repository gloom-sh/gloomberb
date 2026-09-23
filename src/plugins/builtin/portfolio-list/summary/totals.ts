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
  /**
   * How far current quotes have moved the positions they price away from the
   * broker's own snapshot values for those lots, in the base currency. Gross
   * applies to market value; net (signed by side) to P&L and net liquidation.
   */
  brokerSnapshotDelta?: { gross: number; net: number };
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
  let snapshotDeltaGross = 0;
  let snapshotDeltaNet = 0;
  let hasSnapshotDelta = false;
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
    for (const lot of positionMetrics.pnlLots) {
      const current = freshQuote ? Math.abs(lot.priceUnits) * currentUnitPrice : Number.NaN;
      if (!Number.isFinite(current)) {
        livePriced = false;
        continue;
      }
      if (lot.brokerMarketValue === null || !Number.isFinite(lot.brokerMarketValue)) continue;
      snapshotDeltaGross += current - lot.brokerMarketValue;
      snapshotDeltaNet += lot.direction * (current - lot.brokerMarketValue);
      hasSnapshotDelta = true;
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
    ...(hasSnapshotDelta && Number.isFinite(snapshotDeltaGross) && Number.isFinite(snapshotDeltaNet)
      ? { brokerSnapshotDelta: { gross: snapshotDeltaGross, net: snapshotDeltaNet } }
      : {}),
  };
}
