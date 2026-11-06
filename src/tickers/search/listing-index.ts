import type { AppPluginStateStorePort } from "../../core/app-service-ports";
import type { InstrumentSearchResult } from "../../types/instrument";
import { parsePublicTickerKey } from "../../utils/exchanges";
import { logFailure } from "../../utils/log-failure";
import { buildTickerSearchCandidates } from "./index";
import { classifyInstrumentKind, getIssuerGroupKey, normalizeTickerSymbol } from "./ranking";
import { getSearchResultSymbol } from "./result";

/**
 * The listings a symbol is known to name before search answers, so the
 * command bar shows a typed symbol's exact match on the keystroke instead of
 * after a round trip. Two layers, looked up by symbol:
 *
 * - The major listings of the US, Hong Kong, China, Singapore, Japan and
 *   Europe, shipped with the app (`major-listings.json`, made by
 *   `bun run listings:snapshot` from the same search the bar asks) and
 *   re-read from search a slice a day.
 * - The exact listings each search answered since, newest kept.
 *
 * Both are kept as search answered them, every field the ranking reads
 * (popularity, the home line, a delisting), so a row built from one is the
 * row the answer brings and ranks where it does. Search still runs and has
 * the last word; this only says what it will most likely say. A remembered
 * answer stands for two weeks after a search last confirmed it.
 */

/**
 * A listing as shipped and stored: symbol, name, exchange, type, currency,
 * primary exchange, home listing, popularity, and the rest of the row as
 * search sent it (its source when not Gloom Cloud, a delisting).
 */
export type KeptListing = [
  symbol: string,
  name: string,
  exchange: string,
  type: string,
  currency: string | null,
  primaryExchange: string | null,
  homeListing: 0 | 1,
  popularity: number | null,
  more?: KeptListingMore,
];

/** The fields a row carries beside the ones a kept listing spells out. */
type KeptListingMore = Partial<Omit<InstrumentSearchResult, KeptListingField | "brokerContract" | "brokerInstanceId" | "brokerLabel">>;
type KeptListingField = "symbol" | "name" | "exchange" | "type" | "currency" | "primaryExchange" | "homeListing" | "popularity";

/** The source of the shipped listings and of most search rows; left out of a stored row that has it. */
const DEFAULT_PROVIDER_ID = "gloomberb-cloud";

/** Lines of one symbol kept: the five rows the bar shows, and one to spare. */
const MAX_LISTING_ROWS = 6;
/** Symbols kept from answers; the one answered longest ago goes first. */
const MAX_REMEMBERED_SYMBOLS = 600;
/** How long an answer stands once no search has confirmed it: a listing renamed or delisted since is not offered for long. */
const REMEMBERED_FOR_MS = 14 * 24 * 60 * 60_000;
/** Rows a re-read asks for, as many as the bar's own search, so a symbol's lines are not cut short. */
export const LISTING_ANSWER_LIMIT = 30;
/** Shipped symbols re-read in one go, one batched search. */
const REFRESH_SLICE = 100;
const REFRESH_INTERVAL_MS = 24 * 60 * 60_000;
/** After launch, so the refresh never competes with the panes' first reads. */
const REFRESH_DELAY_MS = 90_000;
/** A re-read that failed is tried again after this long, doubled for each failure in a row. */
const REFRESH_RETRY_MS = 15 * 60_000;
/** Answers come in bursts while typing; one write after them. */
const SAVE_DELAY_MS = 5_000;

const STATE_OWNER = "core.listing-index";
const STATE_KEY = "listings";
const STATE_SCHEMA_VERSION = 2;

interface Remembered {
  /** The symbol as search writes it (NOVO.B, 0700). */
  symbol: string;
  /** When a search last answered for it. */
  at: number;
  /** Empty when search found no line of the symbol: the shipped one no longer answers to it. */
  rows: InstrumentSearchResult[];
}

interface StoredIndex {
  remembered: Array<[symbol: string, at: number, rows: KeptListing[]]>;
  refreshedAt: number;
  cursor: number;
}

interface ListingIndexStore {
  get(): unknown;
  set(value: StoredIndex): void;
}

type SearchBatch = (queries: string[], options?: { limit?: number }) => Promise<Map<string, InstrumentSearchResult[]> | null>;

/** Whether the app can be seen, and word when that changes: the refresh runs only then. */
interface ListingIndexVisibility {
  isVisible(): boolean;
  subscribe(listener: () => void): () => void;
}

