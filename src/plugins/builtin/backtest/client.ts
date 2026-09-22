import { getSharedMarketDataCoordinator, MarketDataCoordinator, resolveEntryValue } from "../../../market-data/coordinator";
import type { ChartRequest, InstrumentRef } from "../../../market-data/request-types";
import type { QueryEntry } from "../../../market-data/result-types";
import type { DataProvider } from "../../../types/data-provider";
import type { PricePoint } from "../../../types/financials";
import type { BacktestBar } from "./rules";

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
  source: string | null;
  fetchedAt: number;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** One bar per UTC session date, ascending; later duplicates replace earlier ones. */
export function toBacktestBars(points: readonly PricePoint[]): BacktestBar[] {
  const byDate = new Map<string, BacktestBar>();
  for (const point of points) {
    const time = point.date instanceof Date ? point.date.getTime() : Date.parse(String(point.date));
    if (!Number.isFinite(time) || !finite(point.close) || point.close <= 0) continue;
    const date = new Date(time).toISOString().slice(0, 10);
    byDate.set(date, {
      date,
      open: finite(point.open) && point.open > 0 ? point.open : null,
      high: finite(point.high) && point.high > 0 ? point.high : null,
      low: finite(point.low) && point.low > 0 ? point.low : null,
      close: point.close,
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
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
  const bars = toBacktestBars(resolveEntryValue(entry) ?? []);
  if (!bars.length) throw new Error(entry.error?.message ?? "Daily price history unavailable");
  return { symbol, bars, source: entry.source ?? null, fetchedAt: entry.fetchedAt ?? Date.now() };
}
