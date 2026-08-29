import { apiClient } from "../../../api-client";
import {
  getCachedFredSeries,
  loadCachedFredSeries,
  type FredSeriesData,
  type FredSeriesRequest,
} from "../../../data/fred-series";
import {
  BUFFETT_MODES,
  buildRatioSeries,
  fitLogLinearTrend,
  seriesRequest,
  uniqueSeriesDefs,
  type BuffettBundle,
  type BuffettModeId,
  type BuffettSeriesLoader,
  type ModeBuild,
  type ModeDef,
  type SeriesDef,
} from "./model";
import {
  isUnsupportedFredSeries,
  loadFredGraphCsvSeries,
  loadYahooDailyIndexFromEpoch,
  yahooSymbolFor,
} from "./sources";

export function createBuffettSeriesLoader(deps: {
  loadCloudFred: (request: FredSeriesRequest) => Promise<FredSeriesData>;
  loadYahooIndex: (symbol: string, seriesId: string) => Promise<FredSeriesData>;
  loadFredCsv: (seriesId: string) => Promise<FredSeriesData>;
}): BuffettSeriesLoader {
  return async (request) => {
    const yahooSymbol = yahooSymbolFor(request.seriesId);
    if (yahooSymbol) return deps.loadYahooIndex(yahooSymbol, request.seriesId);
    try {
      return await deps.loadCloudFred(request);
    } catch (error) {
      if (!isUnsupportedFredSeries(error)) throw error;
      return deps.loadFredCsv(request.seriesId);
    }
  };
}

const defaultLoader: BuffettSeriesLoader = createBuffettSeriesLoader({
  loadCloudFred: (request) =>
    apiClient.getCloudFredSeries(request.seriesId, {
      limit: request.limit,
      sortOrder: request.sortOrder,
    }),
  loadYahooIndex: loadYahooDailyIndexFromEpoch,
  loadFredCsv: loadFredGraphCsvSeries,
});

function summarizeSeriesErrors(errors: readonly string[]): string {
  if (errors.length === 0) return "Buffett Indicator data unavailable";
  const reasons = new Set(errors.map((entry) => entry.replace(/^[A-Z0-9]+:\s*/, "")));
  const reason = reasons.size === 1 ? [...reasons][0]! : `${errors.length} series failed`;
  return errors.length > 1 ? `${reason} (${errors.length} series)` : reason;
}

function tryBuildMode(
  mode: ModeDef,
  byId: Map<string, { data: FredSeriesData; stale: boolean }>,
  errors: string[],
): ModeBuild | null {
  const gdp = byId.get(mode.denominator.seriesId.trim().toUpperCase());
  if (!gdp) return null;

  const numerator = byId.get(mode.numerator.seriesId.trim().toUpperCase());
  if (!numerator) return null;

  try {
    const series = buildRatioSeries(mode, numerator.data, gdp.data, mode.numerator.seriesId);
    return {
      series,
      trend: fitLogLinearTrend(series.points),
      cacheStale: numerator.stale || gdp.stale,
    };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return null;
  }
}

function assembleBundle(
  byId: Map<string, { data: FredSeriesData; stale: boolean }>,
  errors: string[],
  fetchedAt: number,
): BuffettBundle | null {
  const modes: Partial<Record<BuffettModeId, ModeBuild>> = {};
  for (const mode of Object.values(BUFFETT_MODES)) {
    const built = tryBuildMode(mode, byId, errors);
    if (built) modes[mode.id] = built;
  }
  if (Object.keys(modes).length === 0) return null;
  return {
    modes,
    stale: Object.values(modes).some((mode) => mode!.cacheStale),
    errors,
    fetchedAt,
  };
}

export function getCachedBuffettBundle(): BuffettBundle | null {
  const byId = new Map<string, { data: FredSeriesData; stale: boolean }>();
  for (const def of uniqueSeriesDefs()) {
    const cached = getCachedFredSeries(seriesRequest(def), { allowExpired: true });
    if (cached) {
      byId.set(def.seriesId.trim().toUpperCase(), {
        data: cached.data,
        stale: cached.stale,
      });
    }
  }
  return assembleBundle(byId, [], Date.now());
}

async function loadSeries(
  request: FredSeriesRequest,
  force: boolean,
  loader: BuffettSeriesLoader,
): Promise<{ data: FredSeriesData; stale: boolean; refreshError?: string }> {
  const result = await loadCachedFredSeries(
    request,
    () => loader(request),
    { force },
  );
  return {
    data: result.data,
    stale: result.stale,
    refreshError: result.refreshError,
  };
}

export async function loadBuffettBundle(options?: {
  force?: boolean;
  loader?: BuffettSeriesLoader;
}): Promise<BuffettBundle> {
  const force = options?.force ?? false;
  const loader = options?.loader ?? defaultLoader;
  const errors: string[] = [];
  const byId = new Map<string, { data: FredSeriesData; stale: boolean }>();

  const defs = uniqueSeriesDefs();
  const settled = await Promise.allSettled(
    defs.map(async (def) => {
      const request = seriesRequest(def);
      try {
        return {
          def,
          seriesId: def.seriesId,
          result: await loadSeries(request, force, loader),
        };
      } catch (error) {
        throw { def, seriesId: def.seriesId, error };
      }
    }),
  );

  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      const { seriesId, result } = outcome.value;
      byId.set(seriesId.trim().toUpperCase(), {
        data: result.data,
        stale: result.stale,
      });
      if (result.refreshError) {
        errors.push(`${seriesId}: ${result.refreshError}`);
      }
      continue;
    }
    const reason = outcome.reason as { def: SeriesDef; seriesId: string; error: unknown };
    const message = reason.error instanceof Error ? reason.error.message : String(reason.error);
    errors.push(`${reason.seriesId}: ${message}`);
  }

  const bundle = assembleBundle(byId, errors, Date.now());
  if (!bundle) throw new Error(summarizeSeriesErrors(errors));
  return bundle;
}

export type { BuffettSeriesLoader };
