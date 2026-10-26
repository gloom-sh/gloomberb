import type { AssetDataProvider, MarketDataRequestContext } from "../../../types/data-provider";
import type { TimeRange } from "../../../time-series/range";
import type { ManualChartResolution } from "../../../time-series/resolution";
import { clipPriceHistoryToRange } from "../../../time-series/history-window";
import { DAY_SO_FAR_TEXT } from "../../../time-series/session-bar";
import type { PricePoint } from "../../../types/financials";
import type { HeadlessPaneFreshness } from "../../../types/headless";

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

/**
 * What an analysis of daily closes says when its newest day is a bar the source
 * has not finished: a coin's UTC day or a future's session under way
 * (`partial`), or a future's last trade before its settlement (`unsettled`).
 * That day is no close, so the line calls the bars daily bars and says so, as
 * `history` does, instead of dating a close by it. Nothing when `day` (the
 * newest date the analysis uses) is a finished bar in every history.
 */
export function unfinishedBarFreshness(
  histories: ReadonlyArray<ReadonlyArray<Pick<PricePoint, "date" | "partial" | "unsettled">> | undefined>,
  day: string | null | undefined,
): Pick<HeadlessPaneFreshness, "basis" | "note"> | null {
  if (!day) return null;
  const bars = histories.flatMap((history) => history?.filter((point) => new Date(point.date).toISOString().slice(0, 10) === day) ?? []);
  if (bars.some((bar) => bar.partial)) return { basis: "daily bars", note: `the newest bar is ${DAY_SO_FAR_TEXT}` };
  if (bars.some((bar) => bar.unsettled)) return { basis: "daily bars", note: "the newest bar is not yet settled" };
  return null;
}

export const CORRELATION_RETURN_BASIS = "Local-price close-to-close returns between shared UTC dates; cash distributions and FX conversion are excluded, and exchange closing times may differ.";

export const GEO_CORRELATION_CHANGE_BASIS = "Map series (GEO:) use the change in daily value between the same shared UTC dates, because counts such as transits can be zero.";
