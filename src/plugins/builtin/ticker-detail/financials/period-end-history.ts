import type { TimeRange } from "../../../../time-series/range";
import type { ManualChartResolution } from "../../../../time-series/resolution";
import type { AssetDataProvider, MarketDataRequestContext } from "../../../../types/data-provider";
import type { PricePoint } from "../../../../types/financials";

const DAY_MS = 86_400_000;
/** The cadence valuation reads, and so the cadence a screenshot captures. */
export const PERIOD_END_HISTORY_RESOLUTION: ManualChartResolution = "1d";

/** The shortest range whose history still reaches the oldest period end. */
function historyRange(oldestPeriodEnd: string, now: number): TimeRange {
  const ageDays = (now - Date.parse(`${oldestPeriodEnd}T00:00:00Z`)) / DAY_MS;
  if (ageDays < 170) return "6M";
  if (ageDays < 350) return "1Y";
  return ageDays < 1_800 ? "5Y" : "ALL";
}

/**
 * A weekly or monthly bar is dated by its first session but closes on its
 * last, which can fall after the period end. Only daily bars price a date.
 */
function requireDaily(points: PricePoint[]): PricePoint[] {
  const days = points.map((point) => Math.floor(new Date(point.date).getTime() / DAY_MS)).filter(Number.isFinite).sort((a, b) => a - b);
  const gaps = days.slice(1).map((day, index) => day - days[index]!).sort((a, b) => a - b);
  if (gaps.length > 0 && gaps[Math.floor(gaps.length / 2)]! > 3) throw new Error("Daily closes are unavailable");
  return points;
}

/** Daily closes back to the oldest period end, for valuation at each period's close. */
export async function loadPeriodEndHistory(
  provider: AssetDataProvider,
  symbol: string,
  exchange: string,
  oldestPeriodEnd: string,
  context?: MarketDataRequestContext,
  now = Date.now(),
): Promise<PricePoint[]> {
  const range = historyRange(oldestPeriodEnd, now);
  if (provider.getPriceHistoryForResolutionWithMetadata) {
    return requireDaily((await provider.getPriceHistoryForResolutionWithMetadata(symbol, exchange, range, PERIOD_END_HISTORY_RESOLUTION, context)).points);
  }
  if (provider.getPriceHistoryForResolution) return requireDaily(await provider.getPriceHistoryForResolution(symbol, exchange, range, PERIOD_END_HISTORY_RESOLUTION, context));
  return requireDaily(await provider.getPriceHistory(symbol, exchange, range, context));
}
