import type { AppConfig } from "../../../types/config";
import type { TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import { getActiveQuoteDisplay } from "../../../market-data/market/status";
import { convertCurrency } from "../../../utils/format";
import { getCollectionTypeFromConfig } from "../portfolio-list/pane/data";
import { getPortfolioPositionMetrics, resolveBrokerFallbackMarketValue } from "../portfolio-list/position-metrics";

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
  const activeQuote = getActiveQuoteDisplay(quote);
  const quoteCurrency = quote?.currency || ticker.metadata.currency || baseCurrency;
  const metrics = getPortfolioPositionMetrics(scopedTicker, undefined, quoteCurrency, {
    currency: baseCurrency, convert: (value, currency) => convertCurrency(value, currency, baseCurrency, exchangeRates),
  });

  if (activeQuote && metrics.grossPriceUnits !== 0) {
    return convertCurrency(metrics.grossPriceUnits * activeQuote.price, quoteCurrency, baseCurrency, exchangeRates);
  }

  const brokerFallback = resolveBrokerFallbackMarketValue(metrics);
  return brokerFallback ?? (metrics.positionCount > 0 ? Number.NaN : 0);
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
