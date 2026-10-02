import { createPluginCache, type PluginCacheResult } from "../../../data/plugin-cache";
import type { PluginPersistence } from "../../../types/plugin";

export interface DatedObservation {
  date: string;
  value: number | null;
}

export interface SeriesCacheMetadata {
  fetchedAt: number | null;
  stale: boolean | null;
  source: PluginCacheResult<unknown>["source"] | "hydrated";
  refreshError?: string;
}

export interface SeriesProviderMetadata {
  fetchedAt: string | null;
  stale: boolean | null;
}

export interface SeriesCacheInput {
  observations: DatedObservation[];
  provider?: SeriesProviderMetadata;
}

export interface SeriesCacheLoadResult extends SeriesCacheMetadata, SeriesCacheInput {}

interface SeriesCacheEntry extends SeriesCacheLoadResult {
  fetchedAt: number;
  stale: boolean;
}

interface SeriesCacheLoadOptions {
  force?: boolean;
  replace?: boolean;
}

export interface SeriesCache {
  attach(persistence: PluginPersistence): void;
  reset(): void;
  /** Preloads server-fetched legs for renderers that cannot reach the cloud API. */
  hydrate(entries: readonly (readonly [string, DatedObservation[]])[]): void;
  get(key: string, options?: { allowExpired?: boolean }): SeriesCacheEntry | null;
  load(key: string, loader: () => Promise<DatedObservation[]>): Promise<DatedObservation[]>;
  loadEntry(key: string, loader: () => Promise<DatedObservation[] | SeriesCacheInput>, options?: SeriesCacheLoadOptions): Promise<SeriesCacheLoadResult>;
}

const CACHE_SOURCE = "gloomberb-cloud";
const CACHE_SCHEMA_VERSION = 1;

/**
 * Disk-backed cache for dated series, one instance per pane so their keys cannot
 * collide. Serves a fresh entry without a request, refreshes a stale one, and falls
 * back to expired data when the network fails, so an outage degrades to old numbers
 * rather than an empty pane.
 */
export function createSeriesCache(kind: string, staleMs: number): SeriesCache {
  const cache = createPluginCache<SeriesCacheInput, DatedObservation[] | SeriesCacheInput>({
    kind, source: CACHE_SOURCE, schemaVersion: CACHE_SCHEMA_VERSION,
    policy: { staleMs, expireMs: 30 * 24 * 60 * 60 * 1000 },
    // Existing array entries and callers retain their on-disk contract.
    encode: (value) => value.provider ? value : value.observations,
    decode: (value) => {
      if (Array.isArray(value)) return { observations: value };
      if (!value || !Array.isArray(value.observations)) throw new Error("Invalid cached series");
      return value;
    },
  });
  const hydrated = new Map<string, DatedObservation[]>();
  const failures = new Map<string, string>();
  const requests = new Map<string, symbol>();
  let generation = 0;
  let persistence: PluginPersistence | null = null;
  const withFailure = <T extends SeriesCacheLoadResult>(key: string, result: T): T => {
    const failure = failures.get(key);
    return failure
      ? { ...result, stale: true, source: "stale-fallback", refreshError: failure }
      : result;
  };
  const loadEntry: SeriesCache["loadEntry"] = async (key, loader, options) => {
    const observations = hydrated.get(key);
    if (observations) return { observations, fetchedAt: null, stale: null, source: "hydrated" };
    const owner = generation;
    const { data, fetchedAt, stale, source, refreshError } = await cache.load(key, async () => {
      const request = Symbol();
      if (owner === generation) requests.set(key, request);
      try {
        const value = await loader();
        if (owner === generation && requests.get(key) === request) failures.delete(key);
        return Array.isArray(value) ? { observations: value } : value;
      } catch (error) {
        // A fresh-cache read after a failed forced refresh is not a recovery.
        // Keep the failure until an actual successful request, without changing
        // the underlying cache's joining or replacement behavior.
        if (owner === generation && requests.get(key) === request) {
          const previous = cache.get(key, { allowExpired: true });
          if (previous) failures.set(key, error instanceof Error ? error.message : String(error));
        }
        throw error;
      } finally {
        if (owner === generation && requests.get(key) === request) requests.delete(key);
      }
    }, options);
    return withFailure(key, { ...data, fetchedAt, stale, source, ...(refreshError ? { refreshError } : {}) });
  };
  const reset = () => {
    generation += 1;
    persistence = null;
    failures.clear();
    requests.clear();
    cache.reset();
    hydrated.clear();
  };
  return {
    attach(next) {
      if (persistence !== next) {
        generation += 1;
        failures.clear();
        requests.clear();
      }
      persistence = next;
      cache.attach(next);
    },
    reset,
    hydrate(entries) {
      hydrated.clear();
      for (const [key, observations] of entries) hydrated.set(key, observations);
    },
    get(key, options) {
      const result = cache.get(key, options);
      return result ? withFailure(key, { ...result.data, fetchedAt: result.fetchedAt, stale: result.stale, source: result.source }) : null;
    },
    async load(key, loader) {
      return (await loadEntry(key, loader)).observations;
    },
    loadEntry,
  };
}
