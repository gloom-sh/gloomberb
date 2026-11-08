import type { DataTableColumn } from "../../../components";
import { dropColumnsToFit } from "../../../components/ui/table-layout";
import { displayWidth } from "../../../utils/format";
import { compareSortValues, type SortDirection } from "../../../utils/sort-values";
import { AUCTION_HISTORY_ALL, AUCTION_HISTORY_DAYS, AUCTION_HISTORY_START, type AuctionHistoryWindow } from "./client";
import type { TreasuryAuction } from "./types";
import { auctionSearchMarket, isAuctionMarket, type AuctionMarket } from "./hk";

/**
 * History windows, shortest first: 30 days to 10 years in days, then ALL,
 * every auction Fiscal Data holds back to 1979-10-31. Each is walked as a
 * paged query that stays inside the client's page bound.
 */
export const AUCTION_HISTORY_WINDOWS: readonly AuctionHistoryWindow[] = [30, 90, 120, 365, 1825, 3650, AUCTION_HISTORY_ALL];

const AUCTION_HISTORY_LABELS: Record<string, { label: string; phrase: string }> = {
  30: { label: "30 days", phrase: "the last 30 days" },
  90: { label: "90 days", phrase: "the last 90 days" },
  120: { label: "120 days", phrase: "the last 120 days" },
  365: { label: "1 year", phrase: "the last year" },
  1825: { label: "5 years", phrase: "the last 5 years" },
  3650: { label: "10 years", phrase: "the last 10 years" },
  [AUCTION_HISTORY_ALL]: { label: `All, since ${AUCTION_HISTORY_START.slice(0, 4)}`, phrase: `every auction since ${AUCTION_HISTORY_START}` },
};

/** The window as the settings menu names it: "120 days", "5 years"; the default says so. */
export function auctionHistoryLabel(window: AuctionHistoryWindow): string {
  const label = AUCTION_HISTORY_LABELS[window]?.label ?? `${window} days`;
  return window === AUCTION_HISTORY_DAYS ? `${label} (default)` : label;
}

/** The window inside a sentence: "the last 120 days", "the last 5 years". */
export function auctionHistoryPhrase(window: AuctionHistoryWindow): string {
  return AUCTION_HISTORY_LABELS[window]?.phrase ?? `the last ${window} days`;
}

/** The next longer window, or null when this one is already the longest. */
export function nextAuctionHistoryWindow(window: AuctionHistoryWindow): AuctionHistoryWindow | null {
  if (window === AUCTION_HISTORY_ALL) return null;
  return AUCTION_HISTORY_WINDOWS.find((next) => next === AUCTION_HISTORY_ALL || next > window) ?? null;
}

/** Pane settings arrive as unvalidated strings, so anything unknown falls back. */
export function auctionHistoryWindow(settings: Record<string, unknown> | undefined): AuctionHistoryWindow {
  const raw = settings?.historyDays;
  if (typeof raw === "string" && raw.trim().toLowerCase() === AUCTION_HISTORY_ALL) return AUCTION_HISTORY_ALL;
  const value = Number(raw);
  return AUCTION_HISTORY_WINDOWS.includes(value) ? value : AUCTION_HISTORY_DAYS;
}

/** What the search box understands, for empty results and the box's own prompt. */
export const AUCTION_SEARCH_FIELDS = "type, benchmark (10Y), term, CUSIP, or date (YYYY-MM-DD)";

export type AuctionColumnId =
  | "date" | "type" | "term" | "rate" | "stopOut" | "btc" | "indirect" | "direct" | "dealer" | "size" | "cusip"
  | "btcPctl" | "indirectPctl" | "dealerPctl" | "after1d" | "after5d" | "after20d";

/** What the after view adds to a row: its percentiles and the yield's moves after it (after.ts). */
export interface AuctionAfterFigures {
  btcPercentile: number | null;
  indirectPercentile: number | null;
  dealerPercentile: number | null;
  after1d: number | null;
  after5d: number | null;
  after20d: number | null;
}

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
  "cusip",
];

/** The after view's columns, in the order [ and ] step through them. */
export const AUCTION_AFTER_SORT_COLUMN_IDS: readonly AuctionColumnId[] = [
  "date", "type", "term", "rate", "btc", "btcPctl", "indirectPctl", "dealerPctl", "after1d", "after5d", "after20d", "cusip",
];

