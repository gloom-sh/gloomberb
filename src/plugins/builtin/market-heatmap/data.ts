import { apiClient } from "../../../api-client";
import type { MarketHeatmapResult, MarketHeatmapUniverseId } from "../../../api-client/market-discovery";
export type { MarketHeatmapAsset, MarketHeatmapResult, MarketHeatmapUniverseId } from "../../../api-client/market-discovery";

export const MARKET_HEATMAP_UNIVERSES = [
  { id: "us-equity", label: "US Stocks" },
  { id: "us-etf", label: "US ETFs" },
] as const;
export interface MarketHeatmapFetchOptions { count?: number; forceRefresh?: boolean; cache?: boolean; }
export interface MarketHeatmapSources { client?: Pick<typeof apiClient, "getMarketHeatmap">; }
const DEFAULT_COUNT = 80;
const CACHE_TTL_MS = 60_000;
const activeFetches = new Map<string, Promise<MarketHeatmapResult>>();
const memoryCache = new Map<string, { expiresAt: number; result: MarketHeatmapResult }>();

async function loadMarketHeatmap(universe: MarketHeatmapUniverseId, count: number, sources?: MarketHeatmapSources): Promise<MarketHeatmapResult> {
  const response = await (sources?.client ?? apiClient).getMarketHeatmap(universe, count);
  if (!response.data || !Array.isArray(response.data.assets) || response.data.universe !== universe
    || (response.status !== "success" && response.status !== "partial")) throw new Error("Market heatmap unavailable");
  return { ...response.data, stale: response.stale === true || response.data.stale === true, assets: response.data.assets.slice(0, count) };
}

export async function fetchMarketHeatmap(
  universe: MarketHeatmapUniverseId,
  options?: MarketHeatmapFetchOptions,
  sources?: MarketHeatmapSources,
): Promise<MarketHeatmapResult> {
  const count = Math.max(1, Math.min(160, Math.round(options?.count ?? DEFAULT_COUNT)));
  const cacheKey = `${universe}:${count}`;
  const useCache = options?.cache !== false && !sources?.client;
  const now = Date.now();
  const cached = memoryCache.get(cacheKey);
  if (useCache && !options?.forceRefresh && cached && cached.expiresAt > now) {
    return cached.result;
  }

  if (useCache) {
    const active = activeFetches.get(cacheKey);
    if (active) return active;
  }

  const fetchPromise = loadMarketHeatmap(universe, count, sources)
    .then((result) => {
      if (useCache) {
        memoryCache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
      }
      return result;
    })
    .finally(() => {
      if (activeFetches.get(cacheKey) === fetchPromise) {
        activeFetches.delete(cacheKey);
      }
    });

  if (useCache) activeFetches.set(cacheKey, fetchPromise);
  return fetchPromise;
}

export function resetMarketHeatmapCache(): void {
  activeFetches.clear();
  memoryCache.clear();
}