let directory = new Map<string, InstrumentSearchResult[]>();
/** Shipped symbols in a fixed order, for the refresh's slices. */
let directorySymbols: string[] = [];
/** Insertion order is age: an answer moves its symbol to the end. */
const remembered = new Map<string, Remembered>();
let refreshedAt = 0;
let cursor = 0;
let store: ListingIndexStore | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let version = 0;
/** Bumped by a reset, so a load still on its way from before it installs nothing. */
let generation = 0;
const listeners = new Set<() => void>();

/**
 * The key a symbol and every spelling of it is kept under: BRK.B, BRK-B and
 * BRK B, NOVO.B and NOVO-B, SAP:XETR and SAP. A class is kept apart from the
 * letters it follows, since those are often another company's symbol: BT.A is
 * BT Group, BTA a fund; HM.B is H&M, HMB a bank.
 */
export function listingIndexKey(symbol: string): string {
  const normalized = normalizeTickerSymbol(symbol);
  return (parsePublicTickerKey(normalized).symbol || normalized).trim().replace(/[\s\-/]+/g, ".");
}

function decodeKeptListing(row: KeptListing): InstrumentSearchResult {
  const [symbol, name, exchange, type, currency, primaryExchange, homeListing, popularity, more] = row;
  return {
    ...more,
    providerId: more?.providerId ?? DEFAULT_PROVIDER_ID,
    symbol,
    name,
    exchange,
    type,
    ...(currency ? { currency } : {}),
    ...(primaryExchange ? { primaryExchange } : {}),
    ...(homeListing ? { homeListing: true } : {}),
    ...(popularity != null ? { popularity } : {}),
  };
}

export function encodeKeptListing(result: InstrumentSearchResult): KeptListing {
  const {
    symbol, name, exchange, type, currency, primaryExchange, homeListing, popularity,
    providerId, brokerContract: _contract, brokerInstanceId: _instance, brokerLabel: _label, ...rest
  } = result;
  const more: KeptListingMore = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
  if (providerId && providerId !== DEFAULT_PROVIDER_ID) more.providerId = providerId;
  const row: KeptListing = [
    symbol,
    name,
    exchange,
    type,
    currency || null,
    primaryExchange || null,
    homeListing === true ? 1 : 0,
    typeof popularity === "number" && Number.isFinite(popularity) ? popularity : null,
  ];
  if (Object.keys(more).length > 0) row.push(more);
  return row;
}

const isStringList = (value: unknown) => Array.isArray(value) && value.every((entry) => typeof entry === "string");

function isKeptListing(value: unknown): value is KeptListing {
  if (!Array.isArray(value) || value.length < 8 || value.length > 9) return false;
  const more = value[8] as Record<string, unknown> | undefined;
  return typeof value[0] === "string" && typeof value[1] === "string" && typeof value[2] === "string" && typeof value[3] === "string"
    && (value[4] === null || typeof value[4] === "string") && (value[5] === null || typeof value[5] === "string")
    && (value[6] === 0 || value[6] === 1) && (value[7] === null || (typeof value[7] === "number" && Number.isFinite(value[7])))
    && (more === undefined || (!!more && typeof more === "object" && !Array.isArray(more)
      && (more.providerId === undefined || typeof more.providerId === "string")
      && (more.searchAliases === undefined || isStringList(more.searchAliases))
      && (more.searchKeywords === undefined || isStringList(more.searchKeywords))));
}

/**
 * A search's rows as the index reads them: one without a symbol is left out,
 * and a missing name, venue or type reads as none (search sends some lines
 * with no name), so one odd row cannot stop a refresh or a search.
 */
function wellFormedRows(rows: readonly InstrumentSearchResult[]): InstrumentSearchResult[] {
  return rows.flatMap((row) => {
    if (!row || typeof row.symbol !== "string" || !row.symbol.trim()) return [];
    if (typeof row.name === "string" && typeof row.exchange === "string" && typeof row.type === "string") return [row];
    return [{
      ...row,
      name: typeof row.name === "string" ? row.name : "",
      exchange: typeof row.exchange === "string" ? row.exchange : "",
      type: typeof row.type === "string" ? row.type : "",
    }];
  });
}

/**
 * The lines of `symbol` among a search's rows, in its order: a data source's
 * rows only, since a broker's contract belongs to one account.
 */
function exactListingRows(symbol: string, rows: readonly InstrumentSearchResult[]): InstrumentSearchResult[] {
  const key = listingIndexKey(symbol);
  return wellFormedRows(rows).filter((row) => !row.brokerContract && !row.brokerInstanceId && listingIndexKey(getSearchResultSymbol(row)) === key);
}

const rowIdentity = (row: InstrumentSearchResult) => `${row.symbol}|${row.exchange}|${row.name}|${row.type}`;

