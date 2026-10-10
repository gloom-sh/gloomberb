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
  isUsListingExchange,
  parsePublicTickerKey,
  publicTickerKey,
  resolveExchangeTimeZone,
} from "../utils/exchanges";
import { withMarketData } from "./scoped-context";
import { isNoProviderMessage } from "../sources/provider-errors";

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

/**
 * "SAN does not trade on TSX. SAN trades on: NYSE, EPA." for a listing whose
 * exchange the symbol is not listed on, from the same picker `SAN:` opens.
 * Null when no exchange was named, when the symbol is listed there, or when its
 * venues cannot be found, so the request's own failure stands. It searches, so
 * ask only after a request came back empty.
 */
export async function notTradedMessage(
  listing: Pick<ListingArg, "symbol" | "exchange">,
  deps: ListingDeps,
): Promise<string | null> {
  if (!listing.exchange) return null;
  const venues = await listingVenues(listing.symbol, deps).catch(() => []);
  if (venues.length === 0 || venues.some((venue) => venue.exchange === listing.exchange)) return null;
  return `${listing.symbol} does not trade on ${listing.exchange}.${tradesOn(listing.symbol, venues)}`;
}

/** Fails the command with `notTradedMessage`; returns when the symbol does trade there. */
export async function failIfNotTraded(
  listing: Pick<ListingArg, "symbol" | "exchange">,
  deps: ListingDeps,
  ctx: Pick<CliCommandContext, "fail">,
): Promise<void> {
  const message = await notTradedMessage(listing, deps);
  if (message) ctx.fail(message);
}

/** What a command asked a listing for, to name it when the listing has none: `history` asks for "history". */
export interface ListingDataRequest {
  /** The command a retry runs, with any options to repeat: `history`, `history --range 5Y`. */
  command: string;
  /** What the listing has none of: "history", "a quote". */
  noun: string;
}

/**
 * The router's answer when no source serves a symbol: "No history provider available for 2222",
 * or "Not a ticker: 2222." when the service found no listing for it.
 */
export function isNoProviderError(error: unknown): boolean {
  return isNoProviderMessage(error instanceof Error ? error.message : String(error ?? ""));
}

const MAX_OTHER_LISTINGS = 5;

type BareListing = Pick<CliListing, "symbol" | "exchange"> & Partial<Pick<CliListing, "saved">>;

/** Where a bare symbol went and where else it trades, in the order they are tried and named. */
interface BareListingVenues {
  /** Canonical code of the venue the symbol went to. */
  exchange: string;
  /** That venue as search lists it; null for a saved venue search no longer lists. */
  resolved: ListingVenue | null;
  /** The symbol's other venues, in search order. */
  others: ListingVenue[];
}

/** A bare symbol goes to its saved listing, else to the one search lists first. Null when it named its exchange. */
async function bareListingVenues(listing: BareListing, deps: ListingDeps): Promise<BareListingVenues | null> {
  if (listing.exchange) return null;
  const venues = await listingVenues(listing.symbol, deps).catch(() => []);
  const savedExchange = canonicalExchange(listing.saved?.metadata.exchange);
  const resolved = venues.find((venue) => venue.exchange === savedExchange) ?? (savedExchange ? null : venues[0] ?? null);
  const exchange = resolved?.exchange ?? savedExchange;
  if (!exchange) return null;
  return { exchange, resolved, others: venues.filter((venue) => venue !== resolved && venue.exchange !== savedExchange) };
}

interface OtherListingsMessage {
  message: string;
  details: string;
  /** SAN:EPA, for each other listing. */
  others: string[];
}

function describeOtherListings(
  listing: BareListing,
  { exchange, resolved, others }: BareListingVenues,
  request: ListingDataRequest,
): OtherListingsMessage | null {
  if (others.length === 0) return null;
  const name = resolved?.name || listing.saved?.metadata.name?.trim() || "";
  const [command, ...options] = request.command.split(" ");
  const retry = (key: string) => ["gloomberb", command, key, ...options].join(" ");
  const lines = others.slice(0, MAX_OTHER_LISTINGS).map((venue) => {
    const key = `${listing.symbol}:${venue.exchange}`;
    return `${key}${venue.name ? ` ${venue.name}` : ""} (try: ${retry(key)})`;
  });
  if (others.length > MAX_OTHER_LISTINGS) lines.push(`and ${others.length - MAX_OTHER_LISTINGS} more: gloomberb search ${listing.symbol}`);
  return {
    message: `${listing.symbol} resolved to ${name ? `${name} (${exchange})` : exchange}, which has no ${request.noun}.`,
    details: lines.length === 1 ? `Other listings: ${lines[0]}` : ["Other listings:", ...lines.map((line) => `  ${line}`)].join("\n"),
    others: others.map((venue) => `${listing.symbol}:${venue.exchange}`),
  };
}

