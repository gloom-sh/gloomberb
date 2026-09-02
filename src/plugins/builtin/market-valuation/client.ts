import { apiClient } from "../../../api-client";
import {
  getCachedFredSeries,
  loadCachedFredSeries,
  type FredSeriesRequest,
} from "../../../data/fred-series";
import { buildRatioSeries } from "./align";
import { seriesRequest, type IndicatorDef, type SeriesDef } from "./defs";
import { INDICATORS } from "./indicators";
import type { DatedSeries } from "./series";
import {
  datedSeriesToCachePayload,
  fredDataToDatedSeries,
  isUnsupportedFredSeries,
  loadFredGraphCsvSeries,
  loadYahooDailyIndexFromEpoch,
  provenanceFor,
  yahooSymbolFor,
} from "./sources";
import { fitLogLinearTrend } from "./trend";
import type { IndicatorBuild, ValuationBundle } from "./view";

export type ValuationSeriesLoader = (def: SeriesDef) => Promise<DatedSeries>;

interface LoadedSeries {
  data: DatedSeries;
  stale: boolean;
}

export function createValuationSeriesLoader(deps: {
  loadCloudFred: (request: FredSeriesRequest) => Promise<DatedSeries>;
  loadYahooIndex: (symbol: string, seriesId: string) => Promise<DatedSeries>;
  loadFredCsv: (seriesId: string) => Promise<DatedSeries>;
}): ValuationSeriesLoader {
  return async (def) => {
    const yahooSymbol = yahooSymbolFor(def);
    if (yahooSymbol) return deps.loadYahooIndex(yahooSymbol, def.seriesId);
    try {
      return await deps.loadCloudFred(seriesRequest(def));
    } catch (error) {
      // The cloud proxy allowlists series; fall back to FRED directly for the rest.
      if (!isUnsupportedFredSeries(error)) throw error;
      return deps.loadFredCsv(def.seriesId);
    }
  };
}

/** Exported so Bun-side tooling can hydrate the same series a renderer would fetch. */
export const defaultValuationSeriesLoader: ValuationSeriesLoader = createValuationSeriesLoader({
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

function seriesKey(seriesId: string): string {
  return seriesId.trim().toUpperCase();
}

/** Every distinct series the registry needs, so shared legs are fetched once. */
export function requiredSeries(
  indicators: readonly IndicatorDef[] = INDICATORS,
): SeriesDef[] {
  const seen = new Map<string, SeriesDef>();
  for (const indicator of indicators) {
    for (const def of [indicator.numerator, indicator.denominator]) {
      const key = seriesKey(def.seriesId);
      if (!seen.has(key)) seen.set(key, def);
    }
  }
  return [...seen.values()];
}

function buildIndicators(
  byId: Map<string, LoadedSeries>,
  errors: string[],
  indicators: readonly IndicatorDef[],
): IndicatorBuild[] {
  const builds: IndicatorBuild[] = [];
  for (const indicator of indicators) {
    const numerator = byId.get(seriesKey(indicator.numerator.seriesId));
    const denominator = byId.get(seriesKey(indicator.denominator.seriesId));
    if (!numerator || !denominator) continue;
    try {
      const series = buildRatioSeries(indicator, numerator.data, denominator.data);
      builds.push({
        indicator,
        series,
        trend: fitLogLinearTrend(series.points),
        cacheStale: numerator.stale || denominator.stale,
      });
    } catch (error) {
      errors.push(`${indicator.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return builds;
}

function summarizeErrors(errors: readonly string[]): string {
  if (errors.length === 0) return "Market valuation data unavailable";
  const reasons = new Set(errors.map((entry) => entry.replace(/^[^:]+:\s*/, "")));
  const reason = reasons.size === 1 ? [...reasons][0]! : `${errors.length} series failed`;
  return errors.length > 1 ? `${reason} (${errors.length} series)` : reason;
}

export function getCachedValuationBundle(
  indicators: readonly IndicatorDef[] = INDICATORS,
): ValuationBundle | null {
  const byId = new Map<string, LoadedSeries>();
  for (const def of requiredSeries(indicators)) {
    const cached = getCachedFredSeries(seriesRequest(def), { allowExpired: true });
    if (!cached) continue;
    byId.set(seriesKey(def.seriesId), {
      data: fredDataToDatedSeries(cached.data, def.seriesId, provenanceFor(def)),
      stale: cached.stale,
    });
  }
  const builds = buildIndicators(byId, [], indicators);
  return builds.length > 0 ? { builds, errors: [], fetchedAt: Date.now() } : null;
}

async function loadSeries(
  def: SeriesDef,
  force: boolean,
  loader: ValuationSeriesLoader,
): Promise<{ def: SeriesDef; loaded: LoadedSeries | null; error?: string }> {
  try {
    const result = await loadCachedFredSeries(
      seriesRequest(def),
      async () => datedSeriesToCachePayload(await loader(def)),
      { force },
    );
    return {
      def,
      loaded: {
        data: fredDataToDatedSeries(result.data, def.seriesId, provenanceFor(def)),
        stale: result.stale,
      },
      ...(result.refreshError ? { error: `${def.seriesId}: ${result.refreshError}` } : {}),
    };
  } catch (error) {
    return {
      def,
      loaded: null,
      error: `${def.seriesId}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function loadValuationBundle(options?: {
  force?: boolean;
  loader?: ValuationSeriesLoader;
  indicators?: readonly IndicatorDef[];
}): Promise<ValuationBundle> {
  const force = options?.force ?? false;
  const loader = options?.loader ?? defaultValuationSeriesLoader;
  const indicators = options?.indicators ?? INDICATORS;
  const errors: string[] = [];
  const byId = new Map<string, LoadedSeries>();

  const settled = await Promise.all(
    requiredSeries(indicators).map((def) => loadSeries(def, force, loader)),
  );
  for (const outcome of settled) {
    if (outcome.error) errors.push(outcome.error);
    if (outcome.loaded) byId.set(seriesKey(outcome.def.seriesId), outcome.loaded);
  }

  const builds = buildIndicators(byId, errors, indicators);
  if (builds.length === 0) throw new Error(summarizeErrors(errors));
  return { builds, errors, fetchedAt: Date.now() };
}