/** The symbol's lines among a search's rows, in the order the command bar ranks the whole answer. */
function rankedListingRows(symbol: string, rows: readonly InstrumentSearchResult[], exact: InstrumentSearchResult[]): InstrumentSearchResult[] {
  const byIdentity = new Map(exact.map((row) => [rowIdentity(row), row]));
  const ranked = buildTickerSearchCandidates({
    query: symbol,
    tickers: new Map(),
    providerResults: [...rows],
    totalLimit: rows.length + 1,
    localLimit: 0,
    includeOptionContracts: false,
  }).flatMap((candidate) => {
    const row = candidate.result && byIdentity.get(rowIdentity(candidate.result));
    return row ? [row] : [];
  });
  const listed = new Set(ranked);
  return [...new Set([...ranked, ...exact.filter((row) => !listed.has(row))])];
}

/**
 * The lines of a symbol to ship, re-read or keep: the one the command bar
 * ranks first in search's answer, then search's order. Up to the cap, they
 * are the first line of each security in that ranking (Dollar General and
 * Vinci on DG, Avis, Carrefour and CAR Group on CAR, Apple's shares and its
 * CEDEAR on AAPL), then the next ones. The bar picks its rows from these as
 * it picks them from the answer, a line of each security first, so the rows
 * it names before the answer, and the one Enter opens, are the answer's.
 */
export function directoryRows(symbol: string, answer: readonly InstrumentSearchResult[]): InstrumentSearchResult[] {
  const rows = wellFormedRows(answer);
  const exact = exactListingRows(symbol, rows);
  if (exact.length === 0) return [];
  const ranked = rankedListingRows(symbol, rows, exact);
  const kept = new Set<InstrumentSearchResult>();
  const securities = new Set<string>();
  for (const row of ranked) {
    if (kept.size >= MAX_LISTING_ROWS) break;
    const security = `${getIssuerGroupKey(row.name)}|${classifyInstrumentKind(row.type)}`;
    if (securities.has(security)) continue;
    securities.add(security);
    kept.add(row);
  }
  for (const row of ranked) {
    if (kept.size >= MAX_LISTING_ROWS) break;
    kept.add(row);
  }
  const top = ranked[0]!;
  return [top, ...exact.filter((row) => row !== top && kept.has(row))];
}

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** Installs the shipped listings, grouped by symbol in the order given. */
export function installListingDirectory(rows: readonly KeptListing[]): void {
  const next = new Map<string, InstrumentSearchResult[]>();
  const symbols: string[] = [];
  for (const row of rows) {
    if (!isKeptListing(row)) continue;
    const key = listingIndexKey(row[0]);
    const lines = next.get(key);
    if (lines) lines.push(decodeKeptListing(row));
    else {
      next.set(key, [decodeKeptListing(row)]);
      symbols.push(row[0]);
    }
  }
  directory = next;
  directorySymbols = symbols;
  changed();
}

/** What search last answered for a symbol, while it stands. */
function rememberedFor(key: string, now = Date.now()): Remembered | null {
  const entry = remembered.get(key);
  return entry && now - entry.at < REMEMBERED_FOR_MS ? entry : null;
}

/**
 * Listings `query` names exactly as far as the index knows: what search last
 * answered for the symbol, else the shipped lines. Empty for anything else,
 * and for a symbol search has since found no line of.
 */
export function knownListings(query: string): InstrumentSearchResult[] {
  const key = listingIndexKey(query);
  if (!key) return [];
  return rememberedFor(key)?.rows ?? directory.get(key) ?? [];
}

/**
 * A search's rows, with the lines the index knows for `query` added when
 * none of them is a line of it: for a search that may have been cut short,
 * which still answers with saved tickers or another source's rows. An
 * answer search gave in full is never added to.
 */
export function withKnownListings(query: string, rows: InstrumentSearchResult[]): InstrumentSearchResult[] {
  if (exactListingRows(query, rows).length > 0) return rows;
  const known = knownListings(query);
  return known.length > 0 ? [...rows, ...known] : rows;
}

function remember(symbol: string, rows: InstrumentSearchResult[], at = Date.now()): void {
  const key = listingIndexKey(symbol);
  remembered.delete(key);
  remembered.set(key, { symbol, at, rows: rows.slice(0, MAX_LISTING_ROWS) });
  while (remembered.size > MAX_REMEMBERED_SYMBOLS) {
    const oldest = remembered.keys().next().value;
    if (oldest === undefined) break;
    remembered.delete(oldest);
  }
}