/** `--sort` as typed, and the column it sorts. */
export const AUCTION_SORT_NAMES: ReadonlyArray<{ value: string; column: AuctionColumnId; aliases?: string[] }> = [
  { value: "date", column: "date" },
  { value: "type", column: "type" },
  { value: "term", column: "term" },
  { value: "rate", column: "rate", aliases: ["yield"] },
  { value: "vs-median", column: "stopOut", aliases: ["vs-med", "vs-average", "vs-avg", "stop-out", "stopout"] },
  { value: "btc", column: "btc", aliases: ["b/c", "bid-to-cover", "bc"] },
  { value: "indirect", column: "indirect" },
  { value: "direct", column: "direct" },
  { value: "dealer", column: "dealer" },
  { value: "size", column: "size" },
  { value: "cusip", column: "cusip", aliases: ["issue"] },
  { value: "btc-pctl", column: "btcPctl", aliases: ["btc-percentile", "bc-pctl"] },
  { value: "indirect-pctl", column: "indirectPctl", aliases: ["indirect-percentile"] },
  { value: "dealer-pctl", column: "dealerPctl", aliases: ["dealer-percentile"] },
  { value: "1d", column: "after1d", aliases: ["after-1d", "+1d"] },
  { value: "5d", column: "after5d", aliases: ["after-5d", "+5d"] },
  { value: "20d", column: "after20d", aliases: ["after-20d", "+20d"] },
];

