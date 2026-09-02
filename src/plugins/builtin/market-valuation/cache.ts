import type { PluginPersistence } from "../../../types/plugin";
import type { DatedObservation } from "./series";

const CACHE_KIND = "market-valuation-series";
const CACHE_SOURCE = "gloomberb-cloud";
const CACHE_SCHEMA_VERSION = 1;
const CACHE_POLICY = {
  staleMs: 6 * 60 * 60 * 1000,
  expireMs: 30 * 24 * 60 * 60 * 1000,
} as const;

export interface SeriesCacheEntry {
  observations: DatedObservation[];
  fetchedAt: number;
  stale: boolean;
}

let persistence: PluginPersistence | null = null;
const inflight = new Map<string, Promise<DatedObservation[]>>();
/** Server-fetched legs for renderers that cannot reach the cloud API themselves. */
const hydrated = new Map<string, DatedObservation[]>();

export function attachValuationPersistence(next: PluginPersistence): void {
  persistence = next;
}

export function resetValuationPersistence(): void {
  persistence = null;
  inflight.clear();
  hydrated.clear();
}

export function hydrateValuationSeries(
  entries: readonly (readonly [string, DatedObservation[]])[],
): void {
  hydrated.clear();
  for (const [key, observations] of entries) hydrated.set(key, observations);
}

export function getCachedSeries(
  key: string,
  options?: { allowExpired?: boolean },
): SeriesCacheEntry | null {
  const record = persistence?.getResource<DatedObservation[]>(CACHE_KIND, key, {
    sourceKey: CACHE_SOURCE,
    schemaVersion: CACHE_SCHEMA_VERSION,
    allowExpired: options?.allowExpired,
  });
  if (!record) return null;
  return { observations: record.value, fetchedAt: record.fetchedAt, stale: !!record.stale };
}

/**
 * Serves a fresh cache entry without a request, refreshes a stale one, and falls
 * back to expired data when the network fails, so a proxy outage degrades to old
 * numbers rather than an empty pane.
 */
export async function loadCachedSeries(
  key: string,
  loader: () => Promise<DatedObservation[]>,
): Promise<DatedObservation[]> {
  const preloaded = hydrated.get(key);
  if (preloaded) return preloaded;

  const cached = getCachedSeries(key);
  if (cached && !cached.stale) return cached.observations;

  const active = inflight.get(key);
  if (active) return active;

  const request = (async () => {
    try {
      const observations = await loader();
      persistence?.setResource(CACHE_KIND, key, observations, {
        sourceKey: CACHE_SOURCE,
        schemaVersion: CACHE_SCHEMA_VERSION,
        cachePolicy: CACHE_POLICY,
      });
      return observations;
    } catch (error) {
      const stale = cached ?? getCachedSeries(key, { allowExpired: true });
      if (stale) return stale.observations;
      throw error;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, request);
  return request;
}
