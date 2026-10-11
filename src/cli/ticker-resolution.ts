import type { DataProvider } from "../types/data-provider";
import type { Quote } from "../types/financials";
import type { TickerRecord } from "../types/ticker";
import type { AppTickerRepositoryPort } from "../core/app-service-ports";
import { connectionHealth, GLOOM_CLOUD_HTTP_CONNECTION_ID } from "../core/connection-health";
import { mapWithConcurrency } from "../utils/concurrency";
import {
  AmbiguousContractError,
  AmbiguousTickerError,
  resolveTickerSearch,
  upsertTickerFromSearchResult,
  type ResolvedTickerSearch,
} from "../tickers/search";
import { canonicalExchange, parsePublicTickerKey } from "../utils/exchanges";
import {
  chosenListingNote,
  ListingArgError,
  listingChoiceNote,
  listingReadNotes,
  listingVenues,
  noLongerTradingNote,
  notTradedMessage,
  quoteBareListing,
  resolveCliListing,
  savedListingName,
  tradingListing,
  type CliListing,
  type ListingDeps,
} from "./listing-arg";
import {
  describeTickerChange,
  startTickerChangeLookup,
  type CurrentListing,
  type TickerChange,
  type TickerChangeLookup,
} from "../tickers/ticker-changes";

/** The saved ticker for a symbol (`SAN:EPA`, or `SAN` with `--exchange EPA`), saving it from search first if needed. */
export async function resolveTickerForCli(
  symbol: string,
  store: AppTickerRepositoryPort,
  dataProvider: DataProvider,
  exchange?: string,
): Promise<TickerRecord> {
  return (await resolveCliTicker(symbol, store, dataProvider, exchange)).ticker;
}

export interface CliTicker {
  ticker: TickerRecord;
  /**
   * What to say beside it: the venue a bare symbol went to when it has several
   * ("IEO -> BATS (other listings: IEX, BMV)"), and a listing that stopped trading.
   */
  notes: string[];
  /** Of those, the one saying the listing stopped trading; null while it trades. */
  ended: string | null;
  /** The symbol changed (FB became META); its note leads `notes`. */
  change: TickerChange | null;
}

export interface CliTickerOptions {
  /** The command that takes one listing, for the choices a failure names: `gloomberb watchlist add Growth 2222:JPX`. */
  retry?: (key: string) => string;
  /** `--exchange` only fills in the symbols that name no exchange of their own, as for a list of symbols. */
  ownExchangeWins?: boolean;
  /** Look up whether the symbol changed (FB became META); a long list skips it. True by default. */
  changes?: boolean;
}

/** Search found no listing for the symbol: the message says so, or why (no longer trading, not on that exchange). */
export class TickerNotFoundError extends ListingArgError {
  constructor(message: string) {
    super(message);
    this.name = "TickerNotFoundError";
  }
}

/**
 * `resolveTickerForCli`, saying which listing a bare symbol went to. A bare
 * symbol goes where `quote` reads it: the listing its own quote is on, else,
 * when no quote settles it, the first of its listings with a quote
 * (`quoteBareListing`); a code several companies list asks which. A symbol
 * search no longer lists, whose quote stopped long ago, is no longer trading,
 * and a named exchange the symbol is not on says where it is. Those failures
 * are `ListingArgError`s, with any choices in `details`.
 */
