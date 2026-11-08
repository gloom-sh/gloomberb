import { apiClient } from "../../../api-client";
import type { HkTender, HkTendersPayload } from "../../../api-client/hk-tenders";
import type { DataTableColumn } from "../../../components";
import { dropColumnsToFit } from "../../../components/ui/table-layout";
import { createPluginCache, savedCopyForTransientFailure } from "../../../data/plugin-cache";
import { servedFromSavedCopy } from "../../../data/saved-copies";
import type { PluginPersistence } from "../../../types/plugin";
import { displayWidth, formatCompact } from "../../../utils/format";
import { compareSortValues, type SortDirection } from "../../../utils/sort-values";
import { AUCTION_HISTORY_ALL, type AuctionHistoryWindow } from "./client";
import type { AuctionFilter } from "./model";

/**
 * Hong Kong government paper tenders in AUCT: Exchange Fund Bills and Notes
 * and HKSAR Institutional Government Bonds, as the Hong Kong Monetary
 * Authority publishes each tender's result, served by Gloom Cloud
 * (`/cloud/econ/hk-tenders`).
 */

export type AuctionMarket = "us" | "hk";

export const AUCTION_MARKETS: ReadonlyArray<{ value: AuctionMarket; label: string }> = [
  { value: "us", label: "US" },
  { value: "hk", label: "HK" },
];

export const isAuctionMarket = (value: unknown): value is AuctionMarket => value === "us" || value === "hk";

/** Words that only pick the market: `AUCT HK 10Y` searches Hong Kong's paper for 10Y. */
const HK_MARKET_WORDS = /\b(hong\s*kong|hk|hkma|hksar)\b/gi;
/** Paper only Hong Kong issues: it picks the market and stays the search. */
const HK_PAPER_WORDS = /\b(efbs?|efns?|exchange\s+fund|hkgbs?|hkd|honia)\b/i;

/**
 * The market a search names, and the search left once the words that only
 * name the market are taken out: `HK 10Y` is Hong Kong's 10-year, `EFB` its
 * bills. Null when it names none, so the market chosen stands.
 */
export function auctionSearchMarket(query: string): { market: AuctionMarket | null; search: string } {
  const named = HK_MARKET_WORDS.test(query);
  HK_MARKET_WORDS.lastIndex = 0;
  const search = named ? query.replace(HK_MARKET_WORDS, " ").replace(/\s+/g, " ").trim() : query.trim();
  return { market: named || HK_PAPER_WORDS.test(query) ? "hk" : null, search };
}

/** The table's short name for each kind of paper, and the detail's long one. */
const PAPER_TYPES: Record<HkTender["paper"], { type: string; name: string; filter: Exclude<AuctionFilter, "all"> }> = {
  efb: { type: "EFB", name: "Exchange Fund Bills", filter: "bill" },
  efn: { type: "EFN", name: "Exchange Fund Notes", filter: "note" },
  hkgb: { type: "HKGB", name: "Government Bond", filter: "bond" },
  "hkgb-frn": { type: "FRN", name: "Government floating rate note", filter: "bond" },
};

export const hkTenderType = (tender: HkTender) => PAPER_TYPES[tender.paper]?.type ?? tender.paper.toUpperCase();
export const hkTenderName = (tender: HkTender) => `${PAPER_TYPES[tender.paper]?.name ?? tender.paper}${tender.currency === "CNH" ? " (RMB)" : ""}`;
/** A tender's row id: one issue is sold once a day. */
export const hkTenderId = (tender: HkTender) => `${tender.tenderDate}|${tender.issue}`;

/** What the search box understands in Hong Kong's tenders. */
export const HK_SEARCH_FIELDS = "paper (EFB, HKGB), tenor (3M, 10Y), issue, stock code, RMB, or date (YYYY-MM-DD)";

const paperWords = (words: readonly string[], papers: readonly HkTender["paper"][]) =>
  words.map((word): [string, ReadonlySet<HkTender["paper"]>] => [word, new Set(papers)]);
