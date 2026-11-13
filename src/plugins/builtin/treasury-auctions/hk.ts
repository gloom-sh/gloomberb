import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { HkTender, HkTendersPayload } from "../../../api-client/hk-tenders";
import type { DataTableColumn } from "../../../components";
import { dropColumnsToFit } from "../../../components/ui/table-layout";
import { createPluginCache, savedCopyForTransientFailure } from "../../../data/plugin-cache";
import { servedFromSavedCopy } from "../../../data/saved-copies";
import type { PluginPersistence } from "../../../types/plugin";
import { formatShortDate } from "../../../utils/datetime-format";
import { MISSING_VALUE, displayWidth, formatCompact } from "../../../utils/format";
import { compareSortValues, type SortDirection } from "../../../utils/sort-values";
import { AUCTION_HISTORY_ALL, type AuctionHistoryWindow } from "./client";
import type { AuctionFilter } from "./model";

/**
 * Hong Kong government paper tenders in AUCT: Exchange Fund Bills and Notes
 * and HKSAR institutional Government Bonds, from the Hong Kong Monetary
 * Authority's Open API (its Monthly Statistical Bulletin's tender figures),
 * served by Gloom Cloud (`/cloud/econ/hk-tenders`) and credited "Source: HKMA".
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
const HK_PAPER_WORDS = /\b(efbs?|efns?|exchange\s+fund|hkgbs?|hkd|honia|rmb|cnh)\b/i;

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
/** A tender's row id: its issue day, paper, currency and issue (an EF tender's tenor, HKMA naming no EF issue). */
export const hkTenderId = (tender: HkTender) => `${tender.date}|${tender.paper}|${tender.currency}|${tender.issue ?? tender.term}`;

/** HKMA's page documenting the dataset a tender came from, which `o` opens. */
const DATASET_PAGES: ReadonlyArray<[RegExp, string]> = [
  [/^efb-/, "efbn/efbn-tender-results-efb"],
  [/^efn-/, "efbn/efbn-tender-results-efn"],
  [/^ibip-/, "gov-bond/tender-results-gov-bonds-ibip"],
  [/^hkgb-hkd$/, "ibpgsbp/tender-results-gov-bonds-ibpgsbp-hkd"],
  [/^hkgb-rmb$/, "ibpgsbp/tender-results-gov-bonds-ibpgsbp-rmb"],
];
export function hkDatasetPage(tender: HkTender): string | undefined {
  const path = DATASET_PAGES.find(([pattern]) => pattern.test(tender.dataset))?.[1];
  return path ? `https://apidocs.hkma.gov.hk/documentation/market-data-and-statistics/monthly-statistical-bulletin/${path}/` : undefined;
}

const monthName = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
/** "Oct 28, 2026", or "May 2026" for a bond's issue month. */
export const hkDateText = (date: string) => date.length === 7
  ? Number.isFinite(Date.parse(`${date}-01T00:00:00Z`)) ? monthName.format(new Date(`${date}-01T00:00:00Z`)) : date
  : formatShortDate(date, { utc: true, fallback: date });

/** What the search box understands in Hong Kong's tenders. */
export const HK_SEARCH_FIELDS = "paper (EFB, HKGB), tenor (3M, 10Y), issue, HKD or RMB, or date (YYYY-MM-DD)";

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

/** A term's length in months: 3-Month is 3, 10-Year 120. */
const termMonths = (term: string) => {
  const own = /^(\d+)-(Month|Year)$/.exec(term);
  return own ? Number(own[1]) * (own[2] === "Year" ? 12 : 1) : null;
};

/** A day as HKMA gives it, a bond's issue or maturity month (YYYY-MM) read as its middle. */
const dayOf = (date: string) => Date.parse(`${date.length === 7 ? `${date}-15` : date}T00:00:00Z`);

