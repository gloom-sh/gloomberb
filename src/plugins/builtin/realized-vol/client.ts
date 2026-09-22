import { getSharedMarketDataCoordinator, MarketDataCoordinator, resolveEntryValue } from "../../../market-data/coordinator";
import type { ChartRequest, InstrumentRef } from "../../../market-data/request-types";
import type { QueryEntry } from "../../../market-data/result-types";
import type { DataProvider } from "../../../types/data-provider";
import type { PricePoint } from "../../../types/financials";
import { createSurfaceDependencies, loadVolatilitySurface, type SurfaceLoaderDependencies } from "../vol-surface/client";
import { projectCurrentAtmIv, type CurrentAtmIvSnapshot } from "./model";

export interface RealizedVolatilityDependencies {
  loadChart(request: ChartRequest, options?: { forceRefresh?: boolean }): Promise<QueryEntry<PricePoint[]>>;
  now?: () => number;
}

export function createRealizedVolatilityDependencies(marketData?: DataProvider): RealizedVolatilityDependencies {
  const coordinator = marketData ? new MarketDataCoordinator(marketData) : getSharedMarketDataCoordinator();
  return { loadChart: (request, options) => coordinator
    ? coordinator.loadChart(request, options)
    : Promise.reject(new Error("Market data coordinator unavailable")) };
}

export interface RealizedHistoryRequest {
  instrument: InstrumentRef;
  signal?: AbortSignal;
  forceRefresh?: boolean;
}

export interface RealizedHistorySnapshot {
  symbol: string;
  /** Complete daily buffer. Projection owns warmup and visible lookback clipping. */
  history: PricePoint[];
  source: string | null;
  stale: boolean;
  error: string | null;
  fetchedAt: number;
}

function abortError(): Error { return new DOMException("Volatility history load was cancelled", "AbortError"); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Cancels this consumer without aborting another pane's shared coordinator request. */
async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function loadRealizedVolatilityHistory(
  request: RealizedHistoryRequest,
  dependencies: RealizedVolatilityDependencies = createRealizedVolatilityDependencies(),
): Promise<RealizedHistorySnapshot> {
  if (request.signal?.aborted) throw abortError();
  const now = dependencies.now?.() ?? Date.now();
  const symbol = request.instrument.symbol.trim().toUpperCase();
  try {
    // 5Y supplies a 2Y cone plus 260-session warmup; range-only 5Y can be weekly.
    const entry = await abortable(dependencies.loadChart({ instrument: request.instrument,
      bufferRange: "5Y", granularity: "resolution", resolution: "1d" }, { forceRefresh: request.forceRefresh }), request.signal);
    if (request.signal?.aborted) throw abortError();
    const history = resolveEntryValue(entry) ?? [];
    return { symbol, history, source: entry.source,
      stale: !!entry.error || (entry.staleAt != null && entry.staleAt <= now),
      error: entry.error?.message ?? (history.length === 0 ? "Daily price history unavailable" : null),
      fetchedAt: entry.fetchedAt ?? now };
  } catch (error) {
    if (request.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError();
    return { symbol, history: [], source: null, stale: false, error: message(error), fetchedAt: now };
  }
}

export interface CurrentAtmIvRequest extends RealizedHistoryRequest {
  spot: number;
  spotAsOf?: string | number | null;
}

/** Options are independent of daily history and use the existing surface chain cache. */
export async function loadCurrentAtmIv(
  request: CurrentAtmIvRequest,
  dependencies: SurfaceLoaderDependencies = createSurfaceDependencies(),
): Promise<CurrentAtmIvSnapshot> {
  if (request.signal?.aborted) throw abortError();
  if (!(request.spot > 0) || !Number.isFinite(request.spot)) {
    return { reference: null, error: "Current ATM IV needs a valid underlying quote", warnings: [] };
  }
  try {
    return projectCurrentAtmIv(await loadVolatilitySurface(request, dependencies));
  } catch (error) {
    if (request.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError();
    return { reference: null, error: message(error), warnings: [] };
  }
}
