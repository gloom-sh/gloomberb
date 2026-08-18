import type { DataTableColumn } from "../../../components";
import type { SortDirection } from "../../../utils/sort-values";
import type { TreasuryAuction } from "./types";

export type AuctionColumnId = "date" | "type" | "term" | "rate" | "btc" | "indirect" | "size";

export interface AuctionColumn extends DataTableColumn {
  id: AuctionColumnId;
}

export interface AuctionSortPreference {
  columnId: AuctionColumnId;
  direction: SortDirection;
}

export const DEFAULT_AUCTION_SORT: AuctionSortPreference = {
  columnId: "date",
  direction: "desc",
};

export const AUCTION_SORT_COLUMN_IDS: readonly AuctionColumnId[] = [
  "date",
  "type",
  "term",
  "rate",
  "btc",
  "indirect",
  "size",
];

export type AuctionFilter = "all" | "bill" | "note" | "bond";

export const AUCTION_FILTERS: ReadonlyArray<{ value: AuctionFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "bill", label: "Bills" },
  { value: "note", label: "Notes" },
  { value: "bond", label: "Bonds" },
];

// CMBs are cash management bills; FRNs are issued off the 2-year note; TIPS
// are auctioned as notes and bonds but group with the long end here.
const FILTER_TYPES: Record<Exclude<AuctionFilter, "all">, ReadonlySet<string>> = {
  bill: new Set(["Bill", "CMB"]),
  note: new Set(["Note", "FRN"]),
  bond: new Set(["Bond", "TIPS"]),
};

export function matchesFilter(auction: TreasuryAuction, filter: AuctionFilter): boolean {
  return filter === "all" || FILTER_TYPES[filter].has(auction.secType);
}

export function nextFilter(current: AuctionFilter): AuctionFilter {
  const index = AUCTION_FILTERS.findIndex((entry) => entry.value === current);
  return AUCTION_FILTERS[(index + 1) % AUCTION_FILTERS.length]!.value;
}

function matchesAuctionQuery(auction: TreasuryAuction, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return (
    auction.secType.toLowerCase().includes(normalized)
    || auction.securityTerm.toLowerCase().includes(normalized)
    || auction.auctionDate.includes(normalized)
  );
}

function auctionDateValue(value: string): number {
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * Term length in days so "4-Week" sorts before "10-Year" instead of
 * alphabetically. "29-Year 6-Month" only needs its leading unit to order
 * correctly against the rest of the curve.
 */
export function termLengthDays(term: string): number {
  const match = term.match(/^(\d+)\s*-\s*(Day|Week|Month|Year)/i);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const count = Number(match[1]);
  switch (match[2]!.toLowerCase()) {
    case "day": return count;
    case "week": return count * 7;
    case "month": return count * 30;
    default: return count * 365;
  }
}

export function indirectPct(auction: TreasuryAuction): number | null {
  if (!auction.indirectAccepted || !auction.totalAccepted) return null;
  return (auction.indirectAccepted / auction.totalAccepted) * 100;
}

/**
 * The headline rate: Bills and FRNs report a high investment rate, Notes,
 * Bonds, and TIPS report a high yield.
 */
export function rateValue(auction: TreasuryAuction): number | null {
  return auction.highInvestmentRate ?? auction.highYield;
}

/** Announced auctions appear in the feed days before any results are published. */
export function isPendingAuction(auction: TreasuryAuction): boolean {
  return rateValue(auction) == null && auction.bidToCoverRatio == null;
}

export function auctionSize(auction: TreasuryAuction): number | null {
  return auction.totalAccepted ?? auction.offeringAmount;
}

function sortValue(auction: TreasuryAuction, columnId: AuctionColumnId): number | string {
  switch (columnId) {
    case "date": return auctionDateValue(auction.auctionDate);
    case "type": return auction.secType;
    case "term": return termLengthDays(auction.securityTerm);
    case "rate": return rateValue(auction) ?? Number.NEGATIVE_INFINITY;
    case "btc": return auction.bidToCoverRatio ?? Number.NEGATIVE_INFINITY;
    case "indirect": return indirectPct(auction) ?? Number.NEGATIVE_INFINITY;
    case "size": return auctionSize(auction) ?? Number.NEGATIVE_INFINITY;
  }
}

export function visibleAuctions(
  auctions: readonly TreasuryAuction[],
  options: { filter: AuctionFilter; query: string; sort: AuctionSortPreference },
): TreasuryAuction[] {
  const direction = options.sort.direction === "asc" ? 1 : -1;
  return auctions
    .filter((auction) => matchesFilter(auction, options.filter) && matchesAuctionQuery(auction, options.query))
    .sort((left, right) => {
      const leftValue = sortValue(left, options.sort.columnId);
      const rightValue = sortValue(right, options.sort.columnId);
      const comparison = typeof leftValue === "string" && typeof rightValue === "string"
        ? leftValue.localeCompare(rightValue, "en-US", { sensitivity: "base" })
        : Number(leftValue) - Number(rightValue);
      if (comparison !== 0) return comparison * direction;
      // Ties keep the newest auction on top regardless of sort direction.
      return auctionDateValue(right.auctionDate) - auctionDateValue(left.auctionDate);
    });
}

export function nextAuctionSort(
  current: AuctionSortPreference,
  columnId: AuctionColumnId,
): AuctionSortPreference {
  if (current.columnId === columnId) {
    const direction: SortDirection = current.direction === "asc" ? "desc" : "asc";
    return { columnId, direction };
  }
  // Text columns read best ascending; every metric reads best highest-first.
  return { columnId, direction: columnId === "type" || columnId === "term" ? "asc" : "desc" };
}

export function buildAuctionColumns(width: number): AuctionColumn[] {
  const dateWidth = 8;
  const typeWidth = 6;
  const rateWidth = 8;
  const btcWidth = 6;
  const indirectWidth = 9;
  const sizeWidth = 8;
  const termWidth = Math.max(
    10,
    width - dateWidth - typeWidth - rateWidth - btcWidth - indirectWidth - sizeWidth - 8,
  );
  return [
    { id: "date", label: "DATE", width: dateWidth, align: "left" },
    { id: "type", label: "TYPE", width: typeWidth, align: "left" },
    { id: "term", label: "TERM", width: termWidth, align: "left" },
    { id: "rate", label: "RATE", width: rateWidth, align: "right" },
    { id: "btc", label: "B/C", width: btcWidth, align: "right" },
    { id: "indirect", label: "INDIRECT", width: indirectWidth, align: "right" },
    { id: "size", label: "SIZE", width: sizeWidth, align: "right" },
  ];
}