/** The after view's columns are its own; the results view's sort by its own. */
export const isAfterColumn = (column: AuctionColumnId) =>
  column === "btcPctl" || column === "indirectPctl" || column === "dealerPctl" || column === "after1d" || column === "after5d" || column === "after20d";

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
export function auctionBenchmark(term: string): Benchmark | null {
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
 * Treasury has sold every note, bond and bill at a single price since November
 * 1998, and publishes the median accepted bid in its average/median field.
 * Before, most auctions were multiple-price and the field is the average.
 */
const SINGLE_PRICE_FROM = "1998-11-01";

/** Whether an auction's average/median figure is the median (single-price) rather than the average. */
export const publishesMedian = (auction: Pick<TreasuryAuction, "auctionDate">) => auction.auctionDate >= SINGLE_PRICE_FROM;

/** The detail's name for the stop-out spread: against the median, or the average before November 1998. */
export const stopOutLabel = (auction: TreasuryAuction) => publishesMedian(auction) ? "Stop-out vs median" : "Stop-out vs average";

/** The detail's name for the middle figure itself: "Median yield", "Average discount rate". */
export function middleRateLabel(auction: TreasuryAuction, rate: "yield" | "discount rate"): string {
  return `${publishesMedian(auction) ? "Median" : "Average"} ${rate}`;
}

/**
 * The stop-out column's heading for a list: VS MED when every row is from
 * November 1998 on, VS AVG when every row is older, both when it spans the change.
 */
export function stopOutColumnLabel(auctions: readonly TreasuryAuction[], style: "pane" | "report"): string {
  const median = auctions.some(publishesMedian);
  const average = auctions.some((auction) => !publishesMedian(auction));
  const which = median && average ? ["AVG/MED", "average/median"] : average ? ["AVG", "average"] : ["MED", "median"];
  return style === "pane" ? `VS ${which[0]}` : `Stop-out vs ${which[1]} (bp)`;
}

/**
 * The stop-out (high yield) minus the median yield Treasury publishes for the
 * same auction (the average before November 1998: publishesMedian), in basis
 * points; a wider gap means the last dollars had to clear well above where
 * most of the auction priced. Bills compare discount rates, which is how they
 * trade. FRNs and auctions missing either leg are null.
 *
 * This is not a tail: a tail is the stop-out against the 1 pm when-issued
 * yield, which the source does not carry.
 */
export function stopOutVsAvgBp(auction: TreasuryAuction): number | null {
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
  return isBill(auction) ? "Investment rate" : "High yield";
}

/** A bill or cash management bill: its headline rate is the investment rate, and it trades on its discount rate. */
export const isBill = (auction: TreasuryAuction) => FILTER_TYPES.bill.has(auction.secType);

/** The rate column's heading: a board of bills says its rate is the investment rate Treasury states beside the discount rate. */
export function rateColumnLabel(auctions: readonly TreasuryAuction[], style: "pane" | "report"): string {
  const bills = auctions.length > 0 && auctions.every(isBill);
  return style === "pane" ? bills ? "INV RATE" : "RATE" : bills ? "Investment rate" : "Rate";
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

/**
 * Announced auctions appear in the feed days before any results are published.
 * An early bill whose investment rate was blanked (inClearingOrder) still has
 * its discount rates, so it is a result, not an announcement.
 */
export function isPendingAuction(auction: TreasuryAuction): boolean {
  return rateValue(auction) == null && auction.bidToCoverRatio == null
    && auction.highDiscountRate == null && auction.avgMedDiscountRate == null && auction.avgMedYield == null;
}

/**
 * One board from Fiscal Data's auctions and TreasuryDirect's. An auction in
 * both (same CUSIP and day) is one row, the one with its results: Fiscal Data
 * posts a day's auctions as announced and fills the results in later, or not
 * at all while it lags, and TreasuryDirect has them within minutes. When both
 * have them, or neither does, the Fiscal Data row stays, as it was before
 * TreasuryDirect was read. An auction only TreasuryDirect lists is added, from
 * `from` (an ISO date) on: it reads further back than a short window shows.
 */
export function mergeAuctionSources(
  fiscal: readonly TreasuryAuction[],
  direct: readonly TreasuryAuction[],
  from: string,
): TreasuryAuction[] {
  const supplement = new Map(direct.filter((auction) => auction.auctionDate >= from).map((auction) => [auction.id, auction]));
  const merged = fiscal.map((auction) => {
    const other = supplement.get(auction.id);
    supplement.delete(auction.id);
    return other && isPendingAuction(auction) && !isPendingAuction(other) ? other : auction;
  });
  return [...merged, ...supplement.values()];
}

/**
 * The announced offering, for pending and completed auctions alike. Total
 * accepted also counts SOMA add-ons, which would overstate completed sizes.
 */
export function auctionSize(auction: TreasuryAuction): number | null {
  return auction.offeringAmount ?? auction.totalAccepted;
}

function sortValue(auction: TreasuryAuction, columnId: AuctionColumnId, after?: AuctionAfterFigures): number | string | null {
  switch (columnId) {
    case "date": return auctionDateValue(auction.auctionDate);
    case "type": return auction.secType;
    case "term": {
      const days = termLengthDays(auction.securityTerm);
      return days === Number.MAX_SAFE_INTEGER ? null : days;
    }
    case "rate": return rateValue(auction);
    case "stopOut": return stopOutVsAvgBp(auction);
    case "btc": return auction.bidToCoverRatio;
    case "indirect": return indirectPct(auction);
    case "direct": return directPct(auction);
    case "dealer": return dealerPct(auction);
    case "size": return auctionSize(auction);
    case "cusip": return auction.cusip;
    case "btcPctl": return after?.btcPercentile ?? null;
    case "indirectPctl": return after?.indirectPercentile ?? null;
    case "dealerPctl": return after?.dealerPercentile ?? null;
    case "after1d": return after?.after1d ?? null;
    case "after5d": return after?.after5d ?? null;
    case "after20d": return after?.after20d ?? null;
  }
}

export function visibleAuctions(
  auctions: readonly TreasuryAuction[],
  options: { filter: AuctionFilter; query: string; sort: AuctionSortPreference; after?: ReadonlyMap<string, AuctionAfterFigures>; from?: string },
): TreasuryAuction[] {
  return auctions
    .filter((auction) => matchesFilter(auction, options.filter) && matchesAuctionQuery(auction, options.query)
      && (!options.from || auction.auctionDate >= options.from))
    .sort((left, right) => {
      const leftValue = sortValue(left, options.sort.columnId, options.after?.get(left.id));
      const rightValue = sortValue(right, options.sort.columnId, options.after?.get(right.id));
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
  return columnId === "type" || columnId === "term" || columnId === "cusip" ? "asc" : "desc";
}

/**
 * "Oct 13" is ambiguous once a window spans years, so a window past a year
 * dates its rows in full (2026-10-13), the way the search takes a date.
 */
export function auctionDatesShowYear(window: AuctionHistoryWindow): boolean {
  return window === AUCTION_HISTORY_ALL || window > 365;
}

/**
 * Widths are the data's own; the table widens a column to its label plus the
 * sort arrow. TERM is as wide as the longest term listed, and the CUSIP closes
 * the row where the pane has room for it, taking what width is left; a pane
 * too narrow for the rest scrolls sideways instead of clipping a figure.
 */
export function buildAuctionColumns(options: {
  showYear?: boolean;
  view?: "results" | "after";
  rows?: readonly TreasuryAuction[];
  /** The table's width; without one every column is listed. */
  width?: number;
} = {}): AuctionColumn[] {
  const { showYear = false, view = "results", rows = [], width } = options;
  const term = Math.max(6, ...rows.map((auction) => displayWidth(auction.securityTerm)));
  const lead: AuctionColumn[] = [
    { id: "date", label: "DATE", width: showYear ? 10 : 6, align: "left" },
    { id: "type", label: "TYPE", width: 6, align: "left" },
    { id: "term", label: "TERM", width: term, align: "left" },
    { id: "rate", label: rateColumnLabel(rows, "pane"), width: 7, align: "right" },
  ];
  const figures: AuctionColumn[] = view === "after" ? [
    { id: "btc", label: "B/C", width: 5, align: "right" },
    { id: "btcPctl", label: "B/C PCTL", width: 4, align: "right", title: "Bid-to-cover percentile against the tenor's last 24 auctions" },
    { id: "indirectPctl", label: "IND PCTL", width: 4, align: "right", title: "Indirect share percentile against the tenor's last 24 auctions" },
    { id: "dealerPctl", label: "DLR PCTL", width: 4, align: "right", title: "Dealer share percentile against the tenor's last 24 auctions" },
    { id: "after1d", label: "+1D BP", width: 5, align: "right", title: "Treasury yield change one session after the auction, bp" },
    { id: "after5d", label: "+5D BP", width: 5, align: "right", title: "Treasury yield change five sessions after the auction, bp" },
    { id: "after20d", label: "+20D BP", width: 5, align: "right", title: "Treasury yield change twenty sessions after the auction, bp" },
  ] : [
    { id: "stopOut", label: stopOutColumnLabel(rows, "pane"), width: 7, align: "right", title: "Stop-out vs median yield (average before November 1998), bp" },
    { id: "btc", label: "B/C", width: 5, align: "right" },
    { id: "indirect", label: "INDIRECT", width: 8, align: "right" },
    { id: "direct", label: "DIRECT", width: 6, align: "right" },
    { id: "dealer", label: "DEALER", width: 6, align: "right" },
    { id: "size", label: "SIZE", width: 7, align: "right" },
  ];
  const columns: AuctionColumn[] = [...lead, ...figures, { id: "cusip", label: "CUSIP", width: 9, align: "left", flexGrow: 1 }];
  if (width == null) return columns;
  const shown = dropColumnsToFit(columns, width, ["cusip"]);
  // Without the CUSIP nothing grows: the figures keep their places at the left.
  return shown.length === columns.length ? shown : shown.map((column) => ({ ...column, flexGrow: undefined }));
}

/**
 * What `AUCT 10Y --history-days 3650` asks of the pane, typed in the command
 * bar as it is to `fn AUCT`: the search, and the window, market, group, view
 * and sort given as flags (`--history-days`, `--historyDays` or `--history`;
 * `--market`, `--filter`, `--view`, `--sort`), each as `--flag value` or
 * `--flag=value`. A flag whose value is not one of its own is left out; a
 * search naming Hong Kong (`HK 10Y`) picks its market and keeps the rest.
 */
function parseAuctionCommandArg(arg: string | undefined): {
  search: string;
  market?: AuctionMarket;
  historyDays?: AuctionHistoryWindow;
  filter?: AuctionFilter;
  view?: "results" | "after";
  /** The sort's name as `--sort` takes it: "btc-pctl". */
  sort?: string;
} {
  const tokens = (arg ?? "").trim().split(/\s+/).filter(Boolean);
  const words: string[] = [];
  const parsed: ReturnType<typeof parseAuctionCommandArg> = { search: "" };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const flag = /^--([a-z-]+)(?:=(.*))?$/i.exec(token);
    if (!flag) {
      words.push(token);
      continue;
    }
    const name = flag[1]!.toLowerCase().replace(/-/g, "");
    const value = (flag[2] ?? tokens[++index] ?? "").toLowerCase();
    if (name === "historydays" || name === "history") {
      const window = auctionHistoryWindow({ historyDays: value });
      if (value === AUCTION_HISTORY_ALL || String(window) === value) parsed.historyDays = window;
    } else if (name === "market") {
      if (isAuctionMarket(value)) parsed.market = value;
    } else if (name === "filter") {
      const filter = AUCTION_FILTERS.find((entry) => entry.value === value)?.value;
      if (filter) parsed.filter = filter;
    } else if (name === "view") {
      if (value === "results" || value === "after") parsed.view = value;
    } else if (name === "sort") {
      const sort = auctionSortColumn(value);
      const name = sort && AUCTION_SORT_NAMES.find((entry) => entry.column === sort)?.value;
      if (name) parsed.sort = name;
    }
  }
  // A search naming Hong Kong's paper picks its market unless --market names one.
  const named = auctionSearchMarket(words.join(" "));
  parsed.market ??= named.market ?? undefined;
  parsed.search = parsed.market === "hk" ? named.search : words.join(" ").trim();
  return parsed;
}

/**
 * What `AUCT <arg>` asks of the pane: the search and every view key, defaults
 * included, since an open pane merges a command's params into its own; a plain
 * `AUCT 10Y` after `AUCT 7Y --view after --sort 5d --filter note` opens on
 * results, newest first, all types. A window is a setting, sent when named.
 */
export function auctionCommandRequest(arg: string | undefined): {
  params: Record<string, string>;
  settings: Record<string, string> | null;
} {
  const { search, market, historyDays, filter, view, sort } = parseAuctionCommandArg(arg);
  return {
    params: { search, auctionMarket: market ?? "us", auctionView: view ?? "results", auctionSort: sort ?? "date", auctionFilter: filter ?? "all" },
    settings: historyDays != null ? { historyDays: String(historyDays) } : null,
  };
}

/** The column `--sort` names, by its name or an alias; null for anything else. */
export function auctionSortColumn(value: string): AuctionColumnId | null {
  const name = value.trim().toLowerCase();
  return AUCTION_SORT_NAMES.find((entry) => entry.value === name || entry.aliases?.includes(name))?.column ?? null;
}

/** A query for a market AUCT does not cover: another country's government paper. */
const NON_US_PAPER = /\b(jgb|jgbs|gilt|gilts|bund|bunds|bobl|schatz|oat|oats|btp|btps|bono|bonos|acgb|cgb|cgbs|ktb|ktbs|sgs|btf|euro|eur|gbp|jpy|uk|japan|japanese|german|germany|france|french|italy|italian|spain|canada|canadian|australia|australian|china|chinese|korea|singapore|india|indian|brazil|mexico)\b/i;

/** Whether a search names another market's government paper, which AUCT does not list. */
export function namesOtherMarket(query: string): boolean {
  return NON_US_PAPER.test(query.trim());
}

/** A whole CUSIP: nine letters and digits with a digit. */
const isWholeCusip = (query: string) => /^[a-z0-9]{9}$/i.test(query.trim()) && /\d/.test(query);

/**
 * Whether a longer window could list more rows for this search: not with
 * every auction already read, not for another market's paper, not for a
 * CUSIP whose first auction is listed (its reopenings come after it), and not
 * for a date inside the window.
 */
export function widerWindowCouldAdd(query: string, rows: readonly TreasuryAuction[], window: AuctionHistoryWindow, now = Date.now()): boolean {
  if (window === AUCTION_HISTORY_ALL) return false;
  const text = query.trim();
  if (!text) return true;
  if (namesOtherMarket(text)) return false;
  const from = new Date(now - window * 86_400_000).toISOString().slice(0, 10);
  const date = /\b(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?\b/.exec(text);
  if (date && !parseBenchmarkQuery(text.toLowerCase())) {
    // The latest day the search can mean: a year's last day, a month's last day, the day itself.
    const latest = date[3] ? date[0] : date[2] ? `${date[1]}-${date[2]}-31` : `${date[1]}-12-31`;
    return latest < from;
  }
  if (isWholeCusip(text)) {
    // A note or bond reopening's term has a month part (9-Year 10-Month); its first auction's is whole (10-Year).
    // A bill's term is whole either way: a 13-week bill can reopen a 26-week CUSIP, so a bill is never known first.
    const first = rows.some((auction) => {
      const parts = termParts(auction.securityTerm);
      return !isBill(auction) && !!parts && Object.keys(parts).length === 1;
    });
    return !first;
  }
  return true;
}
