import { colors } from "../../theme/colors";
import { formatCompact, formatNumber, formatTimeAgo } from "../../utils/format";
import { compareSortValues } from "../../utils/sort-values";
import type {
  PredictionBrowseTab,
  PredictionCategoryId,
  PredictionColumnDef,
  PredictionListRow,
  PredictionSortPreference,
  PredictionVenueScope,
  PredictionVolumeUnit,
} from "./types";
import { matchesPredictionCategory } from "./categories";

const TEXT_SORT_COLUMNS = new Set([
  "market",
  "target",
  "venue",
  "event",
  "category",
  "status",
  "market_id",
]);

function coerceDateValue(value: string | null | undefined): number | null {
  if (!value) return null;
  const next = new Date(value).getTime();
  return Number.isFinite(next) ? next : null;
}

function formatCompactSigned(
  value: number | null,
  unit: PredictionVolumeUnit,
): string {
  if (value == null) return "—";
  if (unit === "usd") return `$${formatCompact(value)}`;
  return `${formatCompact(value)} ct`;
}

export function formatPredictionProbability(
  value: number | null | undefined,
): string {
  if (value == null) return "—";
  const cents = value * 100;
  if (Math.abs(cents) >= 100 || Math.abs(cents % 1) < 0.05) {
    return `${formatNumber(cents, 0)}c`;
  }
  return `${formatNumber(cents, 1)}c`;
}

export function formatPredictionPercent(
  value: number | null | undefined,
): string {
  if (value == null) return "—";
  const percent = value * 100;
  if (Math.abs(percent) >= 10 || Math.abs(percent % 1) < 0.05) {
    return `${formatNumber(percent, 0)}%`;
  }
  return `${formatNumber(percent, 1)}%`;
}

export function getPredictionProbabilityColor(
  value: number | null | undefined,
): string | undefined {
  if (value == null) return undefined;
  if (Math.abs(value - 0.5) < 0.005) return colors.neutral;
  return value > 0.5 ? colors.positive : colors.negative;
}

export function formatPredictionSpread(
  value: number | null | undefined,
): string {
  if (value == null) return "—";
  return `${formatNumber(value * 100, value * 100 >= 10 ? 0 : 1)}c`;
}

export function formatPredictionMetric(
  value: number | null | undefined,
  unit: PredictionVolumeUnit,
): string {
  return formatCompactSigned(value ?? null, unit);
}

/**
 * One shape per row: a signed countdown inside a week, an absolute date beyond
 * it. A market whose stated close has passed while the venue still reports it
 * open is labelled as such rather than as an age, because "22h ago" next to
 * status OPEN reads as a bug.
 */
export function formatPredictionEndsAt(
  value: string | null | undefined,
  status?: string,
  now = Date.now(),
): string {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  const delta = date.getTime() - now;
  const absMinutes = Math.round(Math.abs(delta) / 60_000);

  if (delta < 0 && status === "open") return "past due";

  if (absMinutes < 7 * 24 * 60) {
    const magnitude = absMinutes < 60
      ? `${absMinutes}m`
      : absMinutes < 24 * 60
        ? `${Math.floor(absMinutes / 60)}h`
        : `${Math.floor(absMinutes / (24 * 60))}d`;
    return delta >= 0 ? `${magnitude} left` : `${magnitude} ago`;
  }

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric",
  });
}

function formatPredictionUpdatedAt(
  value: string | null | undefined,
): string {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return formatTimeAgo(date);
}

function getMarketSortValue(
  row: PredictionListRow,
  columnId: string,
): string | number | null {
  switch (columnId) {
    case "market":
      return row.title.toLowerCase();
    case "target":
      return row.focusMarketLabel.toLowerCase();
    case "venue":
      return row.venue;
    case "yes":
      return row.focusYesPrice;
    case "spread":
      return row.spread;
    case "vol_24h":
      return row.volume24h;
    case "vol_total":
      return row.totalVolume;
    case "open_interest":
      return row.openInterest;
    case "liquidity":
      return row.liquidity;
    case "ends":
      return coerceDateValue(row.endsAt);
    case "updated":
      return coerceDateValue(row.updatedAt);
    case "status":
      return row.status;
    case "event":
      return row.eventLabel.toLowerCase();
    case "category":
      return (row.category ?? "").toLowerCase();
    case "market_id":
      return row.marketId;
    default:
      return null;
  }
}

