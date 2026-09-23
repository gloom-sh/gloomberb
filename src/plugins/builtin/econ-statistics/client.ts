import { apiClient } from "../../../api-client";
import type { DatedObservation, SeriesCacheLoadResult, SeriesCacheMetadata } from "../shared/series-cache";
import { statsCache } from "./cache";
import type { StatDef } from "./defs";
import { STATS } from "./stats";
import { applyTransform, type StatPoint } from "./transform";
import { fitTrend, type TrendFit } from "./trend";

export type StatSeriesLoader = (def: StatDef, options?: { force?: boolean }) => Promise<DatedObservation[] | SeriesCacheLoadResult>;

export interface StatBuild {
  stat: StatDef;
  points: StatPoint[];
  trend: TrendFit;
  cache?: SeriesCacheMetadata;
}

export interface StatsBundle {
  builds: StatBuild[];
  errors: string[];
  /** Oldest known retrieval among included statistics, not the projection time. */
  fetchedAt: number | null;
  fetchedAtComplete: boolean;
}

export type StatsCloudClient = Pick<typeof apiClient, "getCloudFredSeries">;

export function createStatSeriesLoader(client: StatsCloudClient): StatSeriesLoader {
  const cloudLoader = async (def: StatDef): Promise<DatedObservation[]> => {
    const data = await client.getCloudFredSeries(def.seriesId, {
      limit: def.limit,
      sortOrder: "desc",
    });
    return data.observations;
  };
  return (def, options) => statsCache.loadEntry(def.seriesId, () => cloudLoader(def), options);
}

export const defaultStatLoader = createStatSeriesLoader(apiClient);

function build(def: StatDef, result: DatedObservation[] | SeriesCacheLoadResult): StatBuild | null {
  const observations = Array.isArray(result) ? result : result.observations;
  const scale = def.scale ?? 1;
  const scaled = scale === 1
    ? observations
    : observations.map((entry) => ({
      date: entry.date,
      value: entry.value == null ? null : entry.value * scale,
    }));
  const points = applyTransform(scaled, def.transform);
  if (points.length === 0) return null;
  const cache = Array.isArray(result) ? undefined : {
    fetchedAt: result.fetchedAt,
    stale: result.stale,
    source: result.source,
    ...(result.refreshError ? { refreshError: result.refreshError } : {}),
  };
  return { stat: def, points, trend: fitTrend(points), ...(cache ? { cache } : {}) };
}

/**
 * FRED can post a spread before its legs (T10Y2Y for a day DGS10 and DGS2 do
 * not have yet), which printed a 2s10s that disagreed with the 2Y and 10Y rows.
 * A derived stat is cut back to the newest date every loaded leg has.
 */
function alignDerivedBuilds(builds: StatBuild[]): StatBuild[] {
  const byId = new Map(builds.map((entry) => [entry.stat.id, entry]));
  return builds.map((entry) => {
    const legs = entry.stat.derivedFrom?.map((id) => byId.get(id)?.points.at(-1)?.date);
    if (!legs || legs.length === 0 || legs.some((date) => date == null)) return entry;
    const cap = (legs as string[]).reduce((oldest, date) => date < oldest ? date : oldest);
    if ((entry.points.at(-1)?.date ?? "") <= cap) return entry;
    const points = entry.points.filter((point) => point.date <= cap);
    return points.length > 0 ? { ...entry, points, trend: fitTrend(points) } : entry;
  });
}

function bundleFrom(unaligned: StatBuild[], errors: string[]): StatsBundle {
  const builds = alignDerivedBuilds(unaligned);
  const knownTimes = builds.flatMap(({ cache }) =>
    typeof cache?.fetchedAt === "number" && Number.isFinite(cache.fetchedAt) ? [cache.fetchedAt] : []);
  return {
    builds,
    errors,
    fetchedAt: knownTimes.length > 0 ? Math.min(...knownTimes) : null,
    fetchedAtComplete: knownTimes.length === builds.length,
  };
}

/** Builds whatever the on-disk cache can already answer, for an instant first paint. */
export function getCachedStatsBundle(stats: readonly StatDef[] = STATS): StatsBundle | null {
  const builds: StatBuild[] = [];
  const errors: string[] = [];
  for (const def of stats) {
    const cached = statsCache.get(def.seriesId, { allowExpired: true });
    if (!cached) continue;
    const entry = build(def, cached);
    if (entry) {
      builds.push(entry);
      if (cached.refreshError) errors.push(`${def.seriesId}: ${cached.refreshError}`);
    }
  }
  return builds.length > 0 ? bundleFrom(builds, errors) : null;
}

export async function loadStatsBundle(options?: {
  loader?: StatSeriesLoader;
  stats?: readonly StatDef[];
  force?: boolean;
}): Promise<StatsBundle> {
  const loader = options?.loader ?? defaultStatLoader;
  const stats = options?.stats ?? STATS;
  const errors: string[] = [];

  const settled = await Promise.all(stats.map(async (def) => {
    try {
      return { def, result: await loader(def, { force: options?.force ?? false }) };
    } catch (error) {
      errors.push(`${def.seriesId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }));

  const builds: StatBuild[] = [];
  for (const entry of settled) {
    if (!entry) continue;
    if (!Array.isArray(entry.result) && entry.result.refreshError) {
      errors.push(`${entry.def.seriesId}: ${entry.result.refreshError}`);
    }
    const made = build(entry.def, entry.result);
    if (made) builds.push(made);
    else errors.push(`${entry.def.seriesId}: no observations after transform`);
  }

  if (builds.length === 0) {
    throw new Error(errors[0] ?? "Economic statistics unavailable");
  }
  return bundleFrom(builds, errors);
}