export async function resolveCliTicker(
  symbol: string,
  store: AppTickerRepositoryPort,
  dataProvider: DataProvider,
  exchange?: string,
  options: CliTickerOptions = {},
): Promise<CliTicker> {
  if (!symbol.trim()) {
    throw new Error("Ticker symbol is required.");
  }
  const deps: ListingDeps = { store, dataProvider };
  const listing = await resolveCliListing(symbol, exchange, deps, { ownExchangeWins: options.ownExchangeWins });
  const read = listingReadNotes(listing);
  // Looked up beside the search, so saying FB is now META costs no wait.
  const changes = options.changes === false ? null : startTickerChangeLookup(dataProvider, listing.symbol, listing.exchange);
  // A saved listing names what lists there; the issuer that left, if it is that one, is its old line.
  if (listing.saved) {
    return withChange(listing, changes, { ticker: listing.saved, notes: read, ended: null }, { name: listing.saved.metadata.name });
  }

  const localTickers = new Map(
    (await store.loadAllTickers()).map((ticker) => [ticker.metadata.ticker.toUpperCase(), ticker] as const),
  );
  const search = (query: string) => resolveTickerSearch({ query, activeTicker: null, tickers: localTickers, dataProvider });
  let resolved: ResolvedTickerSearch | null;
  let bareNote: string | null = null;
  let bareQuote: Quote | null = null;
  try {
    resolved = await search(listing.key);
  } catch (error) {
    if (!(error instanceof AmbiguousTickerError) || error instanceof AmbiguousContractError || listing.exchange) throw error;
    // No quote of the bare symbol settles which listing it is: the one `quote` reads instead.
    const bare = await quoteBareListing(listing, deps, { command: "quote", noun: "quote", retry: options.retry ?? null });
    if (!bare) throw error;
    if (bare.kind === "missing") throw new ListingArgError(bare.message, bare.details);
    resolved = await search(bare.listing.key);
    bareNote = bare.note;
    bareQuote = bare.quote;
  }

  if (!resolved) {
    const message = await missingListingMessage(listing, deps);
    const change = describeTickerChange(listing.symbol, await changes?.settle() ?? null, null);
    throw new TickerNotFoundError(change ? `${message} ${change.note}.` : message);
  }
  if (resolved.kind === "local") {
    return withChange(listing, changes, { ticker: resolved.ticker, notes: [...read, ...bareNote ? [bareNote] : []], ended: null }, {
      name: resolved.ticker.metadata.name,
    });
  }

  const { ticker, created } = await upsertTickerFromSearchResult(store, resolved.result);
  const named = created ? await nameFromListingQuote(ticker, store, dataProvider, bareQuote) : { ticker, quote: bareQuote };
  const saved = savedListingName(named.ticker);
  const others = resolved.otherListings?.map((key) => parsePublicTickerKey(key).exchange ?? key) ?? [];
  // Several companies' listings name the company it went to and theirs; one company's name its other venues.
  const venueNote = bareNote ?? (others.length > 0 && saved.exchange
    ? listingChoiceNote(listing.symbol, saved, await listingVenues(listing.symbol, deps).catch(() => []))
      ?? chosenListingNote(listing.symbol, saved.exchange, others)
    : null);
  const ended = named.quote ? noLongerTradingNote(saved.label, named.quote) : null;
  // Search listed it, so something trades there; its quote says whether that is the issuer that left.
  const current = named.quote ? tradingListing(named.quote) : { name: named.ticker.metadata.name };
  return withChange(listing, changes, {
    ticker: named.ticker,
    notes: [...read, venueNote, ended].filter((note): note is string => !!note),
    ended,
  }, current);
}

/** The resolution with the symbol's change, when it has one, leading its notes. */
async function withChange(
  listing: Pick<CliListing, "symbol">,
  lookup: TickerChangeLookup | null,
  resolved: Omit<CliTicker, "change">,
  current: CurrentListing | null | undefined,
): Promise<CliTicker> {
  const change = describeTickerChange(listing.symbol, await lookup?.settle() ?? null, current);
  return change ? { ...resolved, notes: [change.note, ...resolved.notes], change } : { ...resolved, change: null };
}

/**
 * Why search found no listing: a named exchange the symbol is not on names
 * the ones it is; a symbol search no longer lists, whose quote stopped long
 * ago, is no longer trading (TWTR).
 */
async function missingListingMessage(listing: CliListing, deps: ListingDeps): Promise<string> {
  const notTraded = await notTradedMessage(listing, deps);
  if (notTraded) return notTraded;
  const quote = await deps.dataProvider.getQuote(listing.request.symbol, listing.request.exchange).catch(() => null);
  const ended = quote ? noLongerTradingNote(listing.key, quote) : null;
  return ended ? `${ended}.` : `No ticker match found for "${listing.key}".`;
}

/**
 * Search catalogues can file a listing under another company's name, such as
 * BAE Systems' London line (BA:LSE) under Boeing. The listing's own
 * quote names the security it prices, which is the name the ticker command
 * shows, so a record created here takes it. The quote comes back with it,
 * when it is that listing's.
 */
async function nameFromListingQuote(
  ticker: TickerRecord,
  store: AppTickerRepositoryPort,
  dataProvider: DataProvider,
  known: Quote | null,
): Promise<{ ticker: TickerRecord; quote: Quote | null }> {
  const { metadata } = ticker;
  try {
    const quote = known ?? await dataProvider.getQuote(metadata.ticker, metadata.exchange);
    const name = quote.name?.trim();
    // A quote that names no listing may be another venue's line served from cache.
    const quoteExchange = canonicalExchange(quote.listingExchangeName || quote.exchangeName);
    if (!quoteExchange || quoteExchange !== canonicalExchange(metadata.exchange)) return { ticker, quote: null };
    if (!name || name === metadata.name) return { ticker, quote };
    const named: TickerRecord = { ...ticker, metadata: { ...metadata, name } };
    await store.saveTicker(named);
    return { ticker: named, quote };
  } catch {
    // Without a quote the catalogue name stands.
    return { ticker, quote: null };
  }
}