const PAPER_WORDS: ReadonlyMap<string, ReadonlySet<HkTender["paper"]>> = new Map([
  ...paperWords(["bill", "bills", "efb", "efbs"], ["efb"]),
  ...paperWords(["note", "notes", "efn", "efns"], ["efn"]),
  ...paperWords(["bond", "bonds", "hkgb", "hkgbs", "government"], ["hkgb", "hkgb-frn"]),
  ...paperWords(["frn", "frns", "floating", "honia"], ["hkgb-frn"]),
]);
const CURRENCY_WORDS: ReadonlyMap<string, HkTender["currency"]> = new Map([["hkd", "HKD"], ["rmb", "CNH"], ["cnh", "CNH"], ["cny", "CNH"]]);
const TENOR = /^(\d{1,2}) ?-? ?(y|yr|yrs|years?|m|mo|mos|months?)$/;

/** "3M" is the 3-Month bill; "1Y" the 12-Month bill as well as a 1-Year note. */
function matchesTenor(tender: HkTender, word: string): boolean | null {
  const tenor = TENOR.exec(word);
  if (!tenor) return null;
  const count = Number(tenor[1]);
  const months = tenor[2]![0] === "y" ? count * 12 : count;
  const own = /^(\d+)-(Month|Year)$/.exec(tender.term);
  return !!own && (own[2] === "Year" ? Number(own[1]) * 12 : Number(own[1])) === months;
}

function matchesWord(tender: HkTender, word: string): boolean {
  const paper = PAPER_WORDS.get(word);
  if (paper) return paper.has(tender.paper);
  if (word === "exchange" || word === "fund") return tender.paper === "efb" || tender.paper === "efn";
  const currency = CURRENCY_WORDS.get(word);
  if (currency) return tender.currency === currency;
  const tenor = matchesTenor(tender, word);
  if (tenor != null) return tenor;
  return tender.tenderDate.startsWith(word) || tender.issue.toLowerCase().includes(word)
    || !!tender.stockCode?.includes(word) || tender.term.toLowerCase().includes(word);
}

/** Every word of the search names the tender (`10Y RMB`, `EFB 2026-11`); words that only pick the market are left out. */
function matchesHkSearch(tender: HkTender, query: string): boolean {
  const words = auctionSearchMarket(query).search.toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((word) => matchesWord(tender, word));
}

/** A floating rate note's spread over HONIA, in bp, stands where another's yield does. */
const spreadBp = (value: number | null) => value == null ? null : Math.round(value * 1000) / 10;

/** The highest accepted yield, or a floating rate note's highest spread in bp. */
export const hkHighest = (tender: HkTender) => tender.highestYield ?? spreadBp(tender.highestSpread);
export const hkAverage = (tender: HkTender) => tender.averageYield ?? spreadBp(tender.averageSpread);
export const isSpread = (tender: HkTender) => tender.highestYield == null && tender.averageYield == null
  && (tender.highestSpread != null || tender.averageSpread != null);

/** `2.840%`, or `26.0bp` for a floating rate note's spread, as a US FRN's reads. */
export function formatHkRate(tender: HkTender, value: number | null, empty: string): string {
  if (value == null) return empty;
  return isSpread(tender) ? `${value.toFixed(1)}bp` : `${value.toFixed(3)}%`;
}

/** The amount in its currency: HK$66.3B, RMB750M. */
export function formatHkAmount(tender: HkTender, value: number | null, empty = "—"): string {
  if (value == null) return empty;
  return `${tender.currency === "CNH" ? "RMB" : "HK$"}${formatCompact(value)}`;
}

export type HkColumnId = "date" | "type" | "term" | "rate" | "average" | "btc" | "size" | "cusip";

export interface HkColumn extends DataTableColumn {
  id: HkColumnId;
}

export interface HkSortPreference {
  columnId: HkColumnId;
  direction: SortDirection;
}

