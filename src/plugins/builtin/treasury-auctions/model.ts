import type { DataTableColumn } from "../../../components";
import { compareSortValues, type SortDirection } from "../../../utils/sort-values";
import { AUCTION_HISTORY_DAYS } from "./client";
import type { TreasuryAuction } from "./types";

/**
 * History windows in days, ascending: 30 days to 10 years. Fiscal Data keeps
 * auctions back to 1979, so these are our cap, and each one is walked as a
 * paged query that stays inside the client's page bound.
 */
export const AUCTION_HISTORY_WINDOWS = [30, 90, 120, 365, 1825, 3650] as const;

const AUCTION_HISTORY_LABELS: Record<number, { label: string; phrase: string }> = {
  30: { label: "30 days", phrase: "the last 30 days" },
  90: { label: "90 days", phrase: "the last 90 days" },
  120: { label: "120 days", phrase: "the last 120 days" },
  365: { label: "1 year", phrase: "the last year" },
  1825: { label: "5 years", phrase: "the last 5 years" },
  3650: { label: "10 years", phrase: "the last 10 years" },
};

/** The window as the settings menu names it: "120 days", "5 years". */
export function auctionHistoryLabel(days: number): string {
  return AUCTION_HISTORY_LABELS[days]?.label ?? `${days} days`;
}

/** The window inside a sentence: "the last 120 days", "the last 5 years". */
export function auctionHistoryPhrase(days: number): string {
  return AUCTION_HISTORY_LABELS[days]?.phrase ?? `the last ${days} days`;
}

/** The next longer window, or null when this one is already the longest. */
export function nextAuctionHistoryWindow(days: number): number | null {
  return AUCTION_HISTORY_WINDOWS.find((window) => window > days) ?? null;
}

/** Pane settings arrive as unvalidated strings, so anything unknown falls back. */
export function auctionHistoryDays(settings: Record<string, unknown> | undefined): number {
  const value = Number(settings?.historyDays);
  return (AUCTION_HISTORY_WINDOWS as readonly number[]).includes(value) ? value : AUCTION_HISTORY_DAYS;
}

/** What the search box understands, for empty results and the box's own prompt. */
export const AUCTION_SEARCH_FIELDS = "type, benchmark (10Y), term, CUSIP, or date (YYYY-MM-DD)";

export type AuctionColumnId =
  | "date" | "type" | "term" | "rate" | "stopOut" | "btc" | "indirect" | "direct" | "dealer" | "size";

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
  "stopOut",
  "btc",
  "indirect",
  "direct",
  "dealer",
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

type TermUnit = "year" | "month" | "week" | "day";
type TermParts = Partial<Record<TermUnit, number>>;

/** "29-Year 10-Month" as { year: 29, month: 10 }; null for a term this does not recognize. */
function termParts(term: string): TermParts | null {
  const pattern = /(\d+)\s*-\s*(Day|Week|Month|Year)/gi;
  const components = [...term.matchAll(pattern)];
  if (!components.length || term.replace(pattern, "").trim()) return null;
  const parts: TermParts = {};
  for (const match of components) {
    const unit = match[2]!.toLowerCase() as TermUnit;
    parts[unit] = (parts[unit] ?? 0) + Number(match[1]);
  }
  return parts;
}

interface Benchmark {
  unit: TermUnit;
  count: number;
}

/**
 * The benchmark an auction was sold as. Treasury reopens a security with the
 * term it has left, a month or two after issue: the 10-year note comes back as
 * 9-Year 10-Month, the 30-year bond as 29-Year 10-Month, the 2-year FRN as
 * 1-Year 11-Month. Any term with a year part therefore rounds up to the next
 * whole year; a bill or CMB term (weeks, days) is its own benchmark. The term
 * at auction is what the market calls the auction, so a 5-year auction that
 * reopens an older 7-year note is still the 5Y.
 */
