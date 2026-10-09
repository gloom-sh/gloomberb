import type { DataProvider } from "../types/data-provider";
import type { Quote } from "../types/financials";
import type { CliCommandContext } from "../types/plugin";
import type { TickerRecord } from "../types/ticker";
import { AmbiguousContractError, AmbiguousTickerError, listingChoiceQuery, resolveTickerSearch } from "../tickers/search";
import { cliStyles } from "../utils/cli-output";
import {
  canonicalExchange,
  exchangeLabel,
  isKnownExchangeCode,
  parsePublicTickerKey,
  publicTickerKey,
} from "../utils/exchanges";
import { withMarketData } from "./scoped-context";

/** The `--exchange` option of every command that takes a ticker. */
export const EXCHANGE_OPTION = {
  flags: "--exchange <code>",
  description: "Listing exchange, for a symbol that trades in several places (same as SYMBOL:CODE)",
};

export class ListingArgError extends Error {
  constructor(message: string, readonly details?: string) {
    super(message);
    this.name = "ListingArgError";
  }
}

export interface ListingArg {
  /** The symbol without a venue: SAN. */
  symbol: string;
  /** The canonical code of the exchange the user named, or "" when none was. */
  exchange: string;
  /** SAN:EPA, or SAN when no exchange was named. */
  key: string;
}

/**
 * `SAN:EPA` and `SAN --exchange EPA` name the same listing. Both spellings of
 * an exchange go through the app's alias table, so `SAN:XPAR` is `SAN:EPA`.
 * A symbol's own exchange and `--exchange` that disagree are an error, unless
 * the command takes several symbols and `--exchange` only fills in the ones
 * without an exchange of their own.
 */
export function parseListingArg(
  raw: string,
  exchangeOption?: string | null,
  { ownExchangeWins = false }: { ownExchangeWins?: boolean } = {},
): ListingArg {
  const option = canonicalExchange(exchangeOption ?? "");
  let typed = raw.trim().replace(/^\$/, "").toUpperCase();
  // `SAN:` asks which listing; with --exchange it has its answer.
  if (option && typed.endsWith(":")) typed = typed.slice(0, -1);
  const parsed = parsePublicTickerKey(typed);
  if (parsed.exchange && option && parsed.exchange !== option && !ownExchangeWins) {
    throw new ListingArgError(
      `${typed} names exchange ${parsed.exchange}, but --exchange names ${option}.`,
      `Name the exchange once, as ${parsed.symbol}:${parsed.exchange} or ${parsed.symbol} --exchange ${option}.`,
    );
  }
  const exchange = parsed.exchange ?? option;
  return { symbol: parsed.symbol, exchange, key: exchange ? `${parsed.symbol}:${exchange}` : parsed.symbol };
}

interface ListingStore {
  loadTicker(symbol: string): Promise<TickerRecord | null>;
  loadAllTickers(): Promise<TickerRecord[]>;
}

export interface ListingDeps {
  store: ListingStore;
  dataProvider: DataProvider;
}

export interface ListingVenue {
  /** Canonical code. */
  exchange: string;
  name: string;
}

/**
 * The venues a symbol trades on and the company on each, from the same
 * listing picker the command bar opens for `SAN:`.
 */
export async function listingVenues(symbol: string, { store, dataProvider }: ListingDeps): Promise<ListingVenue[]> {
  const query = `${symbol}:`;
  if (!listingChoiceQuery(query)) return [];
  const tickers = new Map((await store.loadAllTickers()).map((ticker) => [ticker.metadata.ticker.toUpperCase(), ticker] as const));
  let venues: ListingVenue[];
  try {
    const resolved = await resolveTickerSearch({ query, activeTicker: null, tickers, dataProvider });
    const only = !resolved ? null
      : resolved.kind === "local" ? { exchange: resolved.ticker.metadata.exchange, name: resolved.ticker.metadata.name }
      : {
        exchange: resolved.result.exchange === "SMART" ? resolved.result.primaryExchange ?? "" : resolved.result.exchange || resolved.result.primaryExchange || "",
        name: resolved.result.name,
      };
    venues = only?.exchange ? [{ exchange: canonicalExchange(only.exchange), name: only.name }] : [];
  } catch (error) {
    // One listing settles the picker; several are its choices.
    if (!(error instanceof AmbiguousTickerError) || error instanceof AmbiguousContractError) return [];
    venues = error.listings.flatMap((listing) => {
      const exchange = parsePublicTickerKey(listing).exchange;
      return exchange ? [{ exchange, name: error.listingNames[listing] ?? "" }] : [];
    });
  }
  return venues.filter((venue, index) => venues.findIndex((other) => other.exchange === venue.exchange) === index);
}

function tradesOn(symbol: string, venues: readonly ListingVenue[]): string {
  return venues.length > 0 ? ` ${symbol} trades on: ${venues.map((venue) => venue.exchange).join(", ")}.` : "";
}

/**
 * An exchange code the app does not know is accepted only when the symbol is
 * listed there, so a typo never falls back to another venue's line.
 */
