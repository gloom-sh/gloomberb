import { useMemo } from "react";
import { useChartQueries, useResolvedEntryValue } from "../../../market-data/hooks";
import { instrumentFromTicker, type ChartRequest } from "../../../market-data/request-types";
import { buildChartKey } from "../../../market-data/selectors";
import { getTimeRangeForDateWindow } from "../../../time-series/date-window";
import type { TimeRange } from "../../../time-series/range";
import type { PricePoint } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import { resolveOptionsTarget } from "../../../utils/options";

/**
 * The shortest range that reaches back to a contract's first daily bar. An
 * option lists months before it expires and may trade a handful of times, so
 * a stock's five years would hold one bar.
 */
function optionChartRange(points: readonly Pick<PricePoint, "date">[], now: number): TimeRange | null {
  const first = points.reduce<number | null>((oldest, point) => {
    const time = new Date(point.date).getTime();
    return Number.isFinite(time) && (oldest === null || time < oldest) ? time : oldest;
  }, null);
  if (first === null) return null;
  const range = getTimeRangeForDateWindow({ start: new Date(first), end: new Date(now) });
  // A contract that first traded today still opens on a week: one session of minute bars reads as noise.
  return range === "1D" ? "1W" : range;
}

/**
 * The range an option contract's chart opens on, from its own daily history:
 * a month until that answers, which is most of a weekly's life. Null for
 * anything that is not an option.
 */
export function useOptionChartRange(ticker: TickerRecord | null | undefined): TimeRange | null {
  const instrument = resolveOptionsTarget(ticker)?.isOptionTicker ? instrumentFromTicker(ticker) : null;
  const request: ChartRequest | null = instrument
    ? { instrument, bufferRange: "ALL", granularity: "resolution", resolution: "1d" } : null;
  const entries = useChartQueries(request ? [request] : []);
  const history = useResolvedEntryValue(request ? entries.get(buildChartKey(request)) ?? null : null);
  return useMemo(() => !request ? null : (history?.length ? optionChartRange(history, Date.now()) : null) ?? "1M", [history, !request]);
}
