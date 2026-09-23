import { apiClient } from "../../../api-client";
import { getSharedMarketDataCoordinator, MarketDataCoordinator, resolveEntryValue } from "../../../market-data/coordinator";
import type { ChartRequest, InstrumentRef } from "../../../market-data/request-types";
import type { QueryEntry } from "../../../market-data/result-types";
import type { DataProvider } from "../../../types/data-provider";
import type { PricePoint } from "../../../types/financials";
import { realizedVolatility, realizedVolatilityCadenceIssue } from "../shared/volatility";

export type IvMethod = "quote-mid" | "trade-close";
export type IvCoverageStatus = "ready" | "backfilling" | "queued" | "unavailable";
export interface IvPoint {
  sessionDate: string;
  method: IvMethod;
  capturedAt: string;
  spot: number | null;
  iv7: number | null;
  iv30: number | null;
  iv60: number | null;
  iv90: number | null;
  iv180: number | null;
  iv365: number | null;
  put25_30: number | null;
  call25_30: number | null;
}
export interface IvStats {
  value: number;
  date: string;
  method: IvMethod;
  rank: number | null;
  percentile: number | null;
  low: number | null;
  high: number | null;
  samples: number;
  windowStart: string | null;
}
export interface IvReading {
  date: string;
  method: IvMethod;
  capturedAt: string;
  spot: number | null;
  iv7: number | null;
  iv30: number | null;
  iv60: number | null;
  iv90: number | null;
  iv180: number | null;
  iv365: number | null;
}
export interface IvHistoryPayload {
  version: 1;
  symbol: string;
  asOf: string;
  status: IvCoverageStatus;
  coverage: { source: "seed" | "demand"; addedAt: string; backfilledThrough: string | null; since: string | null } | null;
  stats: { iv30: IvStats | null; iv90: IvStats | null };
  latest: IvReading | null;
  series: IvPoint[];
  warnings: string[];
}
export interface IvScreenRow {
  symbol: string;
  status: "ready" | "queued";
  iv30: IvStats | null;
  iv90: IvStats | null;
  latest: IvReading | null;
  skew: { date: string; put25: number; call25: number; skew: number } | null;
}
export interface IvScreenPayload { version: 1; asOf: string; rows: IvScreenRow[] }
export interface StoredSurfacePayload {
  version: 1;
  symbol: string;
  sessionDate: string;
  capturedAt: string;
  spot: number;
  surface: Record<string, unknown>;
}

export type ImpliedVolatilityApi = Pick<typeof apiClient, "impliedVolatility">;
const query = (params: Record<string, string>) => new URLSearchParams(params).toString();

export function loadIvHistory(symbol: string, options: { signal?: AbortSignal; days?: number } = {}, api: ImpliedVolatilityApi = apiClient) {
  return api.impliedVolatility<IvHistoryPayload>(`history?${query({ symbol: symbol.toUpperCase(), days: String(options.days ?? 1100) })}`,
    { signal: options.signal });
}
export function loadIvScreen(symbols: readonly string[], options: { signal?: AbortSignal } = {}, api: ImpliedVolatilityApi = apiClient) {
  return api.impliedVolatility<IvScreenPayload>(`screen?${query({ symbols: symbols.join(",") })}`, { signal: options.signal });
}
export function loadSurfaceDates(symbol: string, options: { signal?: AbortSignal } = {}, api: ImpliedVolatilityApi = apiClient) {
  return api.impliedVolatility<{ version: 1; symbol: string; dates: string[] }>(`surface-dates?${query({ symbol: symbol.toUpperCase() })}`,
    { signal: options.signal });
}
export function loadStoredSurface(symbol: string, date: string, options: { signal?: AbortSignal } = {}, api: ImpliedVolatilityApi = apiClient) {
  return api.impliedVolatility<StoredSurfacePayload>(`surface?${query({ symbol: symbol.toUpperCase(), date })}`, { signal: options.signal });
}

export interface HvDependencies {
  loadChart(request: ChartRequest, options?: { forceRefresh?: boolean }): Promise<QueryEntry<PricePoint[]>>;
}
export function createHvDependencies(marketData?: DataProvider): HvDependencies {
  const coordinator = marketData ? new MarketDataCoordinator(marketData) : getSharedMarketDataCoordinator();
  return { loadChart: (request, options) => coordinator ? coordinator.loadChart(request, options)
    : Promise.reject(new Error("Market data coordinator unavailable")) };
}

/** Close-to-close HV over one window for each symbol from one year of daily closes, four at a time. */
export async function loadRealizedVolatilities(
  instruments: readonly InstrumentRef[], window: number, options: { signal?: AbortSignal; onValue?: (symbol: string, value: number | null) => void } = {},
  dependencies: HvDependencies = createHvDependencies(),
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  let next = 0;
  const worker = async () => {
    while (next < instruments.length && !options.signal?.aborted) {
      const instrument = instruments[next++]!;
      let value: number | null = null;
      try {
        const entry = await dependencies.loadChart({ instrument, bufferRange: "1Y", granularity: "resolution", resolution: "1d" });
        const history = resolveEntryValue(entry) ?? [];
        // A provider that fell back to weekly or intraday bars would misstate daily HV.
        value = realizedVolatilityCadenceIssue(history) ? null : realizedVolatility(history, window);
      } catch { value = null; }
      result.set(instrument.symbol, value);
      options.onValue?.(instrument.symbol, value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, instruments.length) }, worker));
  return result;
}
