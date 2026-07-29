import type { TickerFinancials } from "../../types/financials";
import type { TickerRecord } from "../../types/ticker";
export { clipPriceHistoryToRange } from "../../time-series/history-window";
import { CHART_COMPOSER_PANE_ID, LEGACY_TICKER_DETAIL_PANE_ID } from "../../types/config";
import { parseChartSpec } from "../../plugins/builtin/chart-composer/chart-spec";
import { normalizeTickerInput } from "../../tickers/search";
import type { MarketContext } from "../types";
import { cleanTickerInput } from "./options";
import { parsePublicTickerKey, publicTickerKey } from "../../utils/exchanges";
import type { ResolvedPaneFunction } from "./resolver";

const SHOT_PRICE_HISTORY_RANGE = "5Y" as const;
const FINANCIAL_ANALYSIS_PANE_ID = "financial-analysis";
const FINANCIAL_ANALYSIS_TEMPLATE_ID = "financial-analysis-pane";

export async function fetchTickerFinancials(
  context: MarketContext,
  symbol: string,
): Promise<{
  tickerFile: TickerRecord | null;
  financials: TickerFinancials;
  instrument: { symbol: string; exchange?: string };
}> {
  const normalized = cleanTickerInput(symbol);
  const instrument = parsePublicTickerKey(normalized);
  const tickerFile = await context.store.loadTicker(normalized)
    ?? (instrument.symbol !== normalized ? await context.store.loadTicker(instrument.symbol) : null);
  const exchange = instrument.exchange ?? tickerFile?.metadata.exchange ?? "";
  const financials = await context.dataProvider.getTickerFinancials(instrument.symbol, exchange);
  return { tickerFile, financials, instrument: { symbol: instrument.symbol, ...(exchange ? { exchange } : {}) } };
}

export async function withShotPriceHistory(
  context: MarketContext,
  symbol: string,
  tickerFile: TickerRecord | null,
  financials: TickerFinancials,
): Promise<TickerFinancials> {
  if (financials.priceHistory?.length) return financials;
  const instrument = parsePublicTickerKey(symbol);
  const exchange = instrument.exchange
    ?? tickerFile?.metadata.exchange
    ?? financials.quote?.listingExchangeName
    ?? financials.quote?.exchangeName
    ?? "";
  try {
    const priceHistory = await context.dataProvider.getPriceHistory(instrument.symbol, exchange, SHOT_PRICE_HISTORY_RANGE);
    return priceHistory.length > 0 ? { ...financials, priceHistory } : financials;
  } catch {
    return financials;
  }
}

export function requireSymbol(resolved: ResolvedPaneFunction, rawArg: string): string {
  const symbol = resolved.createOptions?.symbol ?? normalizeTickerInput(null, cleanTickerInput(rawArg));
  if (!symbol) throw new Error(`Usage: gloomberb fn ${resolved.token} <symbol>`);
  return symbol;
}

export function isFinancialAnalysisFunction(resolved: ResolvedPaneFunction): boolean {
  if (resolved.pane.id === FINANCIAL_ANALYSIS_PANE_ID) return true;
  if (resolved.template?.id === FINANCIAL_ANALYSIS_TEMPLATE_ID) return true;
  return resolved.pane.id === LEGACY_TICKER_DETAIL_PANE_ID
    && resolved.instance.settings?.lockedTabId === "financials";
}

export function createFallbackTicker(symbol: string, financials: TickerFinancials | null, context: MarketContext): TickerRecord {
  const instrument = parsePublicTickerKey(symbol);
  const quote = financials?.quote;
  return {
    metadata: {
      ticker: instrument.symbol,
      exchange: instrument.exchange ?? quote?.listingExchangeName ?? quote?.exchangeName ?? "",
      currency: quote?.currency ?? context.config.baseCurrency,
      name: quote?.name ?? instrument.symbol,
      portfolios: [],
      watchlists: [],
      positions: [],
      custom: {},
      tags: [],
    },
  };
}

export function collectShotSymbols(resolved: ResolvedPaneFunction, rawArg: string): string[] {
  if (resolved.pane.id === CHART_COMPOSER_PANE_ID) {
    const spec = parseChartSpec(resolved.instance.settings?.chartSpec);
    if (spec) {
      return [...new Set(spec.series.flatMap((series) => (
        series.source.kind === "security"
          ? [publicTickerKey(series.source.instrument.symbol, series.source.instrument.exchange)]
          : []
      )).filter(Boolean))];
    }
  }
  let symbols = resolved.createOptions?.symbols?.length
    ? resolved.createOptions.symbols
    : [resolved.createOptions?.symbol ?? normalizeTickerInput(null, cleanTickerInput(rawArg))].filter((symbol): symbol is string => !!symbol);
  if (resolved.capability.id === "security-relationship" && symbols.length === 1) {
    symbols = [...symbols, "SPY"];
  }
  return [...new Set(symbols.map(cleanTickerInput).filter(Boolean))];
}
