import { apiClient } from "../../../api-client";
import { createTtlCache } from "../../../data/ttl-cache";
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
/**
 * How often a board is worth checking again: a real-time board's live read
 * is renewed every 15 seconds on the server, a delayed board's snapshot is
 * cached there for a minute.
 */
export function heatmapCheckIntervalMs(board: Pick<MarketHeatmapResult, "access"> | null | undefined): number {
  return board?.access === "realtime" ? 15_000 : 60_000;
}
const boards = createTtlCache<MarketHeatmapBoard>({ ttlMs: heatmapCheckIntervalMs });

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

export function fetchMarketHeatmap(
  universe: MarketHeatmapUniverseId,
  options?: MarketHeatmapFetchOptions,
  sources?: MarketHeatmapSources,
): Promise<MarketHeatmapBoard> {
  const count = Math.max(1, Math.min(MAX_MARKET_HEATMAP_COUNT, Math.round(options?.count ?? DEFAULT_COUNT)));
  const load = () => loadMarketHeatmap(universe, count, sources);
  // A board asked for uncached, or through another client, neither reads nor fills the shared cache.
  if (options?.cache === false || sources?.client) return load();
  return boards.load(`${universe}:${count}`, load, { force: options?.forceRefresh });
}

export function resetMarketHeatmapCache(): void {
  boards.clear();
}