/**
 * The months a re-opened Government Bond had left when it was tendered, to the
 * nearest month: HKMA names a re-opening by its issue's tenor (10GB2601 is a
 * 10-year bond), and the 2023-10-26 tender of it sold paper with about 2.2
 * years left. Null for a new issue, EF paper, or a bond without its maturity.
 */
function remainingMonths(tender: HkTender): number | null {
  if (!tender.reopening || !tender.maturity) return null;
  const days = (dayOf(tender.maturity) - dayOf(tender.date)) / 86_400_000;
  return Number.isFinite(days) && days > 0 ? Math.max(1, Math.round(days / 30.4375)) : null;
}

/** Months as a US auction writes a term: 27 is 2-Year 3-Month, 24 is 2-Year, 9 is 9-Month. */
function monthsTerm(months: number): string {
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return [years ? `${years}-Year` : "", rest ? `${rest}-Month` : ""].filter(Boolean).join(" ");
}

/**
 * The term a tender sold: a re-opening's what its issue had left (2-Year
 * 3-Month of a 10-year bond), as a US reopening's 9-Year 10-Month reads;
 * otherwise the tenor HKMA gives.
 */
export function hkTenderTerm(tender: HkTender): string {
  const left = remainingMonths(tender);
  return left == null ? tender.term : monthsTerm(left);
}

/** The tender's term in months, a re-opening's what it had left. */
const tenderMonths = (tender: HkTender) => remainingMonths(tender) ?? termMonths(tender.term);

/**
 * "3M" is the 3-Month bill; "1Y" the 12-Month bill as well as a 1-Year note.
 * A re-opening answers to its issue's tenor (10Y for 10GB2601) and to the
 * whole years its term left rounds up to (3Y for 2-Year 3-Month), as a US
 * 9-Year 10-Month answers to 10Y.
 */
function matchesTenor(tender: HkTender, word: string): boolean | null {
  const tenor = TENOR.exec(word);
  if (!tenor) return null;
  const count = Number(tenor[1]);
  const months = tenor[2]![0] === "y" ? count * 12 : count;
  const left = remainingMonths(tender);
  return termMonths(tender.term) === months || (left != null && tenor[2]![0] === "y" && Math.ceil(left / 12) === count);
}

function matchesWord(tender: HkTender, word: string): boolean {
  const paper = PAPER_WORDS.get(word);
  if (paper) return paper.has(tender.paper);
  if (word === "exchange" || word === "fund") return tender.paper === "efb" || tender.paper === "efn";
  const currency = CURRENCY_WORDS.get(word);
  if (currency) return tender.currency === currency;
  const tenor = matchesTenor(tender, word);
  if (tenor != null) return tenor;
  return tender.date.startsWith(word) || !!tender.issue?.toLowerCase().includes(word) || tender.term.toLowerCase().includes(word)
    || hkTenderTerm(tender).toLowerCase().includes(word);
}

/** Every word of the search names the tender (`10Y RMB`, `EFB 2026-10`); words that only pick the market are left out. */
function matchesHkSearch(tender: HkTender, query: string): boolean {
  const words = auctionSearchMarket(query).search.toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((word) => matchesWord(tender, word));
}

/** A floating rate note's spread over HONIA, in bp, stands where another's yield does. */
const spreadBp = (value: number | null) => value == null ? null : Math.round(value * 1000) / 10;

/** The average accepted yield, or a floating rate note's spread in bp. */
export const hkRate = (tender: HkTender) => tender.averageYield ?? spreadBp(tender.spread);
export const isSpread = (tender: HkTender) => tender.averageYield == null && tender.spread != null;

/** `2.827%`, or `20.0bp` for a floating rate note's spread, as a US FRN's reads. */
export function formatHkRate(tender: HkTender, value: number | null, empty: string): string {
  if (value == null) return empty;
  return isSpread(tender) ? `${value.toFixed(1)}bp` : `${value.toFixed(3)}%`;
}

/** The size: a bond's amount allotted, EF paper's amount offered as worked out from its applications. */
export const hkSize = (tender: HkTender) => tender.allotted ?? tender.offered;
/** EF paper's size is worked out, so the table marks it about (≈). */
export const hkSizeWorkedOut = (tender: HkTender) => tender.allotted == null && tender.offered != null;

