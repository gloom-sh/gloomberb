import type { MarketHeatmapAsset } from "../../../api-client/market-discovery";

/**
 * The board's grouping and move arithmetic, shared by the pane and the `fn HM`
 * report so a sector reads the same in both. Isomorphic: no React or renderer.
 */

type HeatmapMoveAsset = Pick<MarketHeatmapAsset, "symbol" | "hasChange" | "changePercent" | "size" | "sector" | "industry"> & {
  /** Treemap area, when it is not `size` itself. */
  weight?: number;
};

/**
 * The move, or null when there is none: no change data is not a flat session.
 * A name without the last session's close still has the move of the open
 * pre-market or after-hours session it streams (`extendedSession`).
 */
export function heatmapMove(asset: Pick<MarketHeatmapAsset, "hasChange" | "changePercent"> & { extendedSession?: string }): number | null {
  return (asset.hasChange || asset.extendedSession != null) && typeof asset.changePercent === "number" && Number.isFinite(asset.changePercent)
    ? asset.changePercent
    : null;
}

export type HeatmapGrouping = "sector-industry" | "sector" | "flat";

/**
 * Sector and industry blocks when the board knows its sectors. A board where
 * most of the value has none (ETFs, or a snapshot whose classification
 * failed) lays out flat rather than as one big unlabeled block.
 */
export function resolveHeatmapGrouping(assets: readonly HeatmapMoveAsset[], industries: boolean): HeatmapGrouping {
  let total = 0;
  let classified = 0;
  const sectors = new Set<string>();
  for (const asset of assets) {
    const weight = asset.weight ?? asset.size ?? 0;
    total += weight;
    if (asset.sector) {
      classified += weight;
      sectors.add(asset.sector);
    }
  }
  if (sectors.size < 2 || classified < total / 2) return "flat";
  return industries ? "sector-industry" : "sector";
}

/**
 * The move of a set of names weighted by their size (market cap, an ETF's net
 * assets, a position's value), over the names that have both. Null when none do.
 */
export function sizeWeightedMove(assets: readonly HeatmapMoveAsset[]): number | null {
  let weight = 0;
  let weightedMove = 0;
  for (const asset of assets) {
    const change = heatmapMove(asset);
    const size = asset.size ?? 0;
    if (change == null || !(size > 0)) continue;
    weight += size;
    weightedMove += change * size;
  }
  return weight > 0 ? weightedMove / weight : null;
}

export type HeatmapGroupBy = "sector" | "industry";

export interface HeatmapGroupSummary {
  /** The sector or industry; null for names the snapshot does not classify, or every name on a flat board. */
  group: string | null;
  /** The industry's sector, when grouping by industry. */
  sector: string | null;
  names: number;
  /** Total size: market cap, or net assets on the ETF board. */
  size: number;
  /** This group's share of the board's total size. */
  share: number;
  move: number | null;
  /** Names with a move, and the size they carry; the rest have no change data yet. */
  moved: number;
  up: number;
  down: number;
  unchanged: number;
  best: { symbol: string; move: number } | null;
  worst: { symbol: string; move: number } | null;
}

function summarize(group: string | null, sector: string | null, assets: readonly HeatmapMoveAsset[], boardSize: number): HeatmapGroupSummary {
  let up = 0;
  let down = 0;
  let unchanged = 0;
  let size = 0;
  let best: HeatmapGroupSummary["best"] = null;
  let worst: HeatmapGroupSummary["worst"] = null;
  for (const asset of assets) {
    size += asset.size ?? 0;
    const move = heatmapMove(asset);
    if (move == null) continue;
    if (move > 0) up += 1;
    else if (move < 0) down += 1;
    else unchanged += 1;
    if (!best || move > best.move) best = { symbol: asset.symbol, move };
    if (!worst || move < worst.move) worst = { symbol: asset.symbol, move };
  }
  return {
    group,
    sector,
    names: assets.length,
    size,
    share: boardSize > 0 ? size / boardSize : 0,
    move: sizeWeightedMove(assets),
    moved: up + down + unchanged,
    up,
    down,
    unchanged,
    best,
    worst,
  };
}

/**
 * One summary per sector or industry, largest first as the board lays them
 * out. A flat board (ETFs) is one group of every name. Unclassified names form
 * their own group last.
 */
export function summarizeHeatmapGroups(
  assets: readonly HeatmapMoveAsset[],
  groupBy: HeatmapGroupBy,
): { grouping: HeatmapGrouping; groups: HeatmapGroupSummary[]; board: HeatmapGroupSummary } {
  const grouping = resolveHeatmapGrouping(assets, groupBy === "industry");
  const boardSize = assets.reduce((sum, asset) => sum + (asset.size ?? 0), 0);
  const board = summarize(null, null, assets, boardSize);
  if (grouping === "flat") return { grouping, groups: [board], board };
  const buckets = new Map<string, { group: string | null; sector: string | null; assets: HeatmapMoveAsset[] }>();
  for (const asset of assets) {
    const sector = asset.sector ?? null;
    const group = sector == null ? null : grouping === "sector-industry" ? asset.industry ?? null : sector;
    const key = `${sector ?? ""}\u0000${group ?? ""}`;
    const bucket = buckets.get(key) ?? { group, sector, assets: [] };
    bucket.assets.push(asset);
    buckets.set(key, bucket);
  }
  const groups = [...buckets.values()]
    .map((bucket) => summarize(bucket.group, grouping === "sector-industry" ? bucket.sector : null, bucket.assets, boardSize))
    .sort((left, right) => Number(left.sector == null && left.group == null) - Number(right.sector == null && right.group == null)
      || right.size - left.size);
  return { grouping, groups, board };
}
