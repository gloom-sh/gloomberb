import type { TickerFinancials } from "../types/financials";
import type { TickerRecord } from "../types/ticker";
import { convertCurrency } from "../utils/format";
import { getPortfolioPositionMetrics, getPortfolioQuoteDisplay, resolvePortfolioMarketValue } from "./position-metrics";

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
