import { apiClient } from "../../../api-client";
import { getCachedFredSeries, loadCachedFredSeries, type FredSeriesData, type FredSeriesLoadResult,
  type FredSeriesRequest } from "../../../sources/gloomberb-cloud/fred-series";
import { getSharedMarketDataCoordinator, MarketDataCoordinator, resolveEntryValue } from "../../../market-data/coordinator";
import type { ChartRequest } from "../../../market-data/request-types";
import type { QueryEntry } from "../../../market-data/result-types";
import type { DataProvider } from "../../../types/data-provider";
import type { PricePoint } from "../../../types/financials";
import { createGloomberbCloudProvider } from "../../../sources/gloomberb-cloud";
import { loadFredPoints } from "../shared/fred-points";
import { VOLATILITY_INDICES } from "../shared/volatility-indices";
import { buildVolatilityData, buildVolatilityTermHistory, IMPLIED_CORRELATION_ROWS, VOLATILITY_SERIES,
  type VolatilityData, type VolatilityHistoryInput, type VolatilityInputs,
  type VolatilitySeriesId, type VolatilitySeriesInput, type VolatilityTermHistory } from "./model";
import { abortable, abortError } from "../../../utils/async-deadline";
import { errorMessage } from "../../../utils/errors";

const VOLATILITY_LOAD_CONCURRENCY = 4;
const VOLATILITY_HISTORY_LIMIT = 400;
export interface VolatilityLoadResult {
  data: VolatilityData;
  /** The daily inputs the data was built from, so live index levels can be laid over them. */
  inputs: VolatilityInputs;
  stale: boolean;
  /** The oldest copy a failed refresh left answering, by when it was saved (ms); its failure is not in `errors`. */
  savedAt?: number;
  errors: string[];
  phase: "loading" | "partial" | "ready" | "error";
  loaded: number;
  total: number;
}
export interface VolatilityLoaderDependencies {
  loadChart(request: ChartRequest, options?: { forceRefresh?: boolean }): Promise<QueryEntry<PricePoint[]>>;
  getChartEntry?(request: ChartRequest): QueryEntry<PricePoint[]>;
  loadFred(seriesId: VolatilitySeriesId, options: { limit?: number; sortOrder?: "asc" | "desc" }): Promise<FredSeriesData>;
  /** CBOE implied correlation closes; without it those rows fall back to the index history route. */
  loadImpliedCorrelation?(): Promise<ImpliedCorrelationSeries[]>;
  now?: () => number;
}
interface ImpliedCorrelationSeries { id: string; source: string; observations: { date: string; value: number }[] }
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
  cloudApi: Pick<typeof apiClient, "getCloudFredSeries"> & Partial<Pick<typeof apiClient, "impliedVolatility">> = apiClient,
): VolatilityLoaderDependencies {
  const coordinator = marketData ? new MarketDataCoordinator(marketData) : getSharedMarketDataCoordinator();
  return {
    loadChart: (request, options) => coordinator ? coordinator.loadChart(request, options)
      : Promise.reject(new Error("Market data coordinator unavailable")),
    ...(coordinator ? { getChartEntry: (request: ChartRequest) => coordinator.getChartEntry(request) } : {}),
    loadFred: (seriesId, options) => cloudApi.getCloudFredSeries(seriesId, options),
    ...(cloudApi.impliedVolatility ? { loadImpliedCorrelation: async () =>
      (await cloudApi.impliedVolatility!<{ series: ImpliedCorrelationSeries[] }>("implied-correlation")).series } : {}),
  };
}
let standaloneDependencies: VolatilityLoaderDependencies | null = null;
/**
 * The app's shared coordinator where one runs; a report outside the app
 * (`fn G`) reads the same Cloud histories through a coordinator of its own.
 */
function termDependencies(): VolatilityLoaderDependencies {
  return getSharedMarketDataCoordinator() ? createVolatilityDependencies()
    : standaloneDependencies ??= createVolatilityDependencies(createGloomberbCloudProvider());
}

/** The first reason any of a publisher's two legs gave for failing or not refreshing. */
const legError = (legs: ReadonlyArray<{ error?: string | null } | undefined>) => legs.map((leg) => leg?.error).find(Boolean) ?? null;

/**
 * The 3M/30D ratio's history as the board builds it: the board's own VIX and
 * VIX 3M daily closes (one year, the same request and cache), FRED's
 * republished closes from `start` on the dates those lack. When Cboe's closes
 * fail FRED stands in, a day behind, and the warning says so. A ratio read
 * from closes a failed refresh left in place carries when they were saved
 * (`savedAt`), which the chart dates as every pane does; other cached closes
 * name whose. With neither publisher's pair it rejects with both reasons
 * rather than return an empty history.
 */
