import { apiClient } from "../../../api-client";
import type { MarketHeatmapResult, MarketHeatmapUniverseId } from "../../../api-client/market-discovery";
export type { MarketHeatmapUniverseId } from "../../../api-client/market-discovery";

export const MARKET_HEATMAP_UNIVERSES = [
  { id: "us-equity", label: "US Stocks" },
  { id: "us-etf", label: "US ETFs" },
] as const;
/** The 500 largest US stocks (an older server answers with its own maximum); ETFs stay flat and need fewer. */
export const MARKET_HEATMAP_REQUEST_COUNT: Record<MarketHeatmapUniverseId, number> = { "us-equity": 500, "us-etf": 160 };
export interface MarketHeatmapFetchOptions { count?: number; forceRefresh?: boolean; cache?: boolean; }
export interface MarketHeatmapSources { client?: Pick<typeof apiClient, "getMarketHeatmap">; }

/** A board as this client holds it: the server's snapshot, and what the request behind it was. */
export interface MarketHeatmapBoard extends MarketHeatmapResult {
  /**
   * When the response arrived and passed validation. `fetchedAt` is when the
   * server put the snapshot together, which a check a minute later can
   * return unchanged. A board served from the cache keeps the time of the
   * response it came from.
   */
  checkedAt: number;
  /**
   * How many of the largest listings the board covers: the count asked for,
   * or fewer when the server serves fewer. A company listed twice is one
   * listing of them but one tile, so `assets` can be shorter.
   */
  topCount: number;
}

const DEFAULT_COUNT = 80;
/** The most names one board asks for; a server that serves fewer answers with its own maximum. */
const MAX_MARKET_HEATMAP_COUNT = 500;
const CACHE_TTL_MS = 60_000;
const activeFetches = new Map<string, Promise<MarketHeatmapBoard>>();
const memoryCache = new Map<string, { expiresAt: number; result: MarketHeatmapBoard }>();

/**
 * One tile per symbol. A company listed on two exchanges (KHC on NASDAQ and
 * NYSE) arrives twice; drawing both would collide tile ids and count its
 * sector twice, so the larger listing stays where it ranked.
 */
export function dedupeHeatmapAssets<T extends { symbol: string; size: number | null }>(assets: readonly T[]): T[] {
  const kept = new Map<string, number>();
  const result: T[] = [];
  for (const asset of assets) {
    const index = kept.get(asset.symbol);
    if (index == null) {
      kept.set(asset.symbol, result.length);
      result.push(asset);
    } else if ((asset.size ?? 0) > (result[index]!.size ?? 0)) {
      result[index] = asset;
    }
  }
  return result;
}

async function loadMarketHeatmap(universe: MarketHeatmapUniverseId, count: number, sources?: MarketHeatmapSources): Promise<MarketHeatmapBoard> {
  const response = await (sources?.client ?? apiClient).getMarketHeatmap(universe, count);
  if (!response.data || !Array.isArray(response.data.assets) || response.data.universe !== universe
    || (response.status !== "success" && response.status !== "partial")) throw new Error("Market heatmap unavailable");
  return {
    ...response.data,
    stale: response.stale === true || response.data.stale === true,
    assets: dedupeHeatmapAssets(response.data.assets).slice(0, count),
    checkedAt: Date.now(),
    topCount: Math.min(count, response.data.assets.length),
  };
}

export async function fetchMarketHeatmap(
  universe: MarketHeatmapUniverseId,
  options?: MarketHeatmapFetchOptions,
  sources?: MarketHeatmapSources,
): Promise<MarketHeatmapBoard> {
  const count = Math.max(1, Math.min(MAX_MARKET_HEATMAP_COUNT, Math.round(options?.count ?? DEFAULT_COUNT)));
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
