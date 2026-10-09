import type { AppConfig } from "../../../types/config";
import type { TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import { convertCurrency } from "../../../utils/format";
import { allocationTotal, type AllocationHolding } from "../portfolio-list/allocation";
import { getCollectionTypeFromConfig } from "../portfolio-list/pane/data";
import { getPortfolioPositionMetrics, getPortfolioQuoteDisplay, resolvePortfolioMarketValue } from "../portfolio-list/position-metrics";

export function getPortfolioPositionValue({
  ticker,
  financials,
  portfolioId,
  baseCurrency,
  exchangeRates,
}: {
  ticker: TickerRecord | null;
  financials: TickerFinancials | null;
  portfolioId: string | null;
  baseCurrency: string;
  exchangeRates: Map<string, number>;
}): number {
  if (!ticker) return 0;
  const scopedTicker: TickerRecord = portfolioId
    ? {
        ...ticker,
        metadata: {
          ...ticker.metadata,
          positions: ticker.metadata.positions.filter((position) => position.portfolio === portfolioId),
        },
      }
    : ticker;
  const quote = financials?.quote;

  const quoteCurrency = quote?.currency || ticker.metadata.currency || baseCurrency;
  const metrics = getPortfolioPositionMetrics(scopedTicker, undefined, quoteCurrency, {
    currency: baseCurrency, convert: (value, currency) => convertCurrency(value, currency, baseCurrency, exchangeRates),
  }, quote);
  const activeQuote = getPortfolioQuoteDisplay(metrics, quote);

  return resolvePortfolioMarketValue(metrics, activeQuote
    ? convertCurrency(activeQuote.price, quoteCurrency, baseCurrency, exchangeRates) : null)?.gross
    ?? (metrics.positionCount > 0 ? Number.NaN : 0);
}

/**
 * What the portfolio is worth to bet with: its equity. A broker account's is
 * its Net Liq. Otherwise it is the priced holdings at net value plus the cash
 * entered for the portfolio, the portfolio header's Total. A broker portfolio
 * with neither has no known equity: its positions alone are its gross, which
 * margin puts above the equity, so it gives no bankroll.
 */
export function resolveKellyBankroll({
  netLiquidation,
  brokerPortfolio,
  holdings,
  cashValue,
}: {
  netLiquidation: number | null;
  brokerPortfolio: boolean;
  holdings: readonly AllocationHolding[];
  /** Cash entered by hand, in the bankroll currency; NaN when it cannot be converted. */
  cashValue: number | null;
}): number {
  if (netLiquidation != null && Number.isFinite(netLiquidation)) return netLiquidation;
  if (brokerPortfolio && cashValue == null) return 0;
  return allocationTotal(holdings, cashValue) ?? 0;
}

export function resolveActivePortfolioId({
  requestedPortfolioId,
  activeCollectionId,
  symbol,
  ticker,
  config,
}: {
  requestedPortfolioId?: string | null;
  activeCollectionId: string | null;
  symbol: string | null;
  ticker: TickerRecord | null;
  config: AppConfig;
}): string | null {
  if (requestedPortfolioId && config.portfolios.some((portfolio) => portfolio.id === requestedPortfolioId)) {
    return requestedPortfolioId;
  }
  if (activeCollectionId && getCollectionTypeFromConfig(config, activeCollectionId) === "portfolio") {
    return activeCollectionId;
  }
  if (ticker) {
    const positionPortfolio = ticker.metadata.positions.find((position) => position.portfolio)?.portfolio;
    if (positionPortfolio) return positionPortfolio;
    if (ticker.metadata.portfolios[0]) return ticker.metadata.portfolios[0];
  }
  return symbol ? config.portfolios[0]?.id ?? null : null;
}