export async function loadVolatilityTermHistory(
  { start, signal }: { start?: Date; signal?: AbortSignal } = {},
  dependencies: VolatilityLoaderDependencies & { loadFredPoints?: typeof loadFredPoints } = termDependencies(),
): Promise<{ term: VolatilityTermHistory; warning?: string; savedAt?: number }> {
  const loadFred = dependencies.loadFredPoints ?? loadFredPoints;
  const now = dependencies.now?.() ?? Date.now();
  const history: NonNullable<VolatilityInputs["history"]> = {};
  const fred: NonNullable<VolatilityInputs["fred"]> = {};
  await abortable(Promise.all([
    ...(["vix", "vix3m"] as const).map(async (id) => {
      const { symbol } = VOLATILITY_INDICES.find((definition) => definition.id === id)!;
      try {
        history[id] = historyInput(await dependencies.loadChart(volatilityHistoryRequest(symbol)), now);
      } catch (error) {
        history[id] = { history: [], source: null, error: errorMessage(error) };
      }
    }),
    ...VOLATILITY_SERIES.map(async ({ seriesId }) => {
      try {
        const loaded = await loadFred(seriesId, start);
        fred[seriesId] = { observations: loaded.points, info: null, stale: loaded.points.length > 0 && loaded.stale,
          error: loaded.refreshError ?? null, ...(loaded.savedAt != null && loaded.points.length ? { savedAt: loaded.savedAt } : {}) };
      } catch (error) {
        fred[seriesId] = { observations: [], info: null, error: errorMessage(error) };
      }
    }),
  ]), signal, CANCELLED);
  const term = buildVolatilityTermHistory({ history, fred });
  const cboeError = legError([history.vix, history.vix3m]);
  const fredError = legError(VOLATILITY_SERIES.map(({ seriesId }) => fred[seriesId]));
  if (!term.ratioHistory.length) {
    throw new Error(`VIX 3M / VIX history unavailable: Cboe closes (${cboeError ?? "no data"}); FRED closes (${fredError ?? "no data"})`);
  }
  const notes: string[] = [];
  if (term.publisher === "FRED") {
    notes.push(`Cboe closes ${cboeError ? `unavailable (${cboeError})` : "not updated"}; showing FRED's, through ${term.termDate}.`);
  } else if (fredError && !term.ratioHistory.some((point) => point.publisher === "FRED")) {
    notes.push(`FRED closes unavailable (${fredError}); showing Cboe's from ${term.ratioHistory[0]!.date}.`);
  }
  const legs = term.publisher === "FRED" ? VOLATILITY_SERIES.map(({ seriesId }) => fred[seriesId]) : [history.vix, history.vix3m];
  const savedAt = term.stale ? oldestSavedAt(legs) : undefined;
  if (term.stale && savedAt == null) {
    const error = term.publisher === "FRED" ? fredError : cboeError;
    notes.push(error ? `Refresh failed (${error}); showing cached ${term.publisher} closes.`
      : `Showing cached ${term.publisher} closes; the source has not updated since.`);
  }
  return { term, ...(notes.length ? { warning: notes.join(" ") } : {}), ...(savedAt != null ? { savedAt } : {}) };
}

