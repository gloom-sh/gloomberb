import { apiClient } from "../../../api-client";
import { getCachedFredSeries, loadCachedFredSeries, type FredSeriesData, type FredSeriesLoadResult,
  type FredSeriesRequest } from "../../../data/fred-series";
import { getSharedMarketDataCoordinator, MarketDataCoordinator, resolveEntryValue } from "../../../market-data/coordinator";
import type { ChartRequest } from "../../../market-data/request-types";
import type { QueryEntry } from "../../../market-data/result-types";
import type { DataProvider } from "../../../types/data-provider";
import type { PricePoint } from "../../../types/financials";
import { buildVolatilityData, VOLATILITY_INDICES, VOLATILITY_SERIES,
  type VolatilityData, type VolatilityHistoryInput, type VolatilityInputs,
  type VolatilitySeriesId, type VolatilitySeriesInput } from "./model";

export const VOLATILITY_LOAD_CONCURRENCY = 4;
export const VOLATILITY_HISTORY_LIMIT = 400;
export interface VolatilityLoadResult {
  data: VolatilityData;
  stale: boolean;
  errors: string[];
  phase: "loading" | "partial" | "ready" | "error";
  loaded: number;
  total: number;
}
export interface VolatilityLoaderDependencies {
  loadChart(request: ChartRequest, options?: { forceRefresh?: boolean }): Promise<QueryEntry<PricePoint[]>>;
  getChartEntry?(request: ChartRequest): QueryEntry<PricePoint[]>;
  loadFred(seriesId: VolatilitySeriesId, options: { limit?: number; sortOrder?: "asc" | "desc" }): Promise<FredSeriesData>;
  now?: () => number;
}
export interface VolatilityLoadOptions {
  signal?: AbortSignal;
  onSnapshot?: (snapshot: VolatilityLoadResult) => void;
}