function auctionBenchmark(term: string): Benchmark | null {
  const parts = termParts(term);
  if (!parts) return null;
  if (parts.year) {
    return { unit: "year", count: parts.year + (parts.month || parts.week || parts.day ? 1 : 0) };
  }
  const units = Object.keys(parts) as TermUnit[];
  return units.length === 1 ? { unit: units[0]!, count: parts[units[0]!]! } : null;
}

const BENCHMARK_QUERY = /^(\d{1,3}) ?-? ?(y|yr|yrs|years?|m|mo|mos|months?|w|wk|wks|weeks?|d|days?)$/;

/** "10Y", "10yr", "10-year" and "10 year" all name the 10-year benchmark. */
function parseBenchmarkQuery(query: string): Benchmark | null {
  const match = BENCHMARK_QUERY.exec(query);
  if (!match) return null;
  const unit: TermUnit = match[2]![0] === "y" ? "year" : match[2]![0] === "m" ? "month" : match[2]![0] === "w" ? "week" : "day";
  return { unit, count: Number(match[1]) };
}

/**
 * Words that name a security type. A benchmark search leaves TIPS and FRNs
 * out, because "10Y" means the 10-year note and a 10-year TIPS or the FRN that
 * reopens as 1-Year 11-Month would bury it; "10Y TIPS" asks for them.
 */
const TYPE_WORDS: ReadonlyMap<string, string> = new Map([
  ["bill", "bill"], ["bills", "bill"], ["note", "note"], ["notes", "note"], ["bond", "bond"], ["bonds", "bond"],
  ["tips", "tips"], ["frn", "frn"], ["frns", "frn"], ["cmb", "cmb"], ["cmbs", "cmb"],
]);

/** A partial CUSIP: four or more letters and digits with a digit, so "bill" or "2y" never read as one. */
function isCusipQuery(query: string): boolean {
  return /^[a-z0-9]{4,9}$/.test(query) && /\d/.test(query);
}

function matchesQueryText(auction: TreasuryAuction, text: string, typeNamed: boolean): boolean {
  const benchmark = parseBenchmarkQuery(text);
  if (benchmark) {
    if (!typeNamed && (auction.secType === "TIPS" || auction.secType === "FRN")) return false;
    // The benchmark it was sold as ("10Y" finds 9-Year 10-Month) or a part of
    // its term as written ("9-year" finds the same reopening, "10-month" too).
    const own = auctionBenchmark(auction.securityTerm);
    const parts = termParts(auction.securityTerm);
    return (own?.unit === benchmark.unit && own.count === benchmark.count) || parts?.[benchmark.unit] === benchmark.count;
  }
  return (
    auction.secType.toLowerCase().includes(text)
    || auction.securityTerm.toLowerCase().includes(text)
    || auction.auctionDate.includes(text)
    || (isCusipQuery(text) && !!auction.cusip?.toLowerCase().includes(text))
  );
}