/**
 * Whether a search's rows are the data service's whole answer, the one the
 * index keeps: it sent rows, and no source was busy or out of reach. A
 * keystroke's search that gave the service up has only a broker's rows, or
 * another source's, or none.
 */
export function answeredInFull(rows: readonly InstrumentSearchResult[], cutShort: boolean): boolean {
  return !cutShort && rows.some((row) => row.providerId === DEFAULT_PROVIDER_ID && !row.brokerContract && !row.brokerInstanceId);
}

/**
 * Keeps the lines a search found for the symbol it was asked, so typing it
 * again names them at once, in place of what was kept: a line it no longer
 * lists is gone. A `complete` answer (`answeredInFull`) with no line of a
 * symbol the index knows says the symbol is gone, and it is no longer
 * offered; an answer that may have been cut short leaves what is kept alone.
 * Nothing on screen is told: the answer itself is on its way there.
 */
export function rememberSearchAnswer(query: string, rows: readonly InstrumentSearchResult[], complete: boolean): void {
  const exact = directoryRows(query, rows);
  if (exact.length > 0) remember(getSearchResultSymbol(exact[0]!), exact);
  else if (complete && knownListings(query).length > 0) remember(query.trim().toUpperCase(), []);
  else return;
  scheduleSave();
}

function serialize(): StoredIndex {
  return {
    remembered: [...remembered.values()].map((entry) => [entry.symbol, entry.at, entry.rows.map(encodeKeptListing)]),
    refreshedAt,
    cursor,
  };
}

function save(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  try {
    store?.set(serialize());
  } catch (error) {
    logFailure("tickers.listing-index", "Saving known listings failed")(error);
  }
}

function scheduleSave(): void {
  if (!store || saveTimer) return;
  saveTimer = setTimeout(save, SAVE_DELAY_MS);
  (saveTimer as { unref?: () => void }).unref?.();
}

function load(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const stored = value as Partial<StoredIndex>;
  if (typeof stored.refreshedAt === "number" && Number.isFinite(stored.refreshedAt)) refreshedAt = stored.refreshedAt;
  if (typeof stored.cursor === "number" && Number.isInteger(stored.cursor) && stored.cursor >= 0) cursor = stored.cursor;
  if (!Array.isArray(stored.remembered)) return;
  // Oldest first, so an answer since launch stays newer than what was saved.
  const kept = [...remembered.entries()];
  remembered.clear();
  const now = Date.now();
  for (const entry of stored.remembered) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "number" || !Array.isArray(entry[2])) continue;
    if (!(now - entry[1] < REMEMBERED_FOR_MS)) continue;
    remember(entry[0], entry[2].filter(isKeptListing).map(decodeKeptListing), entry[1]);
  }
  for (const [key, entry] of kept) {
    remembered.delete(key);
    remembered.set(key, entry);
  }
}

/** What a refresh did: re-read its slice, had nothing due, or is to be tried again. */
type RefreshOutcome = "refreshed" | "not-due" | "failed";

/**
 * Re-reads the next slice of the shipped symbols, once a day: a symbol's
 * lines are replaced by what search says now, and one search no longer finds
 * is no longer offered. One batched search of a hundred, through the same
 * search the bar asks. A slice search did not answer in full (the request
 * failed, a query was left out, a source cannot batch) is asked again the
 * next time: the day and the slice move on only once it has.
 */
export async function refreshListingDirectory(searchBatch: SearchBatch, now = Date.now()): Promise<RefreshOutcome> {
  if (directorySymbols.length === 0) return "failed";
  if (now - refreshedAt < REFRESH_INTERVAL_MS) return "not-due";
  const start = cursor % directorySymbols.length;
  const slice = [...directorySymbols.slice(start, start + REFRESH_SLICE)];
  if (slice.length < REFRESH_SLICE) slice.push(...directorySymbols.slice(0, Math.min(start, REFRESH_SLICE - slice.length)));
  let answers: Map<string, InstrumentSearchResult[]> | null;
  try {
    answers = await searchBatch(slice, { limit: LISTING_ANSWER_LIMIT });
  } catch (error) {
    logFailure("tickers.listing-index", "Refreshing major listings failed")(error);
    return "failed";
  }
  if (!answers) return "failed";
  for (const symbol of slice) {
    const rows = answers.get(symbol);
    // A query the service could not search is left out of the answer.
    if (!Array.isArray(rows)) continue;
    // A symbol searched within the day already holds as fresh an answer.
    if (now - (remembered.get(listingIndexKey(symbol))?.at ?? 0) < REFRESH_INTERVAL_MS) continue;
    remember(symbol, directoryRows(symbol, rows), now);
  }
  // Read from the next keystroke on; a list on screen keeps its lines.
  if (slice.some((symbol) => !Array.isArray(answers.get(symbol)))) {
    save();
    return "failed";
  }
  refreshedAt = now;
  cursor = (start + slice.length) % directorySymbols.length;
  save();
  return "refreshed";
}

