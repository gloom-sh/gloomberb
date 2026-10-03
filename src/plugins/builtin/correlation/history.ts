import type { AssetDataProvider, MarketDataRequestContext } from "../../../types/data-provider";
import type { TimeRange } from "../../../time-series/range";
import type { ManualChartResolution } from "../../../time-series/resolution";
import { clipPriceHistoryToRange } from "../../../time-series/history-window";

/** Risk views need daily closes even when a chart preset defaults to intraday or weekly bars. */
export const CORRELATION_HISTORY_RESOLUTION: ManualChartResolution = "1d";

export async function loadCorrelationHistory(
  provider: AssetDataProvider, symbol: string, exchange: string, range: TimeRange,
  context?: MarketDataRequestContext,
) {
  const points = provider.getPriceHistoryForResolution
    ? await provider.getPriceHistoryForResolution(symbol, exchange, range, CORRELATION_HISTORY_RESOLUTION, context)
    : await provider.getPriceHistory(symbol, exchange, range, context);
  return clipPriceHistoryToRange(points, range);
}

export const CORRELATION_RETURN_BASIS = "Local-price close-to-close returns between shared UTC dates; cash distributions and FX conversion are excluded, and exchange closing times may differ.";
