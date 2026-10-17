import { getSharedMarketDataCoordinator, MarketDataCoordinator, resolveEntryValue } from "../../../market-data/coordinator";
import type { ChartRequest, InstrumentRef } from "../../../market-data/request-types";
import type { QueryEntry } from "../../../market-data/result-types";
import type { DataProvider } from "../../../types/data-provider";
import type { PricePoint } from "../../../types/financials";
import type { BacktestBar } from "./rules";
import { isFiniteNumber } from "../../../utils/guards";

export interface BacktestHistoryDependencies {
  loadChart(request: ChartRequest, options?: { forceRefresh?: boolean }): Promise<QueryEntry<PricePoint[]>>;
}
export function createBacktestDependencies(marketData?: DataProvider): BacktestHistoryDependencies {
  const coordinator = marketData ? new MarketDataCoordinator(marketData) : getSharedMarketDataCoordinator();
  return {
    loadChart: (request, options) => coordinator
      ? coordinator.loadChart(request, options)
      : Promise.reject(new Error("Market data coordinator unavailable")),
  };
}
export interface BacktestHistory {
  symbol: string;
  bars: BacktestBar[];
  /**
   * Sessions served without a close the test can trade through (at or below
   * zero, or missing), ascending; `undatedSkipped` counts points without a date.
   */
  skippedDates: string[];
  undatedSkipped: number;
  fetchedAt: number;
}

/**
 * One bar per UTC session date, ascending; later duplicates replace earlier
 * ones. A session served only without a positive close is skipped and named,
 * so the report can say which days the curve steps over, as is one the source
 * left out of the series for that reason (`sourceSkipped`) within the bars' span.
 */
export function toBacktestBars(
  points: readonly PricePoint[],
  sourceSkipped: readonly string[] = [],
): Pick<BacktestHistory, "bars" | "skippedDates" | "undatedSkipped"> {
  const byDate = new Map<string, BacktestBar>();
  const skipped = new Set<string>();
  let undatedSkipped = 0;
  for (const point of points) {
    const time = point.date instanceof Date ? point.date.getTime() : Date.parse(String(point.date));
    if (!Number.isFinite(time)) {
      undatedSkipped += 1;
      continue;
    }
    const date = new Date(time).toISOString().slice(0, 10);
    if (!isFiniteNumber(point.close) || point.close <= 0) {
      skipped.add(date);
      continue;
    }
    byDate.set(date, {
      date,
      open: isFiniteNumber(point.open) && point.open > 0 ? point.open : null,
      high: isFiniteNumber(point.high) && point.high > 0 ? point.high : null,
      low: isFiniteNumber(point.low) && point.low > 0 ? point.low : null,
      close: point.close,
      ...(point.partial === true ? { partial: true as const } : {}),
    });
  }
  const bars = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const first = bars[0]?.date, last = bars.at(-1)?.date;
  for (const date of sourceSkipped) if (first && last && date > first && date < last) skipped.add(date);
  return {
    bars,
    skippedDates: [...skipped].filter((date) => !byDate.has(date)).sort(),
    undatedSkipped,
  };
}

export async function loadBacktestHistory(
  instrument: InstrumentRef,
  options: { forceRefresh?: boolean; signal?: AbortSignal } = {},
  dependencies: BacktestHistoryDependencies = createBacktestDependencies(),
): Promise<BacktestHistory> {
  const symbol = instrument.symbol.trim().toUpperCase();
  const entry = await dependencies.loadChart(
    { instrument, bufferRange: "ALL", granularity: "resolution", resolution: "1d" },
    { forceRefresh: options.forceRefresh },
  );
  options.signal?.throwIfAborted();
  const history = toBacktestBars(resolveEntryValue(entry) ?? [], entry.history?.nonPositiveCloseDates);
  if (!history.bars.length) throw new Error(entry.error?.message ?? "Daily price history unavailable");
  return { symbol, ...history, fetchedAt: entry.fetchedAt ?? Date.now() };
}
