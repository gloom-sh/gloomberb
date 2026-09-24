import { buildValuationSeries } from "./align";
import { getCachedSeries, loadCachedSeriesEntry } from "./cache";
import { indicatorUnavailableReason, indicatorSeries, type IndicatorDef, type SeriesDef } from "./defs";
import { INDICATORS } from "./indicators";
import { validateObservationDates, type DatedSeries, type ValuationSourceMetadata } from "./series";
import {
  cloudSourceDeps,
  createSourceLoader,
  provenanceFor,
  type ValuationSourceDeps,
} from "./sources";
import { fitIndicatorTrend } from "./trend";
import type { IndicatorBuild, ValuationBundle } from "./view";

export type ValuationSeriesLoader = (def: SeriesDef, options?: { force?: boolean }) => Promise<DatedSeries>;

/** Every distinct leg the registry needs, so shared series are fetched once. */
export function requiredSeries(
  indicators: readonly IndicatorDef[] = INDICATORS,
): SeriesDef[] {
  const seen = new Map<string, SeriesDef>();
  for (const indicator of indicators) {
    if (indicatorUnavailableReason(indicator)) continue;
    for (const def of indicatorSeries(indicator)) {
      if (!seen.has(def.key)) seen.set(def.key, def);
    }
  }
  return [...seen.values()];
}

/** Cache-first around the cloud sources; exported so Bun-side tooling can reuse it. */
export function createValuationSeriesLoader(deps: ValuationSourceDeps): ValuationSeriesLoader {
  const cloudLoader = createSourceLoader(deps);
  return async (def, options) => {
    if (def.unavailableReason) throw new Error(def.unavailableReason);
    return {
      seriesId: def.key,
      ...await loadCachedSeriesEntry(def.key, async () => {
        const { observations, provider } = await cloudLoader(def);
        validateObservationDates(observations);
        return { observations, ...(provider ? { provider } : {}) };
      }, options),
      provenance: provenanceFor(def),
    };
  };
}

export const defaultValuationSeriesLoader = createValuationSeriesLoader(cloudSourceDeps);

/** Builds whatever the on-disk cache can already answer, for an instant first paint. */
export function getCachedValuationBundle(
  indicators: readonly IndicatorDef[] = INDICATORS,
): ValuationBundle | null {
  const legs = new Map<string, DatedSeries>();
  for (const def of requiredSeries(indicators)) {
    const cached = getCachedSeries(def.key, { allowExpired: true });
    if (!cached) continue;
    legs.set(def.key, {
      seriesId: def.key,
      ...cached,
      provenance: provenanceFor(def),
    });
  }
  const errors: string[] = [];
  const builds = buildIndicators(legs, errors, indicators);
  return builds.length > 0 || errors.length > 0 ? bundleFor(builds, legs, errors) : null;
}

function buildIndicators(
  legs: Map<string, DatedSeries>,
  errors: string[],
  indicators: readonly IndicatorDef[],
): IndicatorBuild[] {
  const builds: IndicatorBuild[] = [];
  for (const indicator of indicators) {
    const unavailable = indicatorUnavailableReason(indicator);
    if (unavailable) {
      errors.push(`${indicator.label}: ${unavailable}`);
      continue;
    }
    if (indicatorSeries(indicator).some((def) => !legs.has(def.key))) continue;
    try {
      const series = buildValuationSeries(indicator, legs);
      if (series.points.at(-1)?.ratio == null) {
        errors.push(`${indicator.label}: latest observation unavailable (${series.points.at(-1)!.date})`);
      }
      builds.push({
        indicator,
        series,
        // A cached leg past its refresh time is not late at the source; a cached
        // first paint is revalidated at once, and a failed refresh keeps its error.
        sourceStale: indicatorSeries(indicator).some((def) => {
          const leg = legs.get(def.key);
          return leg?.provider?.stale === true || !!leg?.refreshError;
        }),
        trend: fitIndicatorTrend(indicator, series.points),
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
  if (reasons.size === 1) return [...reasons][0]!;
  return `${errors[0]} (${errors.length - 1} other failures)`;
}

export async function loadValuationBundle(options?: {
  loader?: ValuationSeriesLoader;
  indicators?: readonly IndicatorDef[];
  force?: boolean;
}): Promise<ValuationBundle> {
  const loader = options?.loader ?? defaultValuationSeriesLoader;
  const indicators = options?.indicators ?? INDICATORS;
  const errors: string[] = [];
  const legs = new Map<string, DatedSeries>();

  const settled = await Promise.all(requiredSeries(indicators).map(async (def) => {
    try {
      return { def, data: await loader(def, { force: options?.force }) };
    } catch (error) {
      return {
        def,
        error: `${def.key}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }));
  for (const outcome of settled) {
    if ("error" in outcome && outcome.error) errors.push(outcome.error);
    if ("data" in outcome && outcome.data) legs.set(outcome.def.key, outcome.data);
  }

  const builds = buildIndicators(legs, errors, indicators);
  if (builds.length === 0) throw new Error(summarizeErrors(errors));
  return bundleFor(builds, legs, errors);
}

function bundleFor(builds: IndicatorBuild[], legs: ReadonlyMap<string, DatedSeries>, errors: string[]): ValuationBundle {
  const sources: Record<string, ValuationSourceMetadata> = {};
  for (const [key, data] of legs) {
    sources[key] = {
      provenance: data.provenance,
      fetchedAt: data.fetchedAt ?? null,
      stale: data.stale ?? null,
      ...(data.source ? { source: data.source } : {}),
      ...(data.provider ? { provider: data.provider } : {}),
      ...(data.refreshError ? { refreshError: data.refreshError } : {}),
    };
    if (data.refreshError) errors.push(`${key}: ${data.refreshError}`);
  }
  const timestamps = Object.values(sources).map((source) => source.fetchedAt);
  const fetchedAt = timestamps.length > 0 && timestamps.every((time): time is number => time != null)
    ? Math.min(...timestamps) : null;
  return { builds, errors: [...new Set(errors)], fetchedAt, sources };
}