export const DEFAULT_HK_SORT: HkSortPreference = { columnId: "date", direction: "desc" };

/** The order [ and ] step through the columns. */
export const HK_SORT_COLUMN_IDS: readonly HkColumnId[] = ["date", "type", "term", "rate", "average", "btc", "size", "cusip"];

/** `--sort` and the pane's kept sort, by name: the US names that mean the same here, and `average`. */
const HK_SORT_NAMES: ReadonlyArray<{ names: readonly string[]; column: HkColumnId }> = [
  { names: ["date"], column: "date" },
  { names: ["type"], column: "type" },
  { names: ["term"], column: "term" },
  { names: ["rate", "yield", "high", "highest"], column: "rate" },
  { names: ["average", "avg"], column: "average" },
  { names: ["btc", "b/c", "bid-to-cover", "bc"], column: "btc" },
  { names: ["size"], column: "size" },
  { names: ["cusip", "issue"], column: "cusip" },
];

/** The column a sort name means for Hong Kong's tenders; null for a US-only one (`indirect`, `btc-pctl`). */
export function hkSortColumn(name: string): HkColumnId | null {
  const value = name.trim().toLowerCase();
  return HK_SORT_NAMES.find((entry) => entry.names.includes(value))?.column ?? null;
}

export const hkSortName = (column: HkColumnId) => HK_SORT_NAMES.find((entry) => entry.column === column)!.names[0]!;

/** Text columns read best A to Z; every figure highest first. */
export const firstHkSortDirection = (column: HkColumnId): SortDirection =>
  column === "type" || column === "term" || column === "cusip" ? "asc" : "desc";

function hkSortValue(tender: HkTender, column: HkColumnId): number | string | null {
  switch (column) {
    case "date": return tender.tenderDate;
    case "type": return hkTenderType(tender);
    case "term": return tender.days;
    case "rate": return hkHighest(tender);
    case "average": return hkAverage(tender);
    case "btc": return tender.bidToCover;
    case "size": return tender.allotted;
    case "cusip": return tender.issue;
  }
}

/** The tenders a group, a search and a window keep, in the sort's order; ties keep the newest first. */
export function visibleHkTenders(
  tenders: readonly HkTender[],
  options: { filter: AuctionFilter; query: string; sort: HkSortPreference; from?: string | null },
): HkTender[] {
  return tenders
    .filter((tender) => (options.filter === "all" || PAPER_TYPES[tender.paper]?.filter === options.filter)
      && (!options.from || tender.tenderDate >= options.from) && matchesHkSearch(tender, options.query))
    .sort((left, right) => compareSortValues(hkSortValue(left, options.sort.columnId), hkSortValue(right, options.sort.columnId), options.sort.direction)
      || right.tenderDate.localeCompare(left.tenderDate) || left.issue.localeCompare(right.issue));
}

/** The pane's columns, as wide as what they list; the issue closes the row where the pane has room for it. */
export function buildHkColumns(options: { showYear?: boolean; rows?: readonly HkTender[]; width?: number } = {}): HkColumn[] {
  const { showYear = false, rows = [], width } = options;
  const widest = (least: number, text: (tender: HkTender) => string) => Math.max(least, ...rows.map((tender) => displayWidth(text(tender))));
  const columns: HkColumn[] = [
    { id: "date", label: "DATE", width: showYear ? 10 : 6, align: "left" },
    { id: "type", label: "TYPE", width: 4, align: "left" },
    { id: "term", label: "TERM", width: widest(7, (tender) => tender.term), align: "left" },
    { id: "rate", label: "HIGH", width: widest(6, (tender) => formatHkRate(tender, hkHighest(tender), "—")), align: "right",
      title: "Highest accepted yield; a floating rate note's highest spread over HONIA, bp" },
    { id: "average", label: "AVG", width: widest(6, (tender) => formatHkRate(tender, hkAverage(tender), "—")), align: "right",
      title: "Average accepted yield; a floating rate note's average spread over HONIA, bp" },
    { id: "btc", label: "B/C", width: 5, align: "right" },
    { id: "size", label: "SIZE", width: widest(7, (tender) => formatHkAmount(tender, tender.allotted)), align: "right", title: "Amount allotted" },
    { id: "cusip", label: "ISSUE", width: widest(5, (tender) => tender.issue), align: "left", flexGrow: 1 },
  ];
  if (width == null) return columns;
  const shown = dropColumnsToFit(columns, width, ["cusip"]);
  return shown.length === columns.length ? shown : shown.map((column) => ({ ...column, flexGrow: undefined }));
}

