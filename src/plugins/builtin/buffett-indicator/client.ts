import { apiClient } from "../../../api-client";
import {
  getCachedFredSeries,
  loadCachedFredSeries,
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
  type ModeBuild,
  type ModeDef,
  type SeriesDef,
} from "./model";
import type { DatedSeries } from "./series";
import {
  datedSeriesToCachePayload,
  fredDataToDatedSeries,
  isUnsupportedFredSeries,
  loadFredGraphCsvSeries,
  loadYahooDailyIndexFromEpoch,
  yahooSymbolFor,
} from "./sources";

export type BuffettSeriesLoader = (def: SeriesDef) => Promise<DatedSeries>;

export function createBuffettSeriesLoader(deps: {
  loadCloudFred: (request: FredSeriesRequest) => Promise<DatedSeries>;
  loadYahooIndex: (symbol: string, seriesId: string) => Promise<DatedSeries>;
  loadFredCsv: (seriesId: string) => Promise<DatedSeries>;
}): BuffettSeriesLoader {
  return async (def) => {
    const yahooSymbol = yahooSymbolFor(def);
    if (yahooSymbol) return deps.loadYahooIndex(yahooSymbol, def.seriesId);
    const request = seriesRequest(def);
    try {
      return await deps.loadCloudFred(request);
    } catch (error) {
      if (!isUnsupportedFredSeries(error)) throw error;
      return deps.loadFredCsv(def.seriesId);
    }
  };
}

const defaultLoader: BuffettSeriesLoader = createBuffettSeriesLoader({
  loadCloudFred: async (request) => {
    const data = await apiClient.getCloudFredSeries(request.seriesId, {
      limit: request.limit,
      sortOrder: request.sortOrder,
    });
    return fredDataToDatedSeries(data, request.seriesId, "fred");
  },
  loadYahooIndex: loadYahooDailyIndexFromEpoch,
  loadFredCsv: loadFredGraphCsvSeries,
});

function summarizeSeriesErrors(errors: readonly string[]): string {
  if (errors.length === 0) return "Buffett Indicator data unavailable";
  const reasons = new Set(errors.map((entry) => entry.replace(/^[A-Z0-9]+:\s*/, "")));
  const reason = reasons.size === 1 ? [...reasons][0]! : `${errors.length} series failed`;
  return errors.length > 1 ? `${reason} (${errors.length} series)` : reason;
}

/** First error for this mode's series ids. */
export function errorForMode(
  errors: readonly string[],
  modeId: BuffettModeId,
): string | null {
  if (errors.length === 0) return null;
  const mode = BUFFETT_MODES[modeId];
  const relevantIds = new Set([
    mode.numerator.seriesId.trim().toUpperCase(),
    mode.denominator.seriesId.trim().toUpperCase(),
  ]);
  for (const entry of errors) {
    const seriesId = entry.split(":")[0]?.trim().toUpperCase();
    if (seriesId && relevantIds.has(seriesId)) return entry;
  }
  return null;
}

function tryBuildMode(
  mode: ModeDef,
  byId: Map<string, { data: DatedSeries; stale: boolean }>,
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
  byId: Map<string, { data: DatedSeries; stale: boolean }>,
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

function provenanceFor(def: SeriesDef): DatedSeries["provenance"] {
  switch (def.source.kind) {
    case "yahoo-index":
      return "yahoo";
    case "fred":
      return "fred";
    default: {
      const _exhaustive: never = def.source;
      return _exhaustive;
    }
  }
}

export function getCachedBuffettBundle(): BuffettBundle | null {
  const byId = new Map<string, { data: DatedSeries; stale: boolean }>();
  for (const def of uniqueSeriesDefs()) {
    const cached = getCachedFredSeries(seriesRequest(def), { allowExpired: true });
    if (cached) {
      byId.set(def.seriesId.trim().toUpperCase(), {
        data: fredDataToDatedSeries(cached.data, def.seriesId, provenanceFor(def)),
        stale: cached.stale,
      });
    }
  }
  return assembleBundle(byId, [], Date.now());
}

type SeriesLoadOk = {
  ok: true;
  def: SeriesDef;
  seriesId: string;
  data: DatedSeries;
  stale: boolean;
  refreshError?: string;
};

type SeriesLoadErr = {
  ok: false;
  def: SeriesDef;
  seriesId: string;
  error: unknown;
};

async function loadSeries(
  def: SeriesDef,
  force: boolean,
  loader: BuffettSeriesLoader,
): Promise<SeriesLoadOk | SeriesLoadErr> {
  const request = seriesRequest(def);
  try {
    const result = await loadCachedFredSeries(
      request,
      async () => datedSeriesToCachePayload(await loader(def)),
      { force },
    );
    return {
      ok: true,
      def,
      seriesId: def.seriesId,
      data: fredDataToDatedSeries(result.data, def.seriesId, provenanceFor(def)),
      stale: result.stale,
      refreshError: result.refreshError,
    };
  } catch (error) {
    return { ok: false, def, seriesId: def.seriesId, error };
  }
}

export async function loadBuffettBundle(options?: {
  force?: boolean;
  loader?: BuffettSeriesLoader;
}): Promise<BuffettBundle> {
  const force = options?.force ?? false;
  const loader = options?.loader ?? defaultLoader;
  const errors: string[] = [];
  const byId = new Map<string, { data: DatedSeries; stale: boolean }>();

  const settled = await Promise.all(
    uniqueSeriesDefs().map((def) => loadSeries(def, force, loader)),
  );

  for (const outcome of settled) {
    if (outcome.ok) {
      byId.set(outcome.seriesId.trim().toUpperCase(), {
        data: outcome.data,
        stale: outcome.stale,
      });
      if (outcome.refreshError) {
        errors.push(`${outcome.seriesId}: ${outcome.refreshError}`);
      }
      continue;
    }
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    errors.push(`${outcome.seriesId}: ${message}`);
  }

  const bundle = assembleBundle(byId, errors, Date.now());
  if (!bundle) throw new Error(summarizeSeriesErrors(errors));
  return bundle;
}