/**
 * For a bare symbol whose request found no source: the listing it went to and
 * the symbol's other listings, each with the command that asks for it, such
 * as "2222 resolved to Kotobuki Spirits Co., Ltd. (JPX), which has no
 * history." and "2222:TADAWUL Saudi Arabian Oil Co. (try: gloomberb history
 * 2222:TADAWUL)". Null when the symbol named its exchange or has no other
 * listing. It searches, so ask only after a request failed.
 */
async function otherListingsMessage(
  listing: BareListing,
  deps: ListingDeps,
  request: ListingDataRequest,
): Promise<OtherListingsMessage | null> {
  const venues = await bareListingVenues(listing, deps);
  return venues && describeOtherListings(listing, venues, request);
}

/** The listing on one venue, as `SYM:EXCH` names it. */
function namedListing(listing: CliListing, exchange: string): CliListing {
  const key = `${listing.symbol}:${exchange}`;
  const saved = canonicalExchange(listing.saved?.metadata.exchange) === exchange ? listing.saved : null;
  return { symbol: listing.symbol, exchange, key, saved, request: { symbol: key, exchange } };
}

async function quoteListings(
  dataProvider: DataProvider,
  listings: readonly CliListing[],
  refresh: boolean,
): Promise<Array<Quote | null>> {
  if (listings.length === 0) return [];
  const targets = listings.map((listing) => listing.request);
  if (dataProvider.getQuotesBatch) {
    const results = await dataProvider.getQuotesBatch(targets, { forceRefresh: refresh }).catch(() => []);
    return targets.map((target, index) => (results.find((result) => result.target === target) ?? results[index])?.quote ?? null);
  }
  return Promise.all(targets.map((target) => dataProvider.getQuote(target.symbol, target.exchange, {
    cacheMode: refresh ? "refresh" : "default",
  }).catch(() => null)));
}

export type BareListingQuote =
  | {
    kind: "quoted";
    /** The listing that has a quote: SXR8:XETRA. */
    listing: CliListing;
    quote: Quote;
    /** "SXR8 -> XETRA (other listings: BUD, MUNICH)". */
    note: string;
  }
  | ({ kind: "missing" } & OtherListingsMessage);

/**
 * The quote for a bare symbol no source quoted. The data service reads a
 * symbol with no US listing on its home listing abroad (`bareListingNote`),
 * so this is left for one it reads on none, as a code several companies list
 * (2222 is Kotobuki Spirits in Tokyo and Saudi Aramco in Riyadh), and for a
 * home listing with no quote. Search knows where the symbol trades: each
 * listing is asked again by its own key (2222:JPX), as a named one is. The
 * listing the symbol resolved to goes first, then the others together, and
 * the first in search order with a quote is the answer. When none has one,
 * the `otherListingsMessage` failure. Null when the symbol named its exchange
 * (a named venue never switches) or search knows no listing of it. It
 * searches, so ask only after a request failed.
 */
export async function quoteBareListing(
  listing: CliListing,
  deps: ListingDeps,
  request: ListingDataRequest,
  { refresh = false }: { refresh?: boolean } = {},
): Promise<BareListingQuote | null> {
  const venues = await bareListingVenues(listing, deps);
  if (!venues) return null;
  const first = [namedListing(listing, venues.exchange)];
  const rest = venues.others.map((venue) => namedListing(listing, venue.exchange));
  let tried = first;
  let quotes = await quoteListings(deps.dataProvider, first, refresh);
  if (!quotes[0] && rest.length > 0) {
    tried = [...first, ...rest];
    quotes = [...quotes, ...await quoteListings(deps.dataProvider, rest, refresh)];
  }
  const found = quotes.findIndex(Boolean);
  if (found < 0) {
    const other = describeOtherListings(listing, venues, request);
    return other && { kind: "missing", ...other };
  }
  const answer = tried[found]!;
  const without = tried.slice(0, found).map((entry) => entry.exchange);
  // Listings not asked, or asked and quoted, are still there to name.
  const others = [...first, ...rest]
    .filter((entry, index) => entry !== answer && (index >= tried.length || quotes[index]))
    .map((entry) => entry.exchange);
  const more = others.length - MAX_OTHER_LISTINGS;
  const aside = [
    without.length > 0 ? `no quote on ${without.join(", ")}` : "",
    others.length > 0
      ? `other listings: ${others.slice(0, MAX_OTHER_LISTINGS).join(", ")}${more > 0 ? ` and ${more} more: gloomberb search ${listing.symbol}` : ""}`
      : "",
  ].filter(Boolean).join("; ");
  return {
    kind: "quoted",
    listing: answer,
    quote: quotes[found]!,
    note: `${listing.symbol} -> ${answer.exchange}${aside ? ` (${aside})` : ""}`,
  };
}

