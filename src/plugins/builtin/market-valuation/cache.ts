import { createSeriesCache } from "../shared/series-cache";
import type { DatedObservation } from "./series";
import type { PluginPersistence } from "../../../types/plugin";

const cache = createSeriesCache("market-valuation-series", 6 * 60 * 60 * 1000);

export type { SeriesCacheEntry } from "../shared/series-cache";

export function attachValuationPersistence(next: PluginPersistence): void {
  cache.attach(next);
}

export function resetValuationPersistence(): void {
  cache.reset();
}

export function hydrateValuationSeries(
  entries: readonly (readonly [string, DatedObservation[]])[],
): void {
  cache.hydrate(entries);
}

export function getCachedSeries(key: string, options?: { allowExpired?: boolean }) {
  return cache.get(key, options);
}

export function loadCachedSeries(
  key: string,
  loader: () => Promise<DatedObservation[]>,
): Promise<DatedObservation[]> {
  return cache.load(key, loader);
}
