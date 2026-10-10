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
import { toMarketDataContext } from "../../market-data/selectors";
import { quoteMetadataFromQuote } from "../../market-data/quotes/metadata";
import { loadSeasonalityHistory, SEASONALITY_HISTORY_RESOLUTION } from "../../plugins/builtin/seasonality/client";
import type { InstrumentRef } from "../../market-data/request-types";
import { CORRELATION_HISTORY_RESOLUTION, loadCorrelationHistory } from "../../plugins/builtin/correlation/history";
import type { TimeRange } from "../../time-series/range";
import { loadPeriodEndHistory, PERIOD_END_HISTORY_RESOLUTION } from "../../plugins/builtin/ticker-detail/financials/period-end-history";
import { latestFinancialPeriodEnd } from "../../plugins/builtin/ticker-detail/financials/model";
import { oldestRatioPeriodEnd, periodEndClose, ratioStatements } from "../../plugins/builtin/ticker-detail/financials/ratios";
import { shotFinancialPeriod } from "./financial-ratio-shot";

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
    // The app backs ticker panes with its all-history weekly baseline. A 5Y
    // window starts after the 5Y return's baseline bar and left it blank.
    const priceHistory = context.dataProvider.getPriceHistoryForResolution
      ? await context.dataProvider.getPriceHistoryForResolution(instrument.symbol, exchange, "ALL", "1wk",
        toMarketDataContext({ symbol: instrument.symbol, exchange }))
      : await context.dataProvider.getPriceHistory(instrument.symbol, exchange, SHOT_PRICE_HISTORY_RANGE);
    return priceHistory.length > 0 ? { ...financials, priceHistory } : financials;
  } catch {
    return financials;
  }
}

/**
 * SEAS reads monthly closes. Captured history answers every request, so the
 * weekly seed would stand in for them and price each month at a week's close.
 * The pane's own load fetches them, tagged so no other cadence is answered.
 */
export async function withShotSeasonalityHistory(
  context: MarketContext,
  instrument: InstrumentRef,
  financials: TickerFinancials,
): Promise<TickerFinancials> {
  const monthly = await loadSeasonalityHistory({ instrument, forceRefresh: context.refresh }, context.dataProvider);
  if (monthly.error || monthly.stale) {
    throw new Error(`${instrument.symbol}: ${monthly.error ?? "monthly price history is stale"}`);
  }
  return { ...financials, priceHistory: monthly.history, priceHistoryResolution: SEASONALITY_HISTORY_RESOLUTION };
}

/** Correlation and relationship panes read daily returns at every range. */
export function readsDailyReturns(resolved: ResolvedPaneFunction): boolean {
  return resolved.capability.id === "return-correlation" || resolved.capability.id === "security-relationship";
}

/**
 * A range capture is weekly at 5Y and monthly at ALL. Captured history answers
 * the panes' daily request, so it would turn their daily returns into weekly or
 * monthly ones.
 */
export async function withShotDailyReturns(
  context: MarketContext,
  instrument: InstrumentRef,
  exchange: string,
  range: TimeRange,
  financials: TickerFinancials,
): Promise<TickerFinancials> {
  const priceHistory = await loadCorrelationHistory(context.dataProvider, instrument.symbol, exchange, range,
    { ...toMarketDataContext(instrument), ...(context.refresh ? { cacheMode: "refresh" as const } : {}) });
  return { ...financials, priceHistory, priceHistoryResolution: CORRELATION_HISTORY_RESOLUTION };
}

/**
 * Valuation prices each column at its period-end close and accepts only daily
 * bars. Captured history answers every request, so the weekly seed stood in
 * for them and every cell read "no price". The pane's own load fetches daily
 * closes back to its oldest column, tagged so no other cadence is answered.
 */
export async function withShotPeriodEndHistory(
  context: MarketContext,
  instrument: InstrumentRef,
  exchange: string,
  resolved: ResolvedPaneFunction,
  financials: TickerFinancials,
): Promise<TickerFinancials> {
  const statements = ratioStatements(financials, shotFinancialPeriod(resolved, financials));
  const oldest = oldestRatioPeriodEnd(statements);
  // Without statements the pane shows its empty state, which the shot reports.
  if (!oldest) return financials;
  const fail = (reason: string) => new Error(`${instrument.symbol}: ${reason}`);
  const priceHistory = await loadPeriodEndHistory(context.dataProvider, instrument.symbol, exchange, oldest,
    { ...toMarketDataContext(instrument), ...(context.refresh ? { cacheMode: "refresh" as const } : {}) })
    .catch((error: unknown) => { throw fail(error instanceof Error ? error.message : String(error)); });
  const last = priceHistory.reduce((latest, point) => Math.max(latest, new Date(point.date).getTime() || -Infinity), -Infinity);
  if (!Number.isFinite(last)) throw fail("daily price history is unavailable");
  const lastClose = new Date(last).toISOString().slice(0, 10);
  const newest = latestFinancialPeriodEnd(statements)!;
  if (lastClose < newest && periodEndClose(priceHistory, newest) === undefined) {
    throw fail(`daily price history is stale: the last close is ${lastClose}, before the ${newest} period end`);
  }
  return { ...financials, priceHistory, priceHistoryResolution: PERIOD_END_HISTORY_RESOLUTION };
}

export function isFinancialAnalysisFunction(resolved: ResolvedPaneFunction): boolean {
  if (resolved.pane.id === FINANCIAL_ANALYSIS_PANE_ID) return true;
  if (resolved.template?.id === FINANCIAL_ANALYSIS_TEMPLATE_ID) return true;
  return resolved.pane.id === LEGACY_TICKER_DETAIL_PANE_ID
    && resolved.instance.settings?.lockedTabId === "financials";
}

/**
 * The ticker a shot shows for a symbol that is not saved. Without a usable
 * quote (a thin US listing after the close), the listing comes from the quote
 * metadata kept when the quote was dropped, or else from asking the source
 * for it, so the pane still knows a US stock from a listing abroad. What no
 * source knows stays empty rather than guessed from the base currency.
 */
export async function createFallbackTicker(symbol: string, financials: TickerFinancials | null, context: MarketContext): Promise<TickerRecord> {
  const instrument = parsePublicTickerKey(symbol);
  const quote = financials?.quote;
  const known = quote ? quoteMetadataFromQuote(quote) : financials?.quoteMetadata;
  const listing = instrument.exchange || known?.listingExchangeName
    ? known
    : await context.dataProvider.getQuoteMetadata?.(instrument.symbol, "").catch(() => null) ?? known;
  return {
    metadata: {
      ticker: instrument.symbol,
      exchange: instrument.exchange ?? listing?.listingExchangeName ?? "",
      currency: listing?.currency ?? "",
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
  // A text argument is a phrase, not a symbol, so it must never be looked up as one.
  const argIsTicker = resolved.template?.shortcut?.argKind !== "text";
  let symbols = resolved.createOptions?.symbols?.length
    ? resolved.createOptions.symbols
    : [
      resolved.createOptions?.symbol
        ?? (argIsTicker ? normalizeTickerInput(null, cleanTickerInput(rawArg)) : null),
    ].filter((symbol): symbol is string => !!symbol);
  if (resolved.capability.id === "security-relationship" && symbols.length === 1) {
    symbols = [...symbols, "SPY"];
  }
  // Entries a ticker list keeps as typed (CORR's GEO:HORMUZ) are not tickers to fetch.
  const keep = resolved.template?.shortcut?.keepArgToken;
  return [...new Set(symbols.filter((symbol) => !keep?.(symbol)).map(cleanTickerInput).filter(Boolean))];
}