/** The amount in its currency: HK$66.3B, RMB750M; `≈HK$65.7B` for EF paper's worked-out size. */
export function formatHkAmount(tender: HkTender, value: number | null, empty = MISSING_VALUE, about = false): string {
  if (value == null) return empty;
  return `${about ? "≈" : ""}${tender.currency === "CNH" ? "RMB" : "HK$"}${formatCompact(value)}`;
}

export type HkColumnId = "date" | "type" | "term" | "rate" | "btc" | "size" | "cusip";

export interface HkColumn extends DataTableColumn {
  id: HkColumnId;
}

export interface HkSortPreference {
  columnId: HkColumnId;
  direction: SortDirection;
}

export const DEFAULT_HK_SORT: HkSortPreference = { columnId: "date", direction: "desc" };

/** The order [ and ] step through the columns. */
export const HK_SORT_COLUMN_IDS: readonly HkColumnId[] = ["date", "type", "term", "rate", "btc", "size", "cusip"];

/** `--sort` and the pane's kept sort, by name: the US names that mean the same here. */
const HK_SORT_NAMES: ReadonlyArray<{ names: readonly string[]; column: HkColumnId }> = [
  { names: ["date"], column: "date" },
  { names: ["type"], column: "type" },
  { names: ["term"], column: "term" },
  { names: ["rate", "yield", "average", "avg"], column: "rate" },
  { names: ["btc", "b/c", "bid-to-cover", "bc"], column: "btc" },
  { names: ["size"], column: "size" },
  { names: ["cusip", "issue"], column: "cusip" },
];

/** The column a sort name means for Hong Kong's tenders; null for a US-only one (`indirect`, `btc-pctl`). */
function hkSortColumn(name: string): HkColumnId | null {
  const value = name.trim().toLowerCase().replace(/^-/, "");
  return HK_SORT_NAMES.find((entry) => entry.names.includes(value))?.column ?? null;
}

/** A sort name as `--sort` and the pane keep it, `-` first for the other way round (`-btc`: lowest first); null for a US-only one. */
export function parseHkSort(name: string): HkSortPreference | null {
  const columnId = hkSortColumn(name);
  if (!columnId) return null;
  const first = firstHkSortDirection(columnId);
  return { columnId, direction: name.trim().startsWith("-") ? first === "asc" ? "desc" : "asc" : first };
}

export const hkSortName = (column: HkColumnId) => HK_SORT_NAMES.find((entry) => entry.column === column)!.names[0]!;

/** Text columns read best A to Z; every figure highest first. */
export const firstHkSortDirection = (column: HkColumnId): SortDirection =>
  column === "type" || column === "term" || column === "cusip" ? "asc" : "desc";

/** A month (a Government Bond's issue) sorts after the days of that month. */
const sortDay = (date: string) => date.length === 7 ? `${date}-00` : date;

function hkSortValue(tender: HkTender, column: HkColumnId): number | string | null {
  switch (column) {
    case "date": return sortDay(tender.date);
    case "type": return hkTenderType(tender);
    case "term": return tenderMonths(tender);
    case "rate": return hkRate(tender);
    case "btc": return tender.bidToCover;
    case "size": return hkSize(tender);
    case "cusip": return tender.issue;
  }
}

/**
 * Figures that do not compare are ranked apart, in either direction: yields
 * before floating rate notes' spreads, HK$ sizes before RMB ones.
 */
function hkSortGroup(tender: HkTender, column: HkColumnId): number {
  if (column === "rate") return isSpread(tender) ? 1 : 0;
  if (column === "size") return tender.currency === "CNH" ? 1 : 0;
  return 0;
}

/** Hong Kong's day, which a window counts back from: its tenders are dated in Hong Kong. */
const hongKongDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit" });

