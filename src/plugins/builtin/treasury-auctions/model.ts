import type { DataTableColumn } from "../../../components";
import { compareSortValues, type SortDirection } from "../../../utils/sort-values";
import { AUCTION_HISTORY_DAYS } from "./client";
import type { TreasuryAuction } from "./types";

/** Windows the Fiscal Data query supports without paging past MAX_PAGES. */
export const AUCTION_HISTORY_WINDOWS = [30, 90, 120, 365] as const;

/** Pane settings arrive as unvalidated strings, so anything unknown falls back. */
export function auctionHistoryDays(settings: Record<string, unknown> | undefined): number {
  const value = Number(settings?.historyDays);
  return (AUCTION_HISTORY_WINDOWS as readonly number[]).includes(value) ? value : AUCTION_HISTORY_DAYS;
}

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
 * Nominal term ordering, including every component of a reopening term.
 * The day equivalents order the published labels; they are not settlement
 * dates, remaining maturity, or a financial day-count convention.
 */
export function termLengthDays(term: string): number {
  const components = [...term.matchAll(/(\d+)\s*-\s*(Day|Week|Month|Year)/gi)];
  if (!components.length || term.replace(/(\d+)\s*-\s*(Day|Week|Month|Year)/gi, "").trim()) {
    return Number.MAX_SAFE_INTEGER;
  }
  return components.reduce((days, match) => {
    const scale = { day: 1, week: 7, month: 30, year: 365 }[match[2]!.toLowerCase()]!;
    return days + Number(match[1]) * scale;
  }, 0);
}

/**
 * Indirect takedown, as Treasury reports it: a share of competitive accepted,
 * which excludes noncompetitive, FIMA and SOMA add-on awards. Zero indirect
 * bidding is a real, and notable, outcome, so only a missing leg or an
 * unusable total is unknown.
 */
export function indirectPct(auction: TreasuryAuction): number | null {
  if (auction.indirectAccepted == null || !auction.competitiveAccepted) return null;
  return (auction.indirectAccepted / auction.competitiveAccepted) * 100;
}

/**
 * The headline result: bill investment rate, FRN high discount margin, or
 * note/bond/TIPS high yield (a real yield for TIPS).
 */
export function rateValue(auction: TreasuryAuction): number | null {
  if (auction.secType === "FRN") return auction.highDiscountMargin ?? null;
  return auction.highInvestmentRate ?? auction.highYield;
}

/** Treasury's name for the rate rateValue reports; a bill's High Rate is its discount rate. */
export function rateLabel(auction: TreasuryAuction): string {
  if (auction.secType === "FRN") return "High discount margin";
  return FILTER_TYPES.bill.has(auction.secType) ? "Investment rate" : "High yield";
}

/** FRN discount margins read in basis points; every other rate in percent. */
export function formatAuctionRate(auction: TreasuryAuction, value: number | null, empty: string): string {
  if (value == null) return empty;
  return auction.secType === "FRN" ? `${(value * 100).toFixed(1)}bp` : `${value.toFixed(3)}%`;
}

/** Announced auctions appear in the feed days before any results are published. */
export function isPendingAuction(auction: TreasuryAuction): boolean {
  return rateValue(auction) == null && auction.bidToCoverRatio == null;
}

/**
 * The announced offering, for pending and completed auctions alike. Total
 * accepted also counts SOMA add-ons, which would overstate completed sizes.
 */
export function auctionSize(auction: TreasuryAuction): number | null {
  return auction.offeringAmount ?? auction.totalAccepted;
}

function sortValue(auction: TreasuryAuction, columnId: AuctionColumnId): number | string | null {
  switch (columnId) {
    case "date": return auctionDateValue(auction.auctionDate);
    case "type": return auction.secType;
    case "term": {
      const days = termLengthDays(auction.securityTerm);
      return days === Number.MAX_SAFE_INTEGER ? null : days;
    }
    case "rate": return rateValue(auction);
    case "btc": return auction.bidToCoverRatio;
    case "indirect": return indirectPct(auction);
    case "size": return auctionSize(auction);
  }
}

export function visibleAuctions(
  auctions: readonly TreasuryAuction[],
  options: { filter: AuctionFilter; query: string; sort: AuctionSortPreference },
): TreasuryAuction[] {
  return auctions
    .filter((auction) => matchesFilter(auction, options.filter) && matchesAuctionQuery(auction, options.query))
    .sort((left, right) => {
      const leftValue = sortValue(left, options.sort.columnId);
      const rightValue = sortValue(right, options.sort.columnId);
      const comparison = compareSortValues(
        typeof leftValue === "string" ? leftValue.toLowerCase() : leftValue,
        typeof rightValue === "string" ? rightValue.toLowerCase() : rightValue,
        options.sort.direction,
      );
      if (comparison !== 0) return comparison;
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