/** The first day a window lists: null for ALL. */
export function hkWindowStart(window: AuctionHistoryWindow, now = Date.now()): string | null {
  return window === AUCTION_HISTORY_ALL ? null : new Date(now - window * 86_400_000).toISOString().slice(0, 10);
}

const isDay = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
const isNumberOrNull = (value: unknown) => value === null || typeof value === "number" && Number.isFinite(value);

/** A tender as this app reads it: one without its day, issue, paper or figures as numbers is no tender. */
function readsAsTender(tender: HkTender): boolean {
  return !!tender && isDay(tender.tenderDate) && typeof tender.issue === "string" && !!tender.issue && tender.paper in PAPER_TYPES
    && (tender.currency === "HKD" || tender.currency === "CNH") && typeof tender.term === "string"
    && [tender.allotted, tender.applied, tender.bidToCover, tender.averageYield, tender.highestYield, tender.averageSpread, tender.highestSpread]
      .every(isNumberOrNull);
}

/** The reply's tenders, or an error: a reply that is not the record is no board, never an empty one. */
function readHkTenders(payload: HkTendersPayload): HkTender[] {
  if (!payload || payload.status !== "available" || !Array.isArray(payload.tenders)) {
    throw new Error("Hong Kong tender results are not available yet");
  }
  return payload.tenders.filter(readsAsTender);
}

export interface HkTendersResult {
  tenders: HkTender[];
  fetchedAt: number;
  stale: boolean;
  savedAt?: number;
  refreshError?: string;
}

/** Tender results come out on tender afternoons; the server reads them every two hours. */
const HK_CACHE_POLICY = { staleMs: 60 * 60 * 1000, expireMs: 7 * 24 * 60 * 60 * 1000 } as const;
const hkCache = createPluginCache<HkTender[]>({
  kind: "treasury-auctions",
  source: "hk-tenders",
  schemaVersion: 1,
  policy: HK_CACHE_POLICY,
  decode: (tenders) => {
    if (!Array.isArray(tenders)) throw new Error("Invalid cached tenders");
    return tenders;
  },
});

export function attachHkTendersPersistence(persistence: PluginPersistence): void {
  hkCache.attach(persistence);
}

export function resetHkTendersPersistence(): void {
  hkCache.reset();
}

type HkTendersLoader = (from: string | null) => Promise<HkTendersPayload>;

/** A window's tenders from Gloom Cloud, cached an hour; a saved copy answers a failure asking again may get past. */
export async function loadHkTenders(
  force = false,
  window: AuctionHistoryWindow,
  loader: HkTendersLoader = (from) => apiClient.getCloudHkTenders(from),
): Promise<HkTendersResult> {
  const from = hkWindowStart(window);
  const read = savedCopyForTransientFailure(await hkCache.load(`hk:${window}`, async () => readHkTenders(await loader(from)), { force }));
  const result: HkTendersResult = {
    tenders: read.data,
    fetchedAt: read.fetchedAt,
    stale: read.stale,
    ...(read.refreshError ? { refreshError: read.refreshError } : {}),
  };
  return read.source === "stale-fallback" ? servedFromSavedCopy({ ...result, savedAt: read.fetchedAt }, read.fetchedAt) : result;
}
