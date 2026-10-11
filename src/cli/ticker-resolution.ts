import type { DataProvider } from "../types/data-provider";
import type { Quote } from "../types/financials";
import type { TickerRecord } from "../types/ticker";
import type { TickerRepository } from "../data/ticker-repository";
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
  noLongerTradingNote,
  notTradedMessage,
  quoteBareListing,
  resolveCliListing,
  savedListingName,
  type CliListing,
  type ListingDeps,
} from "./listing-arg";

/** The saved ticker for a symbol (`SAN:EPA`, or `SAN` with `--exchange EPA`), saving it from search first if needed. */
export async function resolveTickerForCli(
  symbol: string,
  store: TickerRepository,
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
}

export interface CliTickerOptions {
  /** The command that takes one listing, for the choices a failure names: `gloomberb watchlist add Growth 2222:JPX`. */
  retry?: (key: string) => string;
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
  store: TickerRepository,
  dataProvider: DataProvider,
  exchange?: string,
  options: CliTickerOptions = {},
): Promise<CliTicker> {
  if (!symbol.trim()) {
    throw new Error("Ticker symbol is required.");
  }
  const deps: ListingDeps = { store, dataProvider };
  const listing = await resolveCliListing(symbol, exchange, deps);
  if (listing.saved) return { ticker: listing.saved, notes: [] };

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

  if (!resolved) throw new ListingArgError(await missingListingMessage(listing, deps));
  if (resolved.kind === "local") return { ticker: resolved.ticker, notes: bareNote ? [bareNote] : [] };

  const { ticker, created } = await upsertTickerFromSearchResult(store, resolved.result);
  const named = created ? await nameFromListingQuote(ticker, store, dataProvider, bareQuote) : { ticker, quote: bareQuote };
  const saved = savedListingName(named.ticker);
  const others = resolved.otherListings?.map((key) => parsePublicTickerKey(key).exchange ?? key) ?? [];
  const venueNote = bareNote ?? (others.length > 0 && saved.exchange ? chosenListingNote(listing.symbol, saved.exchange, others) : null);
  const ended = named.quote ? noLongerTradingNote(saved.label, named.quote) : null;
  return { ticker: named.ticker, notes: [venueNote, ended].filter((note): note is string => !!note) };
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
  store: TickerRepository,
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
