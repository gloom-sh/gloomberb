import type { TimeRange } from "../../time-series/range";
import {
  isIntradayResolution,
  normalizeChartResolutionSupport,
  type ChartResolutionSupport,
  type ManualChartResolution,
} from "../../time-series/resolution";
import { repairIsolatedIntradayOhlcOutliers } from "../../time-series/history-quality";
import type { PricePoint } from "../../types/financials";
import { normalizeSubUnitCurrency } from "./mappers";
import { getYahooSymbolsToTry } from "./symbols";
import type { ChartResult } from "./types";

const RANGE_PARAMS: Record<TimeRange, { range: string; interval: ManualChartResolution }> = {
  "1D": { range: "1d", interval: "5m" },
  "1W": { range: "5d", interval: "5m" },
  "1M": { range: "1mo", interval: "15m" },
  "3M": { range: "3mo", interval: "1h" },
  "6M": { range: "6mo", interval: "1d" },
  "1Y": { range: "1y", interval: "1d" },
  "5Y": { range: "5y", interval: "1d" },
  "ALL": { range: "max", interval: "1wk" },
};

const YAHOO_RESOLUTION_SUPPORT = normalizeChartResolutionSupport([
  { resolution: "5m", maxRange: "1W" },
  { resolution: "15m", maxRange: "1M" },
  { resolution: "1h", maxRange: "3M" },
  { resolution: "1d", maxRange: "5Y" },
  { resolution: "1wk", maxRange: "ALL" },
  { resolution: "1mo", maxRange: "ALL" },
]);

type YahooChartFetcher = (
  symbol: string,
  range: string,
  interval: ManualChartResolution,
) => Promise<{
  meta: NonNullable<ChartResult["meta"]>;
  history: PricePoint[];
  events?: ChartResult["events"];
}>;

export function getYahooChartResolutionSupport(): ChartResolutionSupport[] {
  return YAHOO_RESOLUTION_SUPPORT;
}

export function getYahooChartResolutionCapabilities(): ManualChartResolution[] {
  return YAHOO_RESOLUTION_SUPPORT.map((entry) => entry.resolution);
}

export async function loadYahooPriceHistory({
  ticker,
  exchange,
  range,
  fetchChart,
}: {
  ticker: string;
  exchange: string;
  range: TimeRange;
  fetchChart: YahooChartFetcher;
}): Promise<PricePoint[]> {
  const params = RANGE_PARAMS[range];
  return loadYahooPriceHistoryForResolution({
    ticker,
    exchange,
    chartRange: params.range,
    resolution: params.interval,
    fetchChart,
  });
}

export async function loadYahooPriceHistoryForResolution({
  ticker,
  exchange,
  bufferRange,
  chartRange,
  resolution,
  fetchChart,
}: {
  ticker: string;
  exchange: string;
  bufferRange?: TimeRange;
  chartRange?: string;
  resolution: ManualChartResolution;
  fetchChart: YahooChartFetcher;
}): Promise<PricePoint[]> {
  const effectiveChartRange = chartRange ?? RANGE_PARAMS[bufferRange ?? "1Y"].range;
  const symbolsToTry = getYahooSymbolsToTry(ticker, exchange);
  let lastError: any;

  for (const symbol of symbolsToTry) {
    try {
      const { meta, history } = await fetchChart(symbol, effectiveChartRange, resolution);

      const { divisor } = normalizeSubUnitCurrency(meta.currency || "USD");
      if (divisor !== 1) {
        for (const point of history) {
          point.close /= divisor;
          if (point.open != null) point.open /= divisor;
          if (point.high != null) point.high /= divisor;
          if (point.low != null) point.low /= divisor;
        }
      }

      return isIntradayResolution(resolution)
        ? repairIsolatedIntradayOhlcOutliers(history)
        : history;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error(`No history for ${ticker}`);
}
