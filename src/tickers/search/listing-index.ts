import type { AppPluginStateStorePort } from "../../core/app-service-ports";
import type { InstrumentSearchResult } from "../../types/instrument";
import { parsePublicTickerKey } from "../../utils/exchanges";
import { logFailure } from "../../utils/log-failure";
import { classifyInstrumentKind, compactSearchText, getIssuerGroupKey, normalizeTickerSymbol } from "./ranking";
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
 * Both are kept as search answered them, so a row built from one is the row
 * the answer brings: same identity, name, class and venue. Search still runs
 * and has the last word; this only says what it will most likely say.
 */

/** A listing as shipped and stored: symbol, name, exchange, type, currency, primary exchange, home listing, source. */
export type KeptListing = [
  symbol: string,
  name: string,
  exchange: string,
  type: string,
  currency: string | null,
  primaryExchange: string | null,
  homeListing: 0 | 1,
  providerId?: string,
];

/** The source of the shipped listings and of most search rows; left out of a stored row that has it. */
const DEFAULT_PROVIDER_ID = "gloomberb-cloud";

/** Lines of one symbol kept: the five rows the bar shows, and one to spare. */
const MAX_LISTING_ROWS = 6;
/** Symbols kept from answers; the one answered longest ago goes first. */
const MAX_REMEMBERED_SYMBOLS = 600;
/** Rows a re-read asks for, as many as the bar's own search, so a symbol's lines are not cut short. */
export const LISTING_ANSWER_LIMIT = 30;
/** Shipped symbols re-read in one go, one batched search. */
const REFRESH_SLICE = 100;
const REFRESH_INTERVAL_MS = 24 * 60 * 60_000;
/** After launch, so the refresh never competes with the panes' first reads. */
const REFRESH_DELAY_MS = 90_000;
/** Answers come in bursts while typing; one write after them. */
const SAVE_DELAY_MS = 5_000;

const STATE_OWNER = "core.listing-index";
const STATE_KEY = "listings";
const STATE_SCHEMA_VERSION = 1;

