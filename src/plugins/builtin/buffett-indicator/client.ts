import { apiClient } from "../../../api-client";
import {
  getCachedFredSeries,
  loadCachedFredSeries,
  type FredSeriesData,
  type FredSeriesRequest,
} from "../../../data/fred-series";
import {
  BUFFETT_MODES,
  WILSHIRE_NUMERATOR,
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

const defaultLoader: BuffettSeriesLoader = (request) =>
  apiClient.getCloudFredSeries(request.seriesId, {
    limit: request.limit,
    sortOrder: request.sortOrder,
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

  const primaryId = mode.numerator.seriesId.trim().toUpperCase();
  const fallbackId = mode.numerator.fallbackSeriesId?.trim().toUpperCase();
  const primary = byId.get(primaryId);
  const fallback = fallbackId ? byId.get(fallbackId) : undefined;
  const numerator = primary ?? fallback;
  if (!numerator) return null;

  const resolvedNumeratorId = primary
    ? mode.numerator.seriesId
    : mode.numerator.fallbackSeriesId!;

  try {
    const series = buildRatioSeries(mode, numerator.data, gdp.data, resolvedNumeratorId);
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
    if (def.fallbackSeriesId) {
      const fallbackReq = seriesRequest(def, def.fallbackSeriesId);
      const fallbackCached = getCachedFredSeries(fallbackReq, { allowExpired: true });
      if (fallbackCached) {
        byId.set(def.fallbackSeriesId.trim().toUpperCase(), {
          data: fallbackCached.data,
          stale: fallbackCached.stale,
        });
      }
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

    // Wilshire primary only: retry the fallback id with the same limit/sort.
    if (
      reason.def.seriesId === WILSHIRE_NUMERATOR.seriesId
      && reason.def.fallbackSeriesId
    ) {
      try {
        const fallbackReq = seriesRequest(reason.def, reason.def.fallbackSeriesId);
        const result = await loadSeries(fallbackReq, force, loader);
        byId.set(reason.def.fallbackSeriesId.trim().toUpperCase(), {
          data: result.data,
          stale: result.stale,
        });
        if (result.refreshError) {
          errors.push(`${reason.def.fallbackSeriesId}: ${result.refreshError}`);
        }
      } catch (fallbackError) {
        errors.push(
          `${reason.def.fallbackSeriesId}: ${
            fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
          }`,
        );
      }
    }
  }

  const bundle = assembleBundle(byId, errors, Date.now());
  if (!bundle) throw new Error(summarizeSeriesErrors(errors));
  return bundle;
}

export type { BuffettSeriesLoader };