export type CliTickerResolution =
  | ({ input: string; error?: undefined } & CliTicker)
  | { input: string; ticker?: undefined; error: Error };

/** Symbols looked up at once. Each is a catalogue search and a quote, so this bounds the requests in flight. */
const RESOLVE_CONCURRENCY = 8;
/** Lists of at most this many symbols say which changed; a longer one is a portfolio, not a lookup. */
const MAX_CHANGE_LOOKUPS = 10;
/** Symbols looked up again at once after requests failed, gently, as the service may be limiting the rate. */
const RETRY_CONCURRENCY = 4;
/** The data service's market requests (search, quotes), as connection health names them. */
const MARKET_OPERATION = /^(?:GET|POST) \/market\//;
/**
 * Waits before each new look at the symbols that failed while requests were
 * failing. The first outlasts the five seconds the router keeps an empty
 * search answer; the service's rate limit is a minute's window.
 */
const RETRY_WAITS_MS = [6_000, 15_000, 30_000];

/**
 * Counts the data service's market requests that fail while it watches. A
 * lookup reads a refused search (rate limited, offline) as no match, and a
 * refused quote as a listing it cannot settle, so a symbol looked up while
 * one failed may be there after all.
 */
function watchFailedRequests(): { count: () => number; stop: () => void } {
  const dispose = connectionHealth.hasSource(GLOOM_CLOUD_HTTP_CONNECTION_ID)
    ? null
    : connectionHealth.registerSource({ id: GLOOM_CLOUD_HTTP_CONNECTION_ID, name: "Gloom Cloud HTTP", kind: "api" });
  const failures = new Set<string>();
  const unsubscribe = connectionHealth.subscribe(() => {
    const failure = connectionHealth.getSnapshot().sources.find((source) => source.id === GLOOM_CLOUD_HTTP_CONNECTION_ID)?.lastError;
    if (failure && MARKET_OPERATION.test(failure.operation)) failures.add(`${failure.at}|${failure.latencyMs}|${failure.error ?? ""}`);
  });
  return { count: () => failures.size, stop: () => { unsubscribe(); dispose?.(); } };
}

function lookUpTickers(
  symbols: readonly string[],
  concurrency: number,
  resolve: (symbol: string) => Promise<CliTicker>,
): Promise<CliTickerResolution[]> {
  return mapWithConcurrency(symbols, concurrency, async (input): Promise<CliTickerResolution> => {
    try {
      return { input, ...await resolve(input) };
    } catch (error) {
      return { input, error: error instanceof Error ? error : new Error(String(error)) };
    }
  });
}

/**
 * `resolveCliTicker` for a list of symbols, several at a time; a symbol that
 * fails gives its error without failing the rest. `--exchange` names the
 * venue of the symbols that do not name their own. "Not found" means search
 * found no listing: while the service refuses requests, the symbols that
 * failed are looked up again after a pause, and any it still did not answer
 * for say so.
 */
export async function resolveTickersForCli(
  symbols: readonly string[],
  store: AppTickerRepositoryPort,
  dataProvider: DataProvider,
  exchange?: string,
  {
    retry,
    onRetry,
    retryWaitsMs = RETRY_WAITS_MS,
  }: Pick<CliTickerOptions, "retry"> & {
    /** Told before each new look, with how many symbols and how long it waits first. */
    onRetry?: (count: number, waitMs: number) => void;
    retryWaitsMs?: readonly number[];
  } = {},
): Promise<CliTickerResolution[]> {
  const changes = symbols.length <= MAX_CHANGE_LOOKUPS;
  const resolve = (symbol: string) => resolveCliTicker(symbol, store, dataProvider, exchange, { retry, ownExchangeWins: true, changes });
  const failedRequests = watchFailedRequests();
  try {
    let lookups = await lookUpTickers(symbols, RESOLVE_CONCURRENCY, resolve);
    let failing = failedRequests.count() > 0;
    for (const waitMs of retryWaitsMs) {
      const failed = lookups.filter((entry) => entry.error).map((entry) => entry.input);
      if (!failing || failed.length === 0) break;
      onRetry?.(failed.length, waitMs);
      await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
      const before = failedRequests.count();
      const again = new Map((await lookUpTickers(failed, RETRY_CONCURRENCY, resolve)).map((entry) => [entry.input, entry] as const));
      lookups = lookups.map((entry) => again.get(entry.input) ?? entry);
      failing = failedRequests.count() > before;
    }
    if (!failing) return lookups;
    // Still refused after the last wait: a failure may only be the refusal, so none is called not found.
    return lookups.map((entry) => entry.error
      ? { input: entry.input, error: new Error(`Could not look up ${entry.input}: Gloom Cloud did not answer. Try again in a minute.`) }
      : entry);
  } finally {
    failedRequests.stop();
  }
}