function matchesAuctionQuery(auction: TreasuryAuction, query: string): boolean {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return true;
  if (matchesQueryText(auction, normalized, false)) return true;
  // "10Y TIPS" or "tips 10-year": a type word plus the rest of the search.
  const words = normalized.split(" ");
  const typeIndex = words.findIndex((word) => TYPE_WORDS.has(word));
  if (typeIndex < 0 || auction.secType.toLowerCase() !== TYPE_WORDS.get(words[typeIndex]!)) return false;
  const rest = words.filter((_, index) => index !== typeIndex).join(" ");
  return !rest || matchesQueryText(auction, rest, true);
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

/** A bidder class's accepted dollars as a share of competitive accepted, which excludes noncompetitive, FIMA and SOMA add-on awards. */
function competitiveSharePct(accepted: number | null, auction: TreasuryAuction): number | null {
  if (accepted == null || !auction.competitiveAccepted) return null;
  return (accepted / auction.competitiveAccepted) * 100;
}

/**
 * Indirect takedown, as Treasury reports it: a share of competitive accepted.
 * Zero indirect bidding is a real, and notable, outcome, so only a missing leg
 * or an unusable total is unknown.
 */
export function indirectPct(auction: TreasuryAuction): number | null {
  return competitiveSharePct(auction.indirectAccepted, auction);
}

/** Direct takedown, on the same denominator as indirectPct. */
export function directPct(auction: TreasuryAuction): number | null {
  return competitiveSharePct(auction.directAccepted, auction);
}

/** Primary dealer takedown, on the same denominator as indirectPct. */
export function dealerPct(auction: TreasuryAuction): number | null {
  return competitiveSharePct(auction.primaryDealerAccepted, auction);
}

/**
 * The stop-out (high yield) minus the average/median yield Treasury publishes
 * for the same auction, in basis points; a wider gap means the last dollars
 * had to clear well above where most of the auction priced. Bills compare
 * discount rates, which is how they trade. FRNs and auctions missing either
 * leg are null.
 *
 * This is not a tail: a tail is the stop-out against the 1 pm when-issued
 * yield, which the source does not carry.
 */
export function stopOutVsAverageBp(auction: TreasuryAuction): number | null {
  if (auction.secType === "FRN") return null;
  const bill = FILTER_TYPES.bill.has(auction.secType);
  const high = bill ? auction.highDiscountRate : auction.highYield;
  const average = bill ? auction.avgMedDiscountRate : auction.avgMedYield;
  if (high == null || average == null) return null;
  // Rates arrive to three decimals, so hundredths of a basis point only hide float noise.
  return Math.round((high - average) * 100 * 100) / 100;
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

/**
 * What a rate needs beside its number to be read right: a TIPS yield is a real
 * yield, and an FRN's figure is a spread over the 13-week bill index, not a yield.
 */
export function rateQualifier(auction: TreasuryAuction): "real" | "spread" | null {
  return auction.secType === "TIPS" ? "real" : auction.secType === "FRN" ? "spread" : null;
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
    case "stopOut": return stopOutVsAverageBp(auction);
    case "btc": return auction.bidToCoverRatio;
    case "indirect": return indirectPct(auction);
    case "direct": return directPct(auction);
    case "dealer": return dealerPct(auction);
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

/** Text columns read best ascending; every metric reads best highest-first. */
export function firstAuctionSortDirection(columnId: AuctionColumnId): SortDirection {
  return columnId === "type" || columnId === "term" ? "asc" : "desc";
}

/**
 * "Oct 13" is ambiguous once a window spans years, so a window past a year
 * dates its rows in full (2026-10-13), the way the search takes a date.
 */
export function auctionDatesShowYear(historyDays: number): boolean {
  return historyDays > 365;
}

/**
 * Widths are the data's own; the table widens a column to its label plus the
 * sort arrow. All ten columns then take 93 cells. TERM takes the spare width
 * but never less than the longest term ("29-Year 10-Month"), so a narrower
 * pane scrolls sideways instead of clipping it.
 */
export function buildAuctionColumns(showYear = false): AuctionColumn[] {
  return [
    { id: "date", label: "DATE", width: showYear ? 10 : 6, align: "left" },
    { id: "type", label: "TYPE", width: 6, align: "left" },
    { id: "term", label: "TERM", width: 16, align: "left", flexGrow: 1 },
    { id: "rate", label: "RATE", width: 7, align: "right" },
    { id: "stopOut", label: "VS AVG", width: 7, align: "right" },
    { id: "btc", label: "B/C", width: 5, align: "right" },
    { id: "indirect", label: "INDIRECT", width: 8, align: "right" },
    { id: "direct", label: "DIRECT", width: 6, align: "right" },
    { id: "dealer", label: "DEALER", width: 6, align: "right" },
    { id: "size", label: "SIZE", width: 7, align: "right" },
  ];
}