interface Remembered {
  /** The symbol as search writes it (NOVO.B, 0700). */
  symbol: string;
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

/** The key a symbol and every spelling of it is kept under: BRK.B and BRK-B, NOVO.B and NOVO-B, SAP:XETR and SAP. */
export function listingIndexKey(symbol: string): string {
  const normalized = normalizeTickerSymbol(symbol);
  return compactSearchText(parsePublicTickerKey(normalized).symbol || normalized);
}

function decodeKeptListing(row: KeptListing): InstrumentSearchResult {
  const [symbol, name, exchange, type, currency, primaryExchange, homeListing, providerId] = row;
  return {
    providerId: providerId ?? DEFAULT_PROVIDER_ID,
    symbol,
    name,
    exchange,
    type,
    ...(currency ? { currency } : {}),
    ...(primaryExchange ? { primaryExchange } : {}),
    ...(homeListing ? { homeListing: true } : {}),
  };
}

export function encodeKeptListing(result: InstrumentSearchResult): KeptListing {
  const row: KeptListing = [
    result.symbol,
    result.name,
    result.exchange,
    result.type,
    result.currency || null,
    result.primaryExchange || null,
    result.homeListing === true ? 1 : 0,
  ];
  if (result.providerId && result.providerId !== DEFAULT_PROVIDER_ID) row.push(result.providerId);
  return row;
}

function isKeptListing(value: unknown): value is KeptListing {
  return Array.isArray(value) && value.length >= 7
    && typeof value[0] === "string" && typeof value[1] === "string" && typeof value[2] === "string" && typeof value[3] === "string"
    && (value[4] === null || typeof value[4] === "string") && (value[5] === null || typeof value[5] === "string")
    && (value[6] === 0 || value[6] === 1) && (value[7] === undefined || typeof value[7] === "string");
}

/**
 * The lines of `symbol` among a search's rows, in its order: a data source's
 * rows only, since a broker's contract belongs to one account.
 */
function exactListingRows(symbol: string, rows: readonly InstrumentSearchResult[]): InstrumentSearchResult[] {
  const key = listingIndexKey(symbol);
  return rows.filter((row) => !row.brokerContract && !row.brokerInstanceId && listingIndexKey(getSearchResultSymbol(row)) === key);
}

/**
 * The lines of a symbol to ship, re-read or keep, in search's order: the
 * first line of each security (Avis, Carrefour and CAR Group on CAR, Apple's
 * shares and its CEDEAR on AAPL), then the lines after them, up to the cap.
 * The command bar picks its rows from these as it picks them from search's
 * answer (a line of each security first), so the rows it names before the
 * answer are the rows the answer brings.
 */
export function directoryRows(symbol: string, rows: readonly InstrumentSearchResult[]): InstrumentSearchResult[] {
  const exact = exactListingRows(symbol, rows);
  if (exact.length <= MAX_LISTING_ROWS) return exact;
  const kept = new Set<InstrumentSearchResult>();
  const securities = new Set<string>();
  for (const row of exact) {
    if (kept.size >= MAX_LISTING_ROWS) break;
    const security = `${getIssuerGroupKey(row.name)}|${classifyInstrumentKind(row.type)}`;
    if (securities.has(security)) continue;
    securities.add(security);
    kept.add(row);
  }
  for (const row of exact) {
    if (kept.size >= MAX_LISTING_ROWS) break;
    kept.add(row);
  }
  return exact.filter((row) => kept.has(row));
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

/**
 * Listings `query` names exactly as far as the index knows: what search last
 * answered for the symbol, else the shipped lines. Empty for anything else,
 * and for a shipped symbol search has since found no line of.
 */
export function knownListings(query: string): InstrumentSearchResult[] {
  const key = listingIndexKey(query);
  if (!key) return [];
  return remembered.get(key)?.rows ?? directory.get(key) ?? [];
}

/**
 * A search's rows, with the lines the index knows for `query` added when
 * none of them is a line of it: for a search that may have been cut short,
 * which still answers with saved tickers or another source's rows.
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
 * Keeps the lines a search found for the symbol it was asked, so typing it
 * again names them at once. An answer with none leaves what is kept alone:
 * a search that came back empty may only have been cut short. Nothing on
 * screen is told: the answer itself is on its way there, and the lines it
 * would move are the ones the bar keeps in place.
 */
export function rememberSearchAnswer(query: string, rows: readonly InstrumentSearchResult[]): void {
  const exact = directoryRows(query, rows);
  if (exact.length === 0) return;
  remember(getSearchResultSymbol(exact[0]!), exact);
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
  for (const entry of stored.remembered) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "number" || !Array.isArray(entry[2])) continue;
    remember(entry[0], entry[2].filter(isKeptListing).map(decodeKeptListing), entry[1]);
  }
  for (const [key, entry] of kept) {
    remembered.delete(key);
    remembered.set(key, entry);
  }
}

/**
 * Re-reads the next slice of the shipped symbols, once a day: a symbol's
 * lines are replaced by what search says now, and one search no longer finds
 * is no longer offered. One batched search of a hundred, through the same
 * search the bar asks.
 */
export async function refreshListingDirectory(searchBatch: SearchBatch, now = Date.now()): Promise<void> {
  if (directorySymbols.length === 0 || now - refreshedAt < REFRESH_INTERVAL_MS) return;
  const start = cursor % directorySymbols.length;
  const slice = [...directorySymbols.slice(start, start + REFRESH_SLICE)];
  if (slice.length < REFRESH_SLICE) slice.push(...directorySymbols.slice(0, Math.min(start, REFRESH_SLICE - slice.length)));
  const answers = await searchBatch(slice, { limit: LISTING_ANSWER_LIMIT });
  // A source that cannot batch (a broker searching beside it) is asked again next launch.
  if (!answers) return;
  for (const symbol of slice) {
    const rows = answers.get(symbol);
    // A query the service could not search is left out of the answer.
    if (!rows) continue;
    // A symbol searched within the day already holds as fresh an answer.
    if (now - (remembered.get(listingIndexKey(symbol))?.at ?? 0) < REFRESH_INTERVAL_MS) continue;
    remember(symbol, directoryRows(symbol, rows), now);
  }
  refreshedAt = now;
  cursor = (start + slice.length) % directorySymbols.length;
  // Read from the next keystroke on; a list on screen keeps its lines.
  save();
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
}): () => void {
  const { pluginState, writable, searchBatch } = options;
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
  const refreshTimer = searchBatch
    ? setTimeout(() => {
      void refreshListingDirectory(searchBatch).catch(logFailure("tickers.listing-index", "Refreshing major listings failed"));
    }, REFRESH_DELAY_MS)
    : null;
  (refreshTimer as { unref?: () => void } | null)?.unref?.();
  return () => {
    if (refreshTimer) clearTimeout(refreshTimer);
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