// The zones of the US exchanges; a venue in another is abroad.
const US_TIME_ZONES = new Set(["America/New_York", "America/Chicago"]);

/**
 * "SXR8 -> XETRA" for a bare symbol the data service read on its home listing
 * abroad, as it reads a symbol with no US listing whose listings belong to one
 * company or fund: a row that shows the symbol as typed says which listing it
 * is. Null for a named or saved venue, and for a venue the app does not place
 * outside the US (a US exchange, OTC, a futures exchange).
 */
export function bareListingNote(
  listing: Pick<CliListing, "symbol" | "request">,
  quote: Pick<Quote, "listingExchangeName" | "exchangeName"> | null | undefined,
): string | null {
  if (listing.request.exchange || !quote || !/^[A-Z0-9]{1,10}$/.test(listing.symbol)) return null;
  const venue = canonicalExchange(quote.listingExchangeName || quote.exchangeName);
  const zone = resolveExchangeTimeZone(venue);
  return zone && !US_TIME_ZONES.has(zone) && !isUsListingExchange(venue) ? `${listing.symbol} -> ${venue}` : null;
}

/**
 * A data request for the listings a command named. When it throws, or `isMiss`
 * calls what it returned empty, and a listing's exchange is one its symbol does
 * not trade on, the command ends in that message instead of the request's own
 * "unavailable". With `request`, a bare symbol no source serves ends naming
 * its other listings (`otherListingsMessage`). A request that succeeds costs no
 * extra lookup.
 */
export async function loadForListing<T>(
  listings: ListingForLoad | readonly ListingForLoad[],
  deps: ListingDeps,
  ctx: Pick<CliCommandContext, "fail">,
  load: () => Promise<T>,
  isMiss?: (value: T) => boolean,
  request?: ListingDataRequest,
): Promise<T> {
  const all = "symbol" in listings ? [listings] : listings;
  const named = all.filter((listing) => listing.exchange);
  const checkVenues = () => Promise.all(named.map((listing) => failIfNotTraded(listing, deps, ctx)));
  let value: T;
  try {
    value = await load();
  } catch (error) {
    await checkVenues();
    if (request && all.length === 1 && isNoProviderError(error)) {
      const other = await otherListingsMessage(all[0]!, deps, request);
      if (other) ctx.fail(other.message, other.details);
    }
    throw error;
  }
  if (isMiss?.(value)) await checkVenues();
  return value;
}

type ListingForLoad = Pick<ListingArg, "symbol" | "exchange"> & Partial<Pick<CliListing, "saved">>;

/** The saved ticker for a listing: under its own key, or a saved symbol whose venue it is. */
export async function loadSavedListing(store: ListingStore, listing: ListingArg): Promise<TickerRecord | null> {
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

export interface SavedListingName {
  symbol: string;
  /** Canonical code of the venue the row is saved for, or "" when it has none. */
  exchange: string;
  /** SAN:EPA, whichever way the row is stored (SAN, SAN:XNYS). */
  key: string;
  name: string | null;
  /** "SAN:EPA (Sanofi)", for sentences. */
  label: string;
}

/** The listing a saved ticker row is, as a collection command names it after adding or removing it. */
export function savedListingName(ticker: TickerRecord): SavedListingName {
  const { symbol } = parsePublicTickerKey(ticker.metadata.ticker);
  const exchange = canonicalExchange(ticker.metadata.exchange);
  const key = exchange ? `${symbol}:${exchange}` : symbol;
  // A row saved without a company carries its symbol as the name.
  const typed = ticker.metadata.name?.trim();
  const name = typed && typed !== symbol && typed !== ticker.metadata.ticker ? typed : null;
  return { symbol, exchange, key, name, label: name ? `${key} (${name})` : key };
}
