import type { MarketHeatmapAsset } from "../../../api-client/market-discovery";
import { formatShortDate } from "../../../utils/datetime-format";
import { displayWidth } from "../../../utils/format";
import { zonedDateKey, zonedDateTimeParts } from "../../../utils/zoned-date-time";

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
 * pre-market or after-hours session it streams (`extendedSession`), or of the
 * completed regular session its quote reports (`regularChangePercent`).
 */
export function heatmapMove(
  asset: Pick<MarketHeatmapAsset, "hasChange" | "changePercent" | "regularChangePercent"> & { extendedSession?: string },
): number | null {
  const moved = asset.hasChange || asset.extendedSession != null
    || (typeof asset.regularChangePercent === "number" && Number.isFinite(asset.regularChangePercent));
  return moved && typeof asset.changePercent === "number" && Number.isFinite(asset.changePercent)
    ? asset.changePercent
    : null;
}

/**
 * What a market board's tiles are colored by. The active session, the
 * default, follows an open pre-market or after-hours session; the regular
 * session keeps the regular session's move through extended trading.
 */
export type HeatmapSessionBasis = "active-session" | "regular-session";

/** A saved choice wins; a pane that never chose follows the active session. */
export function heatmapSessionBasis(value: unknown): HeatmapSessionBasis {
  return value === "regular-session" ? "regular-session" : "active-session";
}

/** How many of the largest names a market board asks for. */
export const HEATMAP_NAME_COUNTS = [100, 150, 500] as const;
export type HeatmapNameCount = typeof HEATMAP_NAME_COUNTS[number];

/** A saved count, as the settings dialog stores it ("150") or as a number; anything else is the full 500. */
export function heatmapNameCount(value: unknown): HeatmapNameCount {
  const count = typeof value === "string" && value.trim() ? Number(value) : value;
  return HEATMAP_NAME_COUNTS.find((option) => option === count) ?? 500;
}

/**
 * A market board read by its regular session alone. Taken outside the regular
 * session, a tile's move is that session's only when the server dates it as
 * the completed session's (`regularChangePercent`); any other move there is
 * from a session it does not name, so the tile shows none, and no price.
 * Returns the same array when nothing changes.
 */
export function regularSessionHeatmapAssets<T extends Pick<MarketHeatmapAsset, "hasChange" | "price" | "regularChangePercent">>(
  assets: readonly T[],
  session: string | null | undefined,
): readonly T[] {
  if (session == null || session === "REGULAR") return assets;
  let changed = false;
  const next = assets.map((asset) => {
    if (!asset.hasChange || (typeof asset.regularChangePercent === "number" && Number.isFinite(asset.regularChangePercent))) return asset;
    changed = true;
    return { ...asset, hasChange: false, price: 0 };
  });
  return changed ? next : assets;
}

const NEW_YORK = "America/New_York";
const twoDigits = (value: number) => String(value).padStart(2, "0");
/** A New York calendar day ("2026-10-09") as the footer names it: "Oct 9". */
const dayLabel = (day: string) => formatShortDate(day, { year: false, utc: true, fallback: day });

/**
 * What a market board covers and when it is from, for the footer: how many of
 * the largest names it holds, the completed regular session it shows outside
 * that session, when the server put the snapshot together, in New York time,
 * dated when that day is not the session's (or, while the session trades,
 * today's), and when this client last checked, which is a separate figure.
 * A footer narrower than `maxWidth` loses the check first, then the snapshot,
 * then the session; after a failed refresh (`failed`) the age of the last good
 * check outlasts the snapshot. Null when not even the count fits.
 */
export function heatmapBoardCaption(
  board: { topCount: number; fetchedAt: number; regularSessionDate?: string | null },
  { now, checked = null, failed = false, maxWidth = Number.POSITIVE_INFINITY }:
    { now: number; checked?: string | null; failed?: boolean; maxWidth?: number },
): string | null {
  const sessionDate = board.regularSessionDate || null;
  // Display order; `rank` is the order they give way in, highest first.
  const parts: Array<{ text: string; rank: number }> = [{ text: `top ${board.topCount}`, rank: 0 }];
  if (sessionDate) parts.push({ text: `${dayLabel(sessionDate)} session`, rank: 1 });
  if (Number.isFinite(board.fetchedAt) && board.fetchedAt > 0) {
    const { hour, minute } = zonedDateTimeParts(board.fetchedAt, NEW_YORK);
    const clock = `${twoDigits(hour)}:${twoDigits(minute)} ET`;
    const day = zonedDateKey(board.fetchedAt, NEW_YORK);
    const text = `snapshot ${day === (sessionDate ?? zonedDateKey(now, NEW_YORK)) ? clock : `${dayLabel(day)} ${clock}`}`;
    parts.push({ text, rank: failed ? 3 : 2 });
  }
  if (checked) parts.push({ text: `checked ${checked}`, rank: failed ? 2 : 3 });
  const caption = () => parts.map((part) => part.text).join(" · ");
  while (parts.length > 0 && displayWidth(caption()) > maxWidth) {
    const weakest = parts.reduce((found, part, index) => (part.rank > parts[found]!.rank ? index : found), 0);
    parts.splice(weakest, 1);
  }
  return parts.length > 0 ? caption() : null;
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
