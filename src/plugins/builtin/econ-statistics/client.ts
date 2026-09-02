import { apiClient } from "../../../api-client";
import type { DatedObservation } from "../shared/series-cache";
import { statsCache } from "./cache";
import type { StatDef } from "./defs";
import { STATS } from "./stats";
import { applyTransform, type StatPoint } from "./transform";
import { fitTrend, type TrendFit } from "./trend";

export type StatSeriesLoader = (def: StatDef) => Promise<DatedObservation[]>;

export interface StatBuild {
  stat: StatDef;
  points: StatPoint[];
  trend: TrendFit;
}

export interface StatsBundle {
  builds: StatBuild[];
  errors: string[];
  fetchedAt: number;
}

const cloudLoader: StatSeriesLoader = async (def) => {
  const data = await apiClient.getCloudFredSeries(def.seriesId, {
    limit: def.limit,
    sortOrder: "desc",
  });
  return data.observations;
};

export const defaultStatLoader: StatSeriesLoader = (def) =>
  statsCache.load(def.seriesId, () => cloudLoader(def));

function build(def: StatDef, observations: DatedObservation[]): StatBuild | null {
  const scale = def.scale ?? 1;
  const scaled = scale === 1
    ? observations
    : observations.map((entry) => ({
      date: entry.date,
      value: entry.value == null ? null : entry.value * scale,
    }));
  const points = applyTransform(scaled, def.transform);
  if (points.length === 0) return null;
  return { stat: def, points, trend: fitTrend(points) };
}

/** Builds whatever the on-disk cache can already answer, for an instant first paint. */
export function getCachedStatsBundle(stats: readonly StatDef[] = STATS): StatsBundle | null {
  const builds: StatBuild[] = [];
  for (const def of stats) {
    const cached = statsCache.get(def.seriesId, { allowExpired: true });
    if (!cached) continue;
    const entry = build(def, cached.observations);
    if (entry) builds.push(entry);
  }
  return builds.length > 0 ? { builds, errors: [], fetchedAt: Date.now() } : null;
}

export async function loadStatsBundle(options?: {
  loader?: StatSeriesLoader;
  stats?: readonly StatDef[];
}): Promise<StatsBundle> {
  const loader = options?.loader ?? defaultStatLoader;
  const stats = options?.stats ?? STATS;
  const errors: string[] = [];

  const settled = await Promise.all(stats.map(async (def) => {
    try {
      return { def, observations: await loader(def) };
    } catch (error) {
      errors.push(`${def.seriesId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }));

  const builds: StatBuild[] = [];
  for (const entry of settled) {
    if (!entry) continue;
    const made = build(entry.def, entry.observations);
    if (made) builds.push(made);
    else errors.push(`${entry.def.seriesId}: no observations after transform`);
  }

  if (builds.length === 0) {
    throw new Error(errors[0] ?? "Economic statistics unavailable");
  }
  return { builds, errors, fetchedAt: Date.now() };
}
