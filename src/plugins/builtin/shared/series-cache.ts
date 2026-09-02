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
  const policy = { staleMs, expireMs: 30 * 24 * 60 * 60 * 1000 } as const;
  let persistence: PluginPersistence | null = null;
  const inflight = new Map<string, Promise<DatedObservation[]>>();
  const hydrated = new Map<string, DatedObservation[]>();

  const get: SeriesCache["get"] = (key, options) => {
    const record = persistence?.getResource<DatedObservation[]>(kind, key, {
      sourceKey: CACHE_SOURCE,
      schemaVersion: CACHE_SCHEMA_VERSION,
      allowExpired: options?.allowExpired,
    });
    if (!record) return null;
    return { observations: record.value, fetchedAt: record.fetchedAt, stale: !!record.stale };
  };

  return {
    attach(next) {
      persistence = next;
    },
    reset() {
      persistence = null;
      inflight.clear();
      hydrated.clear();
    },
    hydrate(entries) {
      hydrated.clear();
      for (const [key, observations] of entries) hydrated.set(key, observations);
    },
    get,
    load(key, loader) {
      const preloaded = hydrated.get(key);
      if (preloaded) return Promise.resolve(preloaded);

      const cached = get(key);
      if (cached && !cached.stale) return Promise.resolve(cached.observations);

      const active = inflight.get(key);
      if (active) return active;

      const request = (async () => {
        try {
          const observations = await loader();
          persistence?.setResource(kind, key, observations, {
            sourceKey: CACHE_SOURCE,
            schemaVersion: CACHE_SCHEMA_VERSION,
            cachePolicy: policy,
          });
          return observations;
        } catch (error) {
          const stale = cached ?? get(key, { allowExpired: true });
          if (stale) return stale.observations;
          throw error;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, request);
      return request;
    },
  };
}