/** The first day a window lists, counted back from today in Hong Kong: null for ALL. */
export function hkWindowStart(window: AuctionHistoryWindow, now = Date.now()): string | null {
  if (window === AUCTION_HISTORY_ALL) return null;
  const today = Date.parse(`${hongKongDay.format(now)}T00:00:00Z`);
  return new Date(today - window * 86_400_000).toISOString().slice(0, 10);
}

/** A month row (a Government Bond's issue) is in a window that starts within or before its month. */
export const hkOnOrAfter = (date: string, from: string) => date.length === 7 ? date >= from.slice(0, 7) : date >= from;

/** The tenders a group, a search and a window keep, in the sort's order; ties keep the newest first. */
export function visibleHkTenders(
  tenders: readonly HkTender[],
  options: { filter: AuctionFilter; query: string; sort: HkSortPreference; from?: string | null },
): HkTender[] {
  const { columnId, direction } = options.sort;
  return tenders
    .filter((tender) => (options.filter === "all" || PAPER_TYPES[tender.paper]?.filter === options.filter)
      && (!options.from || hkOnOrAfter(tender.date, options.from)) && matchesHkSearch(tender, options.query))
    .sort((left, right) => hkSortGroup(left, columnId) - hkSortGroup(right, columnId)
      || compareSortValues(hkSortValue(left, columnId), hkSortValue(right, columnId), direction)
      || sortDay(right.date).localeCompare(sortDay(left.date)) || hkTenderId(left).localeCompare(hkTenderId(right)));
}

/** The pane's columns, as wide as what they list; the issue closes the row where the pane has room for it. */
export function buildHkColumns(options: { showYear?: boolean; rows?: readonly HkTender[]; width?: number } = {}): HkColumn[] {
  const { showYear = false, rows = [], width } = options;
  const widest = (least: number, text: (tender: HkTender) => string) => Math.max(least, ...rows.map((tender) => displayWidth(text(tender))));
  const columns: HkColumn[] = [
    { id: "date", label: "DATE", width: showYear ? 11 : 6, align: "left", title: "Issue day (a Government Bond's issue month): the business day after the tender" },
    { id: "type", label: "TYPE", width: 6, align: "left" },
    { id: "term", label: "TERM", width: widest(7, hkTenderTerm), align: "left",
      title: "Term sold: a re-opening's is what its issue had left" },
    { id: "rate", label: "RATE", width: widest(6, (tender) => formatHkRate(tender, hkRate(tender), MISSING_VALUE)), align: "right",
      title: "Average accepted yield; a floating rate note's spread over HONIA, bp" },
    { id: "btc", label: "B/C", width: 5, align: "right" },
    { id: "size", label: "SIZE", width: widest(7, (tender) => formatHkAmount(tender, hkSize(tender), MISSING_VALUE, hkSizeWorkedOut(tender))), align: "right",
      title: "A bond's amount allotted; EF paper's amount offered, worked out from its applications (≈)" },
    { id: "cusip", label: "ISSUE", width: widest(5, (tender) => tender.issue ?? ""), align: "left", flexGrow: 1 },
  ];
  if (width == null) return columns;
  const shown = dropColumnsToFit(columns, width, ["cusip"]);
  return shown.length === columns.length ? shown : shown.map((column) => ({ ...column, flexGrow: undefined }));
}

const DATE = /^\d{4}-\d{2}(-\d{2})?$/;
const isNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const isNumberOrNull = (value: unknown) => value === null || isNumber(value);

/** A tender as this app reads it: one without its date, paper, term or figures as numbers is no tender. */
function readsAsTender(tender: HkTender): boolean {
  return !!tender && typeof tender.date === "string" && DATE.test(tender.date) && tender.paper in PAPER_TYPES
    && (tender.issue === null || typeof tender.issue === "string") && (tender.currency === "HKD" || tender.currency === "CNH")
    && typeof tender.term === "string" && typeof tender.dataset === "string" && isNumber(tender.applied) && isNumber(tender.bidToCover)
    && [tender.allotted, tender.offered, tender.averageYield, tender.spread, tender.coupon].every(isNumberOrNull);
}

