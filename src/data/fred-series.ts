import type {
  CloudFredObservationPayload,
  CloudFredSeriesInfoPayload,
} from "../api-client";
import type { PluginPersistence } from "../types/plugin";

const CACHE_KIND = "fred-series";
const CACHE_SOURCE = "gloomberb-cloud";
const CACHE_SCHEMA_VERSION = 1;
const CACHE_POLICY = {
  staleMs: 24 * 60 * 60 * 1000,
  expireMs: 30 * 24 * 60 * 60 * 1000,
} as const;

export interface FredSeriesData {
  observations: CloudFredObservationPayload[];
  info: CloudFredSeriesInfoPayload | null;
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

let persistence: PluginPersistence | null = null;
const activeFetches = new Map<string, Promise<FredSeriesLoadResult>>();
const hydratedSeries = new Map<string, FredSeriesCacheEntry>();

function seriesKey(seriesId: string): string {
  return seriesId.trim().toUpperCase();
}

export function attachFredSeriesPersistence(nextPersistence: PluginPersistence): void {
  persistence = nextPersistence;
}

/** Hydrates server-fetched data for renderers that cannot call the cloud API directly. */
export function hydrateFredSeries(entries: readonly (readonly [string, FredSeriesCacheEntry])[]): void {
  hydratedSeries.clear();
  for (const [seriesId, entry] of entries) hydratedSeries.set(seriesKey(seriesId), entry);
}

export function resetFredSeriesPersistence(): void {
  persistence = null;
  activeFetches.clear();
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
  const record = persistence?.getResource<FredSeriesData>(CACHE_KIND, cacheKey(request), {
    sourceKey: CACHE_SOURCE,
    schemaVersion: CACHE_SCHEMA_VERSION,
    allowExpired: options?.allowExpired,
  });
  if (!record) return null;

  return {
    data: record.value,
    fetchedAt: record.fetchedAt,
    stale: !!record.stale,
  };
}

function writeCache(key: string, data: FredSeriesData): void {
  persistence?.setResource(CACHE_KIND, key, data, {
    sourceKey: CACHE_SOURCE,
    schemaVersion: CACHE_SCHEMA_VERSION,
    cachePolicy: CACHE_POLICY,
  });
}

export async function loadCachedFredSeries(
  request: FredSeriesRequest,
  loader: () => Promise<FredSeriesData>,
  options?: { force?: boolean },
): Promise<FredSeriesLoadResult> {
  const key = cacheKey(request);
  const cached = getCachedFredSeries(request);
  if (!options?.force && cached && !cached.stale) {
    return { ...cached, source: "cache" };
  }
  const hydrated = hydratedSeries.get(seriesKey(request.seriesId));
  if (!options?.force && hydrated) {
    return { ...hydrated, source: "cache" };
  }

  const activeFetch = activeFetches.get(key);
  if (activeFetch) return activeFetch;

  const fallback = cached ?? getCachedFredSeries(request, { allowExpired: true });
  const fetchPromise = loader()
    .then((data) => {
      writeCache(key, data);
      return {
        data,
        fetchedAt: Date.now(),
        stale: false,
        source: "network" as const,
      };
    })
    .catch((error) => {
      if (fallback) {
        return {
          ...fallback,
          stale: true,
          source: "stale-fallback" as const,
          refreshError: error instanceof Error ? error.message : String(error),
        };
      }
      throw error;
    })
    .finally(() => {
      if (activeFetches.get(key) === fetchPromise) activeFetches.delete(key);
    });

  activeFetches.set(key, fetchPromise);
  return fetchPromise;
}