export function getDefaultPredictionSort(
  browseTab: PredictionBrowseTab,
): PredictionSortPreference {
  switch (browseTab) {
    case "ending":
      return { columnId: "ends", direction: "asc" };
    case "new":
      return { columnId: "updated", direction: "desc" };
    default:
      return { columnId: "vol_24h", direction: "desc" };
  }
}

export function getNextPredictionSort(
  current: PredictionSortPreference,
  columnId: string,
): PredictionSortPreference {
  const initialDirection =
    columnId === "ends" || TEXT_SORT_COLUMNS.has(columnId) ? "asc" : "desc";
  const alternateDirection = initialDirection === "asc" ? "desc" : "asc";

  if (current.columnId !== columnId) {
    return { columnId, direction: initialDirection };
  }
  if (current.direction === initialDirection) {
    return { columnId, direction: alternateDirection };
  }
  return { columnId: null, direction: initialDirection };
}

export function filterPredictionMarkets(
  markets: PredictionListRow[],
  browseTab: PredictionBrowseTab,
  venueScope: PredictionVenueScope,
  categoryId: PredictionCategoryId,
  searchQuery: string,
  watchlist: Set<string>,
): PredictionListRow[] {
  const normalizedQuery = searchQuery.trim().toLowerCase();

  return markets.filter((market) => {
    if (venueScope !== "all" && market.venue !== venueScope) return false;
    if (!matchesPredictionCategory(market, categoryId)) return false;
    if (
      browseTab === "watchlist" &&
      !market.watchMarketKeys.some((marketKey) => watchlist.has(marketKey))
    ) {
      return false;
    }
    if (!normalizedQuery) return true;
    return market.searchText.includes(normalizedQuery);
  });
}

export function sortPredictionMarkets(
  markets: PredictionListRow[],
  sortPreference: PredictionSortPreference,
): PredictionListRow[] {
  if (!sortPreference.columnId) return [...markets];
  const columnId = sortPreference.columnId;
  return markets
    .map((market, index) => ({
      index,
      market,
      sortValue: getMarketSortValue(market, columnId),
    }))
    .sort((left, right) => {
      const leftValue = left.sortValue;
      const rightValue = right.sortValue;

      const comparison = compareSortValues(leftValue, rightValue, sortPreference.direction);

      return comparison === 0
        ? left.index - right.index
        : comparison;
    })
    .map((entry) => entry.market);
}

export function getPredictionColumnValue(
  column: PredictionColumnDef,
  market: PredictionListRow,
  watchlisted: boolean,
): { text: string; color?: string } {
  switch (column.id) {
    case "watch":
      return {
        text: watchlisted ? "★" : "·",
        color: watchlisted ? colors.positive : colors.textDim,
      };
    case "market":
      return {
        text:
          market.kind === "group"
            ? `${market.title} · ${market.marketCount} targets`
            : market.title,
      };
    case "target":
      return { text: market.focusMarketLabel };
    case "venue":
      return { text: market.venue === "polymarket" ? "Polymkt" : "Kalshi" };
    case "yes":
      // Always percentage then outcome label, so the cell never changes shape
      // between grouped and single rows.
      return {
        text: `${formatPredictionPercent(market.focusYesPrice)} ${market.focusMarketLabel}`.trim(),
        color: getPredictionProbabilityColor(market.focusYesPrice),
      };
    case "spread":
      return {
        text:
          market.kind === "group"
            ? formatPredictionSpread(market.representative.spread)
            : formatPredictionSpread(market.spread),
      };
    case "vol_24h":
      return {
        text: formatPredictionMetric(market.volume24h, market.volume24hUnit),
      };
    case "open_interest":
      return {
        text: formatPredictionMetric(
          market.openInterest,
          market.openInterestUnit,
        ),
      };
    case "ends":
      return { text: formatPredictionEndsAt(market.endsAt, market.status) };
    case "status":
      return {
        text: market.status.toUpperCase(),
        color:
          market.status === "open"
            ? colors.positive
            : market.status === "closed"
              ? colors.negative
              : colors.textDim,
      };
    case "event":
      return { text: market.eventLabel };
    case "category":
      return { text: market.category ?? "—" };
    case "vol_total":
      return {
        text: formatPredictionMetric(
          market.totalVolume,
          market.totalVolumeUnit,
        ),
      };
    case "liquidity":
      return {
        text: formatPredictionMetric(market.liquidity, market.liquidityUnit),
      };
    case "updated":
      return { text: formatPredictionUpdatedAt(market.updatedAt) };
    case "market_id":
      return { text: market.marketId };
    default:
      return { text: "—" };
  }
}