/** What the HK market lists, and how far HKMA's figures run. */
interface HkTendersBoard {
  tenders: HkTender[];
  /** The first issue Gloom Cloud's record holds: a wider window adds rows only past it. */
  firstTender: string | null;
  runsTo: HkTendersPayload["runsTo"];
  /** The server held more tenders in the window than it sent. */
  truncated: boolean;
}

/** HKMA's tender figures not served yet: no route (404), an empty record (503), or an answer that says nothing. */
const HK_NOT_AVAILABLE = "Hong Kong tender results are not available yet";

/** The reply's board, or an error: a reply that is not the record is no board, never an empty one. */
function readHkBoard(payload: HkTendersPayload): HkTendersBoard {
  if (!payload || payload.status !== "available" || !Array.isArray(payload.tenders)) throw new Error(HK_NOT_AVAILABLE);
  return {
    tenders: payload.tenders.filter(readsAsTender),
    firstTender: typeof payload.firstTender === "string" ? payload.firstTender : null,
    runsTo: {
      efb: payload.runsTo?.efb ?? null,
      efn: payload.runsTo?.efn ?? null,
      hkgb: payload.runsTo?.hkgb ?? null,
    },
    truncated: payload.truncated === true,
  };
}

/** A failure that only says the figures are not there yet reads as that. */
function notAvailableYet(error: unknown): unknown {
  const status = error instanceof ApiRequestError ? error.status : undefined;
  const message = error instanceof Error ? error.message.trim() : "";
  return status === 404 || status === 503 || !message ? new Error(HK_NOT_AVAILABLE) : error;
}

export interface HkTendersResult extends HkTendersBoard {
  fetchedAt: number;
  stale: boolean;
  savedAt?: number;
  refreshError?: string;
}

/** HKMA adds its tender figures a month at a time; the server reads each dataset about twice a day. */
const HK_CACHE_POLICY = { staleMs: 60 * 60 * 1000, expireMs: 7 * 24 * 60 * 60 * 1000 } as const;
const hkCache = createPluginCache<HkTendersBoard>({
  kind: "treasury-auctions",
  source: "hk-tenders",
  schemaVersion: 2,
  policy: HK_CACHE_POLICY,
  decode: (board) => {
    if (!board || !Array.isArray(board.tenders)) throw new Error("Invalid cached tenders");
    return board;
  },
});

export function attachHkTendersPersistence(persistence: PluginPersistence): void {
  hkCache.attach(persistence);
}

export function resetHkTendersPersistence(): void {
  hkCache.reset();
}

/** Every tender on record: HKMA's figures start in the 1990s. */
const HK_RECORD_START = "1990-01-01";
/** As many as the server sends: a window never comes back cut. */
const HK_LIMIT = 10_000;

type HkTendersLoader = (from: string, limit: number) => Promise<HkTendersPayload>;

/** A window's tenders from Gloom Cloud, cached an hour; a saved copy answers a failure asking again may get past. */
export async function loadHkTenders(
  force = false,
  window: AuctionHistoryWindow,
  loader: HkTendersLoader = (from, limit) => apiClient.getCloudHkTenders(from, limit),
): Promise<HkTendersResult> {
  const from = hkWindowStart(window) ?? HK_RECORD_START;
  const read = savedCopyForTransientFailure(await hkCache.load(`hk:${window}`, async () => {
    try {
      return readHkBoard(await loader(from, HK_LIMIT));
    } catch (error) {
      throw notAvailableYet(error);
    }
  }, { force }));
  const result: HkTendersResult = {
    ...read.data,
    fetchedAt: read.fetchedAt,
    stale: read.stale,
    ...(read.refreshError ? { refreshError: read.refreshError } : {}),
  };
  return read.source === "stale-fallback" ? servedFromSavedCopy({ ...result, savedAt: read.fetchedAt }, read.fetchedAt) : result;
}
