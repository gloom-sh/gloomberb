import { buildValuationSeries } from "./align";
import { getCachedSeries, loadCachedSeries } from "./cache";
import { indicatorSeries, type IndicatorDef, type SeriesDef } from "./defs";
import { INDICATORS } from "./indicators";
import type { DatedSeries } from "./series";
import {
  cloudSourceDeps,
  createSourceLoader,
  provenanceFor,
  type ValuationSourceDeps,
} from "./sources";
import { fitIndicatorTrend } from "./trend";
import type { IndicatorBuild, ValuationBundle } from "./view";

export type ValuationSeriesLoader = (def: SeriesDef) => Promise<DatedSeries>;

/** Every distinct leg the registry needs, so shared series are fetched once. */
export function requiredSeries(
  indicators: readonly IndicatorDef[] = INDICATORS,
): SeriesDef[] {
  const seen = new Map<string, SeriesDef>();
  for (const indicator of indicators) {
    for (const def of indicatorSeries(indicator)) {
      if (!seen.has(def.key)) seen.set(def.key, def);
    }
  }
  return [...seen.values()];
}

/** Cache-first around the cloud sources; exported so Bun-side tooling can reuse it. */
export function createValuationSeriesLoader(deps: ValuationSourceDeps): ValuationSeriesLoader {
  const cloudLoader = createSourceLoader(deps);
  return async (def) => ({
    seriesId: def.key,
    observations: await loadCachedSeries(def.key, async () => (await cloudLoader(def)).observations),
    provenance: provenanceFor(def),
  });
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
      observations: cached.observations,
      provenance: provenanceFor(def),
    });
  }
  const builds = buildIndicators(legs, [], indicators);
  return builds.length > 0 ? { builds, errors: [], fetchedAt: Date.now() } : null;
}

function buildIndicators(
  legs: Map<string, DatedSeries>,
  errors: string[],
  indicators: readonly IndicatorDef[],
): IndicatorBuild[] {
  const builds: IndicatorBuild[] = [];
  for (const indicator of indicators) {
    if (indicatorSeries(indicator).some((def) => !legs.has(def.key))) continue;
    try {
      const series = buildValuationSeries(indicator, legs);
      builds.push({
        indicator,
        series,
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
  const reason = reasons.size === 1 ? [...reasons][0]! : `${errors.length} series failed`;
  return errors.length > 1 ? `${reason} (${errors.length} series)` : reason;
}

export async function loadValuationBundle(options?: {
  loader?: ValuationSeriesLoader;
  indicators?: readonly IndicatorDef[];
}): Promise<ValuationBundle> {
  const loader = options?.loader ?? defaultValuationSeriesLoader;
  const indicators = options?.indicators ?? INDICATORS;
  const errors: string[] = [];
  const legs = new Map<string, DatedSeries>();

  const settled = await Promise.all(requiredSeries(indicators).map(async (def) => {
    try {
      return { def, data: await loader(def) };
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
  return { builds, errors, fetchedAt: Date.now() };
}
