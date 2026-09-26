import { createSeriesCache, type SeriesCacheLoadOptions, type SeriesCacheInput } from "../shared/series-cache";
import type { DatedObservation } from "./series";
import type { PluginPersistence } from "../../../types/plugin";

const cache = createSeriesCache("market-valuation-series", 6 * 60 * 60 * 1000);

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

export function loadCachedSeriesEntry(
  key: string,
  loader: () => Promise<DatedObservation[] | SeriesCacheInput>,
  options?: SeriesCacheLoadOptions,
) {
  return cache.loadEntry(key, loader, options);
}