/** A CBOE daily close as a daily bar dated at the 16:15 New York settlement. */
function correlationHistory(series: ImpliedCorrelationSeries): PricePoint[] {
  return series.observations.filter((row) => Number.isFinite(row.value) && row.value > 0)
    .map((row) => ({ date: new Date(`${row.date}T20:15:00Z`), close: row.value }));
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
function fredInput(result: Pick<FredSeriesLoadResult, "data" | "stale" | "fetchedAt"> & Partial<Pick<FredSeriesLoadResult, "source">>
  & { refreshError?: string }): VolatilitySeriesInput {
  const saved = result.source === "stale-fallback" && result.data.observations.length > 0;
  return { observations: result.data.observations, info: result.data.info, fetchedAt: result.fetchedAt,
    stale: result.data.observations.length > 0 && result.stale,
    error: result.refreshError ?? (result.data.observations.length ? null : "Daily FRED observations unavailable"),
    ...(saved ? { savedAt: result.fetchedAt } : {}) };
}
/** A history a failed refresh left in place answers from the copy saved when it was fetched. */
function historyInput(entry: QueryEntry<PricePoint[]>, now: number): VolatilityHistoryInput {
  const history = resolveEntryValue(entry) ?? [];
  const saved = !!entry.error && history.length > 0 && entry.fetchedAt != null;
  return { history, source: entry.source, fetchedAt: entry.fetchedAt,
    stale: history.length > 0 && (!!entry.error || (entry.staleAt != null && entry.staleAt <= now)),
    error: entry.error?.message ?? (history.length ? null : "Daily index history unavailable"),
    ...(saved ? { savedAt: entry.fetchedAt } : {}) };
}
/** The oldest of `inputs`' saved copies, by when each was saved. */
function oldestSavedAt(inputs: ReadonlyArray<{ savedAt?: number | null } | undefined>): number | undefined {
  const saved = inputs.flatMap((input) => input?.savedAt != null ? [input.savedAt] : []);
  return saved.length ? Math.min(...saved) : undefined;
}
/** Seeds the first paint; the load that replaces each input settles its freshness, so cache age is not stale. */
function cachedInputs(dependencies: VolatilityLoaderDependencies, now: number): VolatilityInputs {
  const inputs: VolatilityInputs = { history: {}, fred: {} };
  for (const definition of VOLATILITY_INDICES) {
    const entry = dependencies.getChartEntry?.(volatilityHistoryRequest(definition.symbol));
    if (entry && resolveEntryValue(entry) != null) inputs.history![definition.id] = { ...historyInput(entry, now), stale: false, savedAt: null };
  }
  for (const { seriesId } of VOLATILITY_SERIES) {
    const cached = getCachedFredSeries(requestFor(seriesId), { allowExpired: true });
    if (cached) inputs.fred![seriesId] = fredInput({ ...cached, stale: false });
  }
  return inputs;
}
function hasValues(data: VolatilityData): boolean {
  return data.board.some((row) => row.value != null) || data.fred.metrics.some((metric) => metric.value != null);
}
/** Named like the board row; a source-routing miss reads as the missing history it is. */
function historyError(id: string, error: string): string {
  const definition = VOLATILITY_INDICES.find((entry) => entry.id === id);
  const name = definition ? `${definition.label} ${definition.symbol}` : id;
  return `${name}: ${/^No (?:resolution-aware )?history provider available/i.test(error) ? "no daily history" : error}`;
}
function project(inputs: VolatilityInputs, loaded: number, total: number, pending: boolean): VolatilityLoadResult {
  const data = buildVolatilityData(inputs);
  // A saved copy answering a failed refresh says when it was saved (`savedAt`) instead of the failure.
  const errors = [...Object.entries(inputs.history ?? {}).flatMap(([id, value]) => value.error && value.savedAt == null ? [historyError(id, value.error)] : []),
    ...Object.entries(inputs.fred ?? {}).flatMap(([id, value]) => value.error && value.savedAt == null ? [`${id}: ${value.error}`] : [])];
  const all = [...Object.values(inputs.history ?? {}), ...Object.values(inputs.fred ?? {})];
  const stale = all.some((value) => value.stale);
  const savedAt = oldestSavedAt(all);
  const phase = pending ? hasValues(data) ? "partial" : "loading" : !hasValues(data) ? "error"
    : errors.length || stale || data.warnings.length || data.board.some((row) => row.status !== "available") ? "partial" : "ready";
  return { data, inputs: { history: { ...inputs.history }, fred: { ...inputs.fred } }, stale, ...(savedAt != null ? { savedAt } : {}),
    errors, phase, loaded, total };
}
export function getCachedVolatilityData(dependencies: VolatilityLoaderDependencies = createVolatilityDependencies()): VolatilityLoadResult | null {
  const inputs = cachedInputs(dependencies, dependencies.now?.() ?? Date.now());
  const loaded = Object.keys(inputs.history ?? {}).length + Object.keys(inputs.fred ?? {}).length;
  if (loaded === 0) return null;
  return project(inputs, loaded, VOLATILITY_INDICES.length + VOLATILITY_SERIES.length, false);
}
const CANCELLED = "Volatility board load was cancelled";

/** Partial immutable projections retain cached source values beside independent refresh failures. */
export async function loadVolatilityData(
  force = false,
  dependencies: VolatilityLoaderDependencies = createVolatilityDependencies(),
  options: VolatilityLoadOptions = {},
): Promise<VolatilityLoadResult> {
  if (options.signal?.aborted) throw abortError(CANCELLED);
  const now = dependencies.now?.() ?? Date.now();
  const inputs = cachedInputs(dependencies, now);
  let loaded = 0;
  const total = VOLATILITY_INDICES.length + VOLATILITY_SERIES.length;
  const snapshot = () => project(inputs, loaded, total, loaded < total);
  const publish = () => { if (!options.signal?.aborted) options.onSnapshot?.(snapshot()); };
  // One request serves both correlation rows.
  let correlation: Promise<ImpliedCorrelationSeries[]> | undefined;
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
          fetchedAt: previous?.fetchedAt, stale: !!previous?.observations.length, error: errorMessage(error) };
      }
    }),
    ...VOLATILITY_INDICES.map((definition) => async () => {
      try {
        const cboeId = (IMPLIED_CORRELATION_ROWS as Record<string, string>)[definition.id];
        if (cboeId && dependencies.loadImpliedCorrelation) {
          correlation ??= dependencies.loadImpliedCorrelation();
          const series = (await correlation).find((entry) => entry.id === cboeId);
          const history = series ? correlationHistory(series) : [];
          inputs.history![definition.id] = { history, source: "cboe", fetchedAt: now, stale: false,
            error: history.length ? null : `${cboeId} history unavailable` };
          return;
        }
        inputs.history![definition.id] = historyInput(await dependencies.loadChart(volatilityHistoryRequest(definition.symbol),
          { forceRefresh: force }), now);
      } catch (error) {
        const previous = inputs.history![definition.id];
        inputs.history![definition.id] = { history: previous?.history ?? [], source: previous?.source ?? null,
          fetchedAt: previous?.fetchedAt, stale: !!previous?.history.length, error: errorMessage(error) };
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
  await abortable(Promise.all(Array.from({ length: Math.min(VOLATILITY_LOAD_CONCURRENCY, jobs.length) }, worker)), options.signal, CANCELLED);
  if (options.signal?.aborted) throw abortError(CANCELLED);
  return snapshot();
}