/** Public index symbols have no equity listing exchange attached. */
export function volatilityHistoryRequest(symbol: string): ChartRequest {
  return { instrument: { symbol, exchange: "" }, bufferRange: "1Y", granularity: "resolution", resolution: "1d" };
}
export function createVolatilityDependencies(
  marketData?: DataProvider,
  cloudApi: Pick<typeof apiClient, "getCloudFredSeries"> = apiClient,
): VolatilityLoaderDependencies {
  const coordinator = marketData ? new MarketDataCoordinator(marketData) : getSharedMarketDataCoordinator();
  return {
    loadChart: (request, options) => coordinator ? coordinator.loadChart(request, options)
      : Promise.reject(new Error("Market data coordinator unavailable")),
    ...(coordinator ? { getChartEntry: (request: ChartRequest) => coordinator.getChartEntry(request) } : {}),
    loadFred: (seriesId, options) => cloudApi.getCloudFredSeries(seriesId, options),
  };
}
function requestFor(seriesId: VolatilitySeriesId): FredSeriesRequest {
  return { seriesId, limit: VOLATILITY_HISTORY_LIMIT, sortOrder: "desc" };
}
function validateFredData(seriesId: VolatilitySeriesId, data: FredSeriesData): FredSeriesData {
  if (data.info && (data.info.id.trim().toUpperCase() !== seriesId || data.info.units.trim().toLowerCase() !== "index")) {
    throw new Error("Unexpected FRED series identity or units");
  }
  return data;
}
function fredInput(result: Pick<FredSeriesLoadResult, "data" | "stale" | "fetchedAt"> & { refreshError?: string }): VolatilitySeriesInput {
  return { observations: result.data.observations, info: result.data.info, fetchedAt: result.fetchedAt,
    stale: result.data.observations.length > 0 && result.stale,
    error: result.refreshError ?? (result.data.observations.length ? null : "Daily FRED observations unavailable") };
}
function historyInput(entry: QueryEntry<PricePoint[]>, now: number): VolatilityHistoryInput {
  const history = resolveEntryValue(entry) ?? [];
  return { history, source: entry.source, fetchedAt: entry.fetchedAt,
    stale: history.length > 0 && (!!entry.error || (entry.staleAt != null && entry.staleAt <= now)),
    error: entry.error?.message ?? (history.length ? null : "Daily index history unavailable") };
}
function cachedInputs(dependencies: VolatilityLoaderDependencies, now: number): VolatilityInputs {
  const inputs: VolatilityInputs = { history: {}, fred: {} };
  for (const definition of VOLATILITY_INDICES) {
    const entry = dependencies.getChartEntry?.(volatilityHistoryRequest(definition.symbol));
    if (entry && resolveEntryValue(entry) != null) inputs.history![definition.id] = historyInput(entry, now);
  }
  for (const { seriesId } of VOLATILITY_SERIES) {
    const cached = getCachedFredSeries(requestFor(seriesId), { allowExpired: true });
    if (cached) inputs.fred![seriesId] = fredInput(cached);
  }
  return inputs;
}
function hasValues(data: VolatilityData): boolean {
  return data.board.some((row) => row.value != null) || data.fred.metrics.some((metric) => metric.value != null);
}
function project(inputs: VolatilityInputs, loaded: number, total: number, pending: boolean): VolatilityLoadResult {
  const data = buildVolatilityData(inputs);
  const errors = [...Object.entries(inputs.history ?? {}).flatMap(([id, value]) => value.error ? [`${id}: ${value.error}`] : []),
    ...Object.entries(inputs.fred ?? {}).flatMap(([id, value]) => value.error ? [`${id}: ${value.error}`] : [])];
  const stale = [...Object.values(inputs.history ?? {}), ...Object.values(inputs.fred ?? {})].some((value) => value.stale);
  const phase = pending ? hasValues(data) ? "partial" : "loading" : !hasValues(data) ? "error"
    : errors.length || stale || data.warnings.length || data.board.some((row) => row.status !== "available") ? "partial" : "ready";
  return { data, stale, errors, phase, loaded, total };
}
export function getCachedVolatilityData(dependencies: VolatilityLoaderDependencies = createVolatilityDependencies()): VolatilityLoadResult | null {
  const inputs = cachedInputs(dependencies, dependencies.now?.() ?? Date.now());
  const loaded = Object.keys(inputs.history ?? {}).length + Object.keys(inputs.fred ?? {}).length;
  if (loaded === 0) return null;
  return project(inputs, loaded, VOLATILITY_INDICES.length + VOLATILITY_SERIES.length, false);
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function abortError(): Error { return new DOMException("Volatility board load was cancelled", "AbortError"); }
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Partial immutable projections retain cached source values beside independent refresh failures. */
export async function loadVolatilityData(
  force = false,
  dependencies: VolatilityLoaderDependencies = createVolatilityDependencies(),
  options: VolatilityLoadOptions = {},
): Promise<VolatilityLoadResult> {
  if (options.signal?.aborted) throw abortError();
  const now = dependencies.now?.() ?? Date.now();
  const inputs = cachedInputs(dependencies, now);
  let loaded = 0;
  const total = VOLATILITY_INDICES.length + VOLATILITY_SERIES.length;
  const snapshot = () => project(inputs, loaded, total, loaded < total);
  const publish = () => { if (!options.signal?.aborted) options.onSnapshot?.(snapshot()); };
  const jobs = [
    ...VOLATILITY_SERIES.map(({ seriesId }) => async () => {
      try {
        const request = requestFor(seriesId);
        const result = await loadCachedFredSeries(request,
          async () => validateFredData(seriesId, await dependencies.loadFred(seriesId, { limit: request.limit, sortOrder: request.sortOrder })), { force });
        inputs.fred![seriesId] = fredInput(result);
      } catch (error) {
        const previous = inputs.fred![seriesId];
        inputs.fred![seriesId] = { observations: previous?.observations ?? [], info: previous?.info ?? null,
          fetchedAt: previous?.fetchedAt, stale: !!previous?.observations.length, error: message(error) };
      }
    }),
    ...VOLATILITY_INDICES.map((definition) => async () => {
      try {
        inputs.history![definition.id] = historyInput(await dependencies.loadChart(volatilityHistoryRequest(definition.symbol),
          { forceRefresh: force }), now);
      } catch (error) {
        const previous = inputs.history![definition.id];
        inputs.history![definition.id] = { history: previous?.history ?? [], source: previous?.source ?? null,
          fetchedAt: previous?.fetchedAt, stale: !!previous?.history.length, error: message(error) };
      }
    }),
  ];
  publish();
  let next = 0;
  const worker = async () => {
    while (!options.signal?.aborted && next < jobs.length) {
      const job = jobs[next++]!;
      await job();
      if (options.signal?.aborted) return;
      loaded += 1;
      publish();
    }
  };
  await abortable(Promise.all(Array.from({ length: Math.min(VOLATILITY_LOAD_CONCURRENCY, jobs.length) }, worker)), options.signal);
  if (options.signal?.aborted) throw abortError();
  return snapshot();
}
