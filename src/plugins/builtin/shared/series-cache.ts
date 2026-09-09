import { createPluginCache } from "../../../data/plugin-cache";
import type { PluginPersistence } from "../../../types/plugin";

export interface DatedObservation {
  date: string;
  value: number | null;
}

export interface SeriesCacheEntry {
  observations: DatedObservation[];
  fetchedAt: number;
  stale: boolean;
}

export interface SeriesCache {
  attach(persistence: PluginPersistence): void;
  reset(): void;
  /** Preloads server-fetched legs for renderers that cannot reach the cloud API. */
  hydrate(entries: readonly (readonly [string, DatedObservation[]])[]): void;
  get(key: string, options?: { allowExpired?: boolean }): SeriesCacheEntry | null;
  load(key: string, loader: () => Promise<DatedObservation[]>): Promise<DatedObservation[]>;
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
  const cache = createPluginCache<DatedObservation[]>({
    kind, source: CACHE_SOURCE, schemaVersion: CACHE_SCHEMA_VERSION,
    policy: { staleMs, expireMs: 30 * 24 * 60 * 60 * 1000 },
  });
  const hydrated = new Map<string, DatedObservation[]>();
  return {
    attach: cache.attach,
    reset() { cache.reset(); hydrated.clear(); },
    hydrate(entries) {
      hydrated.clear();
      for (const [key, observations] of entries) hydrated.set(key, observations);
    },
    get(key, options) {
      const result = cache.get(key, options);
      return result ? { observations: result.data, fetchedAt: result.fetchedAt, stale: result.stale } : null;
    },
    async load(key, loader) {
      return hydrated.get(key) ?? (await cache.load(key, loader)).data;
    },
  };
}