const ALWAYS_VISIBLE: ListingIndexVisibility = { isVisible: () => true, subscribe: () => () => {} };

/**
 * Runs the refresh in the background for as long as the app runs: first a
 * while after launch, then when the next slice is due. A slice that failed
 * is tried again a while later, twice as long after each failure in a row,
 * up to a day: a source that cannot batch (a broker searching beside it)
 * settles at the daily pace. Only while the app can be seen; a hidden app
 * waits until it shows again. Nothing a refresh throws reaches the app.
 * Returns the stop.
 */
function scheduleRefresh(searchBatch: SearchBatch, visibility: ListingIndexVisibility): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;
  let stopped = false;
  let failures = 0;
  const later = (delay: number) => {
    timer = setTimeout(() => void run(), delay);
    (timer as { unref?: () => void }).unref?.();
  };
  const run = async () => {
    timer = null;
    if (stopped) return;
    if (!visibility.isVisible()) {
      unsubscribe = visibility.subscribe(() => {
        if (stopped || !visibility.isVisible()) return;
        unsubscribe?.();
        unsubscribe = null;
        later(REFRESH_DELAY_MS);
      });
      return;
    }
    let outcome: RefreshOutcome;
    try {
      outcome = await refreshListingDirectory(searchBatch);
    } catch (error) {
      logFailure("tickers.listing-index", "Refreshing major listings failed")(error);
      outcome = "failed";
    }
    if (stopped) return;
    if (outcome === "failed") {
      later(Math.min(REFRESH_RETRY_MS * 2 ** failures, REFRESH_INTERVAL_MS));
      failures += 1;
      return;
    }
    failures = 0;
    later(Math.max(refreshedAt + REFRESH_INTERVAL_MS - Date.now(), REFRESH_RETRY_MS));
  };
  later(REFRESH_DELAY_MS);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    unsubscribe?.();
  };
}

/**
 * Loads what this device kept and, where `writable`, saves what search
 * answers from now on and refreshes the shipped listings in the background.
 * Kept in the app's local state store (SQLite in the terminal and the desktop
 * app, browser storage on the web), never in config.json or synced settings.
 * Returns the detach, which saves what is pending.
 */
export function attachListingIndex(options: {
  pluginState: Pick<AppPluginStateStorePort, "get" | "set">;
  writable: boolean;
  searchBatch?: SearchBatch | null;
  visibility?: ListingIndexVisibility;
}): () => void {
  const { pluginState, writable, searchBatch, visibility = ALWAYS_VISIBLE } = options;
  // The shipped listings stay out of the startup bundle; the bar reads them from the first keystroke after.
  if (directorySymbols.length === 0) {
    const loading = generation;
    void import("./major-listings.chunk.js")
      .then(({ MAJOR_LISTINGS }) => {
        if (loading === generation && directorySymbols.length === 0) installListingDirectory(MAJOR_LISTINGS);
      })
      .catch(logFailure("tickers.listing-index", "Loading the major listings failed"));
  }
  try {
    load(pluginState.get<unknown>(STATE_OWNER, STATE_KEY, STATE_SCHEMA_VERSION)?.value);
    changed();
  } catch (error) {
    logFailure("tickers.listing-index", "Loading known listings failed")(error);
  }
  if (!writable) return () => {};
  const attached: ListingIndexStore = {
    get: () => pluginState.get<unknown>(STATE_OWNER, STATE_KEY, STATE_SCHEMA_VERSION)?.value,
    set: (value) => pluginState.set(STATE_OWNER, STATE_KEY, value, STATE_SCHEMA_VERSION),
  };
  store = attached;
  const stopRefresh = searchBatch ? scheduleRefresh(searchBatch, visibility) : null;
  return () => {
    stopRefresh?.();
    if (store !== attached) return;
    if (saveTimer) save();
    store = null;
  };
}

export function subscribeListingIndex(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Changes when listings arrive that the bar may already be waiting on: the shipped ones, and those kept on this device. */
export function getListingIndexVersion(): number {
  return version;
}

export function resetListingIndexForTests(): void {
  generation += 1;
  directory = new Map();
  directorySymbols = [];
  remembered.clear();
  refreshedAt = 0;
  cursor = 0;
  store = null;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  version = 0;
  listeners.clear();
}