async function checkListingExchange(listing: ListingArg, deps: ListingDeps): Promise<void> {
  if (listing.symbol.endsWith(":")) {
    const symbol = listing.symbol.slice(0, -1);
    throw new ListingArgError(`Choose an exchange for ${symbol}.${tradesOn(symbol, await listingVenues(symbol, deps))}`);
  }
  if (!listing.exchange || isKnownExchangeCode(listing.exchange)) return;
  const venues = await listingVenues(listing.symbol, deps);
  if (venues.some((venue) => venue.exchange === listing.exchange)) return;
  throw new ListingArgError(
    `Unknown exchange ${listing.exchange} for ${listing.symbol}.${tradesOn(listing.symbol, venues)}`,
    venues.length > 0 ? undefined : `No listings of ${listing.symbol} were found.`,
  );
}

/** The saved ticker for a listing: under its own key, or a saved symbol whose venue it is. */
async function loadSavedListing(store: ListingStore, listing: ListingArg): Promise<TickerRecord | null> {
  if (!listing.exchange) return store.loadTicker(listing.symbol);
  for (const key of new Set([listing.key, publicTickerKey(listing.symbol, listing.exchange), listing.symbol])) {
    const ticker = await store.loadTicker(key);
    if (ticker && (key === listing.key || canonicalExchange(ticker.metadata.exchange) === listing.exchange)) return ticker;
  }
  return null;
}

export interface CliListing extends ListingArg {
  saved: TickerRecord | null;
  /**
   * What data requests take: a named listing goes by its key (SAN:EPA), never
   * the bare symbol's cache; a bare symbol goes on its saved venue, as the
   * command bar opens it.
   */
  request: { symbol: string; exchange: string };
}

export async function resolveCliListing(
  raw: string,
  exchangeOption: string | null | undefined,
  deps: ListingDeps,
  options: { ownExchangeWins?: boolean } = {},
): Promise<CliListing> {
  const listing = parseListingArg(raw, exchangeOption, options);
  if (!listing.symbol) throw new ListingArgError("Ticker symbol is required.");
  await checkListingExchange(listing, deps);
  const saved = await loadSavedListing(deps.store, listing);
  return {
    ...listing,
    saved,
    request: listing.exchange
      ? { symbol: listing.key, exchange: listing.exchange }
      : { symbol: listing.symbol, exchange: saved?.metadata.exchange ?? "" },
  };
}

/** `resolveCliListing` for a command: a bad exchange fails the command with its message. */
export async function requireCliListing(
  raw: string,
  exchangeOption: string | null | undefined,
  deps: ListingDeps,
  ctx: Pick<CliCommandContext, "fail">,
  options: { ownExchangeWins?: boolean } = {},
): Promise<CliListing> {
  try {
    return await resolveCliListing(raw, exchangeOption, deps, options);
  } catch (error) {
    if (error instanceof ListingArgError) ctx.fail(error.message, error.details);
    throw error;
  }
}

/**
 * The listing for commands that store things by symbol (notes, alerts). The
 * data sources are only opened to check an exchange the app does not know.
 */
export async function requireListingArg(
  raw: string,
  exchangeOption: string | null | undefined,
  ctx: Pick<CliCommandContext, "fail" | "initMarketData">,
): Promise<ListingArg> {
  try {
    const listing = parseListingArg(raw, exchangeOption);
    if (listing.symbol.endsWith(":") || (listing.exchange && !isKnownExchangeCode(listing.exchange))) {
      await withMarketData(ctx, (market) => checkListingExchange(listing, market));
    }
    return listing;
  } catch (error) {
    if (error instanceof ListingArgError) ctx.fail(error.message, error.details);
    throw error;
  }
}

export interface ListingIdentity {
  symbol: string;
  /** Canonical code of the venue the data is for. */
  exchange: string;
  /** The listing's company, from its own quote. */
  name: string | null;
}

export function listingIdentity(
  listing: CliListing,
  quote?: Pick<Quote, "name" | "listingExchangeName" | "exchangeName"> | null,
): ListingIdentity {
  const quoteExchange = canonicalExchange(quote?.listingExchangeName || quote?.exchangeName);
  const exchange = listing.exchange || quoteExchange || canonicalExchange(listing.saved?.metadata.exchange);
  // A quote that prices another venue names another listing's company.
  const quoteName = !quoteExchange || quoteExchange === exchange ? quote?.name?.trim() : undefined;
  return { symbol: listing.symbol, exchange, name: quoteName || listing.saved?.metadata.name?.trim() || null };
}

/** The listing's own quote, for its company name and venue; null when it has none. */
export async function loadListingQuote(dataProvider: DataProvider, listing: CliListing): Promise<Quote | null> {
  try {
    return await dataProvider.getQuote(listing.request.symbol, listing.request.exchange);
  } catch {
    return null;
  }
}

/** One line above a table naming what it is about: "Sanofi  ·  Euronext Paris (EPA)". */
export function listingHeading(identity: ListingIdentity): string {
  const venue = identity.exchange ? cliStyles.muted(`  ·  ${exchangeLabel(identity.exchange)}`) : "";
  return `${cliStyles.bold(identity.name || identity.symbol)}${venue}`;
}

/** "Sanofi (EPA)", for sentences. */
export function listingTitle(identity: ListingIdentity): string {
  const name = identity.name || identity.symbol;
  return identity.exchange ? `${name} (${identity.exchange})` : name;
}
