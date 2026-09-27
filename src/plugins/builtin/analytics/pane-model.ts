import type { TickerFinancials, PricePoint } from "../../../types/financials";
import type { BrokerAccount } from "../../../types/trading";
import type { TickerRecord } from "../../../types/ticker";
import type { PriceHistoryIntegrity } from "../../../utils/price-history-integrity";
import { instrumentFromTicker, type ChartRequest, type TickerInstrumentOptions } from "../../../market-data/request-types";
import { buildChartKey } from "../../../market-data/selectors";
import type { ColumnContext } from "../portfolio-list/metrics";
import {
  resolveDatedReturns,
  computeWeightedPortfolioReturns,
  syntheticAccountUnsupportedReason,
  syntheticPositionUnsupportedReason,
  type DatedReturn,
  type WeightedReturnSeries,
  type ReturnHistoryResult,
} from "./metrics";
import { getPortfolioPositionValue } from "./sector-model";

export interface PortfolioChartTarget {
  ticker: TickerRecord;
  request: ChartRequest | null;
}

export type ChartEntryLookup = Map<string, {
  data?: PricePoint[] | null;
  lastGoodData?: PricePoint[] | null;
} | undefined>;

export function buildPortfolioChartTargets(
  portfolioTickers: TickerRecord[],
  options: TickerInstrumentOptions = {},
): PortfolioChartTarget[] {
  return portfolioTickers.map((ticker) => {
    const instrument = instrumentFromTicker(ticker, ticker.metadata.ticker, options);
    return {
      ticker,
      request: instrument ? {
        instrument,
        bufferRange: "1Y" as const,
        granularity: "range" as const,
      } : null,
    };
  });
}

export interface PortfolioReturnSeriesResult {
  returns: DatedReturn[] | null;
  /** Share of portfolio value whose history actually made it into the weighted series, 0..1. */
  coverage: number;
  /** Holdings dropped because their history was missing, still loading, or too short. */
  missingCount: number;
  /** Holdings with no reliable base-currency value, so weights cannot be determined. */
  unvaluedCount: number;
  unsupportedReason: string | null;
  historyIntegrity: Array<{ symbol: string; integrity: PriceHistoryIntegrity }>;
}

export function buildPortfolioReturnSeries({
  chartTargets,
  chartEntries,
  financials,
  columnContext,
  account,
}: {
  chartTargets: PortfolioChartTarget[];
  chartEntries: ChartEntryLookup;
  financials: Map<string, TickerFinancials>;
  columnContext: ColumnContext;
  account?: BrokerAccount | null;
}): PortfolioReturnSeriesResult {
  const weightedSeries: WeightedReturnSeries[] = [];
  let coveredValue = 0;
  let totalValue = 0;
  let missingCount = 0;
  let unvaluedCount = 0;
  let unsupportedReason = syntheticAccountUnsupportedReason(account);
  const historyIntegrity: PortfolioReturnSeriesResult["historyIntegrity"] = [];
  for (const { ticker, request } of chartTargets) {
    if (!request) unsupportedReason ??= `Broker contract unavailable for ${ticker.metadata.ticker}`;
    unsupportedReason ??= syntheticPositionUnsupportedReason(
      ticker,
      financials.get(ticker.metadata.ticker)?.quote?.currency || ticker.metadata.currency || columnContext.baseCurrency,
      columnContext.activeTab,
    );
    const value = getPortfolioPositionValue(ticker, financials.get(ticker.metadata.ticker), columnContext);
    if (value == null) unvaluedCount += 1;
    const weight = value == null ? 0 : Math.abs(value);
    totalValue += weight;
    if (value === 0) continue;

    const entry = request ? chartEntries.get(buildChartKey(request)) : undefined;
    const history = entry?.data ?? entry?.lastGoodData ?? null;
    const resolved = resolveDatedReturns(history ?? []);
    if (resolved.integrity) historyIntegrity.push({ symbol: ticker.metadata.ticker, integrity: resolved.integrity });
    const returns = resolved.returns;
    if (value != null) weightedSeries.push({ weight: value, returns });
    if (value == null || returns.length < 10) {
      missingCount += 1;
      continue;
    }

    coveredValue += weight;
  }

  const returns = computeWeightedPortfolioReturns(weightedSeries);
  return {
    returns: !unsupportedReason && unvaluedCount === 0 && historyIntegrity.length === 0 && returns.length > 0 ? returns : null,
    coverage: totalValue > 0 ? coveredValue / totalValue : chartTargets.length === 0 ? 1 : 0,
    missingCount,
    unvaluedCount,
    unsupportedReason,
    historyIntegrity,
  };
}

export function buildBenchmarkReturnSeries(
  request: ChartRequest,
  chartEntries: ChartEntryLookup,
): ReturnHistoryResult {
  const entry = chartEntries.get(buildChartKey(request));
  return resolveDatedReturns(entry?.data ?? entry?.lastGoodData ?? []);
}
