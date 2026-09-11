import { createPluginCache } from "./plugin-cache";
import type {
  CloudFredObservationPayload,
  CloudFredSeriesInfoPayload,
} from "../api-client";

const CACHE_KIND = "fred-series";
const CACHE_SOURCE = "gloomberb-cloud";
// Refresh persisted metadata that predates FRED's source coverage dates.
const CACHE_SCHEMA_VERSION = 2;
const CACHE_POLICY = {
  staleMs: 24 * 60 * 60 * 1000,
  expireMs: 30 * 24 * 60 * 60 * 1000,
} as const;

export interface FredSeriesData {
  observations: CloudFredObservationPayload[];
  info: CloudFredSeriesInfoPayload | null;
  fetchedAt?: string;
  stale?: boolean;
  coverage?: { observations: "available"; info: "available" | "unavailable" };
}

export interface FredSeriesRequest {
  seriesId: string;
  startDate?: string;
  limit?: number;
  sortOrder: "asc" | "desc";
}

export interface FredSeriesCacheEntry {
  data: FredSeriesData;
  fetchedAt: number;
  stale: boolean;
}

export interface FredSeriesLoadResult extends FredSeriesCacheEntry {
  source: "cache" | "network" | "stale-fallback";
  refreshError?: string;
}

const cache = createPluginCache<FredSeriesData>({
  kind: CACHE_KIND, source: CACHE_SOURCE, schemaVersion: CACHE_SCHEMA_VERSION, policy: CACHE_POLICY,
});
const hydratedSeries = new Map<string, FredSeriesCacheEntry>();
export const attachFredSeriesPersistence = cache.attach;

function seriesKey(seriesId: string): string {
  return seriesId.trim().toUpperCase();
}

/** Hydrates server-fetched data for renderers that cannot call the cloud API directly. */
export function hydrateFredSeries(entries: readonly (readonly [string, FredSeriesCacheEntry])[]): void {
  hydratedSeries.clear();
  for (const [seriesId, entry] of entries) hydratedSeries.set(seriesKey(seriesId), entry);
}

export function resetFredSeriesPersistence(): void {
  cache.reset();
  hydratedSeries.clear();
}

function cacheKey(request: FredSeriesRequest): string {
  const range = [
    request.startDate ? `start=${request.startDate}` : "",
    request.limit ? `limit=${request.limit}` : "",
    `sort=${request.sortOrder}`,
  ].filter(Boolean).join(":");
  return `${request.seriesId.trim().toUpperCase()}:${range}`;
}

export function getCachedFredSeries(
  request: FredSeriesRequest,
  options?: { allowExpired?: boolean },
): FredSeriesCacheEntry | null {
  const entry = cache.get(cacheKey(request), options);
  return entry ? withFredSourceFreshness(entry) : null;
}

export function withFredSourceFreshness<T extends FredSeriesCacheEntry>(entry: T): T {
  const sourceTime = entry.data.fetchedAt ? Date.parse(entry.data.fetchedAt) : NaN;
  return {
    ...entry,
    fetchedAt: Number.isFinite(sourceTime) ? Math.min(sourceTime, entry.fetchedAt) : entry.fetchedAt,
    stale: entry.stale || entry.data.stale === true,
  };
}

export async function loadCachedFredSeries(
  request: FredSeriesRequest,
  loader: () => Promise<FredSeriesData>,
  options?: { force?: boolean },
): Promise<FredSeriesLoadResult> {
  const cached = getCachedFredSeries(request);
  if (!options?.force && cached && !cached.stale) return { ...cached, source: "cache" };
  const hydrated = hydratedSeries.get(seriesKey(request.seriesId));
  if (!options?.force && hydrated) return { ...withFredSourceFreshness(hydrated), source: "cache" };
  return withFredSourceFreshness(await cache.load(cacheKey(request), loader, options));
}
