import { apiClient } from "../../../api-client";
import { cloudDisplayScope } from "../../../api-client/plan-access";
import { createTtlCache } from "../../../data/ttl-cache";
import type { MarketHeatmapAsset, MarketHeatmapResult, MarketHeatmapUniverseId } from "../../../api-client/market-discovery";
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

/**
 * A real-time board's tile the server's live read did not price comes as a
 * tile with no move and no price, the shape older clients draw blank, with
 * its delayed figures in `delayedQuote`. This client holds it as a name that
 * has moved in the session but has no live move yet (`hasChange` true,
 * `changePercent` null), whatever `hasChange` the server sent: the tile then
 * shows its delayed figures, marked, until the stream's live quote of the
 * name gives it a move of its own. Every other tile is left as it came.
 */
export function holdDelayedHeatmapTiles<T extends MarketHeatmapAsset>(assets: readonly T[]): T[] {
  return assets.map((asset) => (asset.delayedQuote && typeof asset.delayedQuote === "object"
    ? { ...asset, hasChange: true, change: null, changePercent: null, price: 0, volume: null, regularChangePercent: null }
    : asset));
}

async function loadMarketHeatmap(universe: MarketHeatmapUniverseId, count: number, sources?: MarketHeatmapSources): Promise<MarketHeatmapBoard> {
  const response = await (sources?.client ?? apiClient).getMarketHeatmap(universe, count);
  if (!response.data || !Array.isArray(response.data.assets) || response.data.universe !== universe
    || (response.status !== "success" && response.status !== "partial")) throw new Error("Market heatmap unavailable");
  return {
    ...response.data,
    stale: response.stale === true || response.data.stale === true,
    assets: holdDelayedHeatmapTiles(dedupeHeatmapAssets(response.data.assets).slice(0, count)),
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
  const scope = cloudDisplayScope();
  if (options?.cache === false || sources?.client || scope === null) return load();
  return boards.load(JSON.stringify([scope, universe, count]), load, { force: options?.forceRefresh });
}

export function resetMarketHeatmapCache(): void {
  boards.clear();
}
