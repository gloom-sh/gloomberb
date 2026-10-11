import type { DataProvider } from "../types/data-provider";
import type { Quote } from "../types/financials";
import type { CliCommandContext } from "../types/plugin";
import type { TickerRecord } from "../types/ticker";
import { AmbiguousContractError, AmbiguousTickerError, LISTING_SEARCH_LIMIT, listingChoiceQuery, resolveTickerSearch } from "../tickers/search";
import { findUsListingOfCompany, type UsListing } from "../tickers/us-listing";
import { cliStyles } from "../utils/cli-output";
import { groupByCompany, sameCompany, shortCompanyName } from "../tickers/company-name";
import {
  canonicalExchange,
  exchangeCodeVenues,
  exchangeLabel,
  isKnownExchangeCode,
  isSharedExchangeCode,
  isUsListingExchange,
  parsePublicTickerKey,
  publicTickerKey,
  resolveExchangeTimeZone,
  typedExchangeCode,
} from "../utils/exchanges";
import { withMarketData } from "./scoped-context";
import { isNoProviderMessage } from "../sources/provider-errors";
import { dashedCoinPair } from "../utils/crypto-pair";
import { isQuoteStaleForCurrentSession } from "../market-data/quotes/freshness";
import { formatMarketPriceWithCurrency, quoteFormatOptions } from "../market-data/market/format";
import { zonedDateKey } from "../utils/zoned-date-time";
import { bareFuturesCode, futuresContractByCode } from "../market-data/futures-board";

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
  /**
   * The code as typed when it names several venues (TSE: Toronto or Tokyo),
   * until `resolveCliListing` reads it as the one the symbol trades on.
   * `exchange` is meanwhile the code's first venue.
   */
  sharedCode?: string;
  /** What a shared code was read as, when not its first venue: "Read 7203:TSE as 7203:JPX: ...". */
  readAs?: string;
}

/**
 * `SAN:EPA` and `SAN --exchange EPA` name the same listing. Both spellings of
 * an exchange go through the app's alias table, so `SAN:XPAR` is `SAN:EPA`.
 * A symbol's own exchange and `--exchange` that disagree are an error, unless
 * the command takes several symbols and `--exchange` only fills in the ones
 * without an exchange of their own. A code that names several venues (TSE)
 * agrees with any of them. A futures board code no listed security uses is
 * its future: TTF is TTF=F, while NG stays NovaGold.
 */
export function parseListingArg(
  raw: string,
  exchangeOption?: string | null,
  { ownExchangeWins = false }: { ownExchangeWins?: boolean } = {},
): ListingArg {
  const optionCode = (exchangeOption ?? "").trim().toUpperCase();
  const option = canonicalExchange(optionCode);
  let typed = raw.trim().replace(/^\$/, "").toUpperCase();
  // `SAN:` asks which listing; with --exchange it has its answer.
  if (option && typed.endsWith(":")) typed = typed.slice(0, -1);
  const venueKey = parsePublicTickerKey(typed);
  // BTC/USD, as crypto venues write a pair, is the coin's own BTC-USD.
  const parsed = { ...venueKey, symbol: dashedCoinPair(venueKey.symbol) ?? venueKey.symbol };
  const ownCode = parsed.exchange ? typedExchangeCode(typed) : "";
  let exchange = parsed.exchange ?? option;
  let code = ownCode || optionCode;
  if (parsed.exchange && option) {
    const named = exchangeCodeVenues(optionCode);
    const agreed = exchangeCodeVenues(ownCode).filter((venue) => named.includes(venue));
    if (agreed.length === 0 && !ownExchangeWins) {
      throw new ListingArgError(
        `${typed} names exchange ${parsed.exchange}, but --exchange names ${option}.`,
        `Name the exchange once, as ${parsed.symbol}:${parsed.exchange} or ${parsed.symbol} --exchange ${option}.`,
      );
    }
    // TSE and --exchange JPX agree on Tokyo.
    if (agreed.length === 1) [exchange, code] = [agreed[0]!, agreed[0]!];
  }
  const shared = isSharedExchangeCode(code) ? { sharedCode: code } : {};
  if (exchange) return { symbol: parsed.symbol, exchange, key: `${parsed.symbol}:${exchange}`, ...shared };
  // A futures board code no security uses is its future: TTF is TTF=F.
  const symbol = bareFuturesCode(parsed.symbol)?.symbol ?? parsed.symbol;
  return { symbol, exchange, key: symbol };
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
 * listing picker the command bar opens for `SAN:`. This is the one venue list
 * every command names; whether a venue it leaves out trades the symbol is the
 * listing's own quote's to say (`notTradedMessage`).
 */
export async function listingVenues(symbol: string, { store, dataProvider }: ListingDeps): Promise<ListingVenue[]> {
  const query = `${symbol}:`;
  if (!listingChoiceQuery(query)) return [];
  const tickers = new Map((await store.loadAllTickers()).map((ticker) => [ticker.metadata.ticker.toUpperCase(), ticker] as const));
  let venues: ListingVenue[];
  try {
    const resolved = await resolveTickerSearch({
      query, activeTicker: null, tickers, dataProvider, searchContext: { limit: LISTING_SEARCH_LIMIT },
    });
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

/** "Toronto Stock Exchange (TSX) or Tokyo Stock Exchange (JPX)". */
function venueChoices(venues: readonly string[]): string {
  const labels = venues.map(exchangeLabel);
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}` : labels[0] ?? "";
}

/**
 * A listing typed with a code that names several venues (7203:TSE), read as
 * the one of them its symbol trades on: the venues the `7203:` picker lists,
 * else the one its own quote prices (search can leave a venue out). The
 * listing says so in `readAs` when that is not the code's first venue. A
 * symbol on several of them asks which; one on none of them says where it
 * trades. When neither search nor a quote knows the symbol, the code's first
 * venue stands and the request's own failure speaks.
 */
async function settleSharedCode(listing: ListingArg, deps: ListingDeps): Promise<ListingArg> {
  const code = listing.sharedCode;
  if (!code) return listing;
  const meanings = exchangeCodeVenues(code);
  const venues = await listingVenues(listing.symbol, deps).catch(() => []);
  let traded = meanings.filter((venue) => venues.some((entry) => entry.exchange === venue));
  if (traded.length === 0) {
    const quoted = await Promise.all(meanings.map((exchange) => quotedOnVenue({ symbol: listing.symbol, exchange }, deps)));
    traded = meanings.filter((_venue, index) => quoted[index]);
  }
  const { symbol } = listing;
  if (traded.length > 1) {
    throw new ListingArgError(
      `${code} is ${venueChoices(meanings)}, and ${symbol} trades on ${traded.join(" and ")}.`,
      `Name one: ${traded.map((venue) => `${symbol}:${venue}`).join(" or ")}.`,
    );
  }
  if (traded.length === 0) {
    if (venues.length === 0) return listing;
    throw new ListingArgError(`${code} is ${venueChoices(meanings)}, and ${symbol} trades on none of them.${tradesOn(symbol, venues)}`);
  }
  const exchange = traded[0]!;
  const key = `${symbol}:${exchange}`;
  const readAs = exchange === meanings[0] ? {}
    : { readAs: `Read ${symbol}:${code} as ${key}: ${code} is ${venueChoices(meanings)}, and ${symbol} trades on ${exchange}.` };
  return { symbol, exchange, key, ...readAs };
}

/**
 * The keys a listing can be saved under: SAN:EPA, or for a code that names
 * several venues (7203:TSE) each of theirs, as local rows are looked up before
 * the code is read.
 */
export function listingKeys(listing: ListingArg): string[] {
  return listing.sharedCode
    ? exchangeCodeVenues(listing.sharedCode).map((exchange) => `${listing.symbol}:${exchange}`)
    : [listing.key];
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
 * Whether the listing's own quote prices it on a venue abroad, as `quote
 * SYM:EXCH` reads it. Search can leave a venue out (CAR's ASX line); a quote
 * there settles that it trades. The US exchanges share one symbol, so a quote
 * named for any of them says only that the symbol has a US line: there,
 * search's venues stand.
 */
async function quotedOnVenue(listing: Pick<ListingArg, "symbol" | "exchange">, { dataProvider }: ListingDeps): Promise<boolean> {
  if (isUsListingExchange(listing.exchange)) return false;
  try {
    const quote = await dataProvider.getQuote(`${listing.symbol}:${listing.exchange}`, listing.exchange);
    return Number.isFinite(quote.price) && quote.price !== 0
      && canonicalExchange(quote.listingExchangeName || quote.exchangeName) === listing.exchange;
  } catch {
    return false;
  }
}

/**
 * "SAN does not trade on TSX. SAN trades on: NYSE, EPA." for a listing whose
 * exchange the symbol is not listed on, from the same picker `SAN:` opens.
 * A venue the picker leaves out but the listing's quote prices (CAR:ASX) is
 * traded, as `quote` says. Null when no exchange was named, when the symbol is
 * listed there, or when its venues cannot be found, so the request's own
 * failure stands. It searches, so ask only after a request came back empty.
 */
export async function notTradedMessage(
  listing: Pick<ListingArg, "symbol" | "exchange">,
  deps: ListingDeps,
): Promise<string | null> {
  if (!listing.exchange) return null;
  const venues = await listingVenues(listing.symbol, deps).catch(() => []);
  if (venues.length === 0 || venues.some((venue) => venue.exchange === listing.exchange)) return null;
  if (await quotedOnVenue(listing, deps)) return null;
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
  /**
   * The retry for one listing, when the key does not go right after the
   * command (`gloomberb watchlist add Growth SAN:EPA`); null names the listings alone.
   */
  retry?: ((key: string) => string) | null;
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
  /** Canonical code of the venue the symbol went to; "" when it went nowhere (`choose`). */
  exchange: string;
  /** That venue as search lists it; null for a saved venue search no longer lists. */
  resolved: ListingVenue | null;
  /** The symbol's other venues, in search order; every venue when `choose`. */
  others: ListingVenue[];
  /** Several companies list the symbol, so no venue is the one it means: the user picks. */
  choose: boolean;
}

/** Whether the venues' companies differ by name. A venue with no name is no other company. */
function listsSeveralCompanies(venues: readonly ListingVenue[]): boolean {
  return groupByCompany(venues, (venue) => venue.name).length > 1;
}

/** Every other company that lists the symbol once, at its first venue in search order. */
function otherCompanies(venues: readonly ListingVenue[], company: string): ListingVenue[] {
  return groupByCompany(venues, (venue) => venue.name)
    .filter((group) => !group.some((venue) => sameCompany(venue.name, company)))
    .map((group) => group[0]!);
}

/**
 * "CAR = Avis Budget Group, NASDAQ (also XETRA, ASX)": the listing a bare
 * symbol several companies list was read on, and where the others list it.
 * Null when one company lists it, so a symbol that means one thing says
 * nothing.
 */
export function listingChoiceNote(
  symbol: string,
  chosen: { exchange: string; name?: string | null },
  venues: readonly ListingVenue[],
): string | null {
  if (!chosen.exchange || !listsSeveralCompanies(venues)) return null;
  const chosenVenue = venues.find((venue) => venue.exchange === chosen.exchange);
  const name = chosen.name?.trim() || chosenVenue?.name || "";
  const others = otherCompanies(venues, chosenVenue?.name || name).map((venue) => venue.exchange)
    .filter((exchange) => exchange !== chosen.exchange);
  if (others.length === 0) return null;
  const more = others.length - MAX_OTHER_LISTINGS;
  const also = `${others.slice(0, MAX_OTHER_LISTINGS).join(", ")}${more > 0 ? ` and ${more} more: gloomberb search ${symbol}` : ""}`;
  return `${symbol} = ${name ? `${shortCompanyName(name)}, ` : ""}${chosen.exchange} (also ${also})`;
}

// Quotes of these never name a company's listing, so they are never a choice between companies.
const UNLISTED_TYPES = new Set(["FUTURE", "INDEX", "CURRENCY", "CRYPTOCURRENCY", "OPTION"]);

/** Whether the data service chose the listing: a bare symbol, with no venue named and none saved. */
function isBareListing(listing: Pick<CliListing, "exchange" | "saved">): boolean {
  return !listing.exchange && !listing.saved;
}

/**
 * The venues of a bare listing, started beside its data request so naming the
 * choice costs no wait; null for a listing whose venue was named or saved.
 */
export function loadBareVenues(listing: Pick<CliListing, "symbol" | "exchange" | "saved">, deps: ListingDeps): Promise<ListingVenue[]> | null {
  return isBareListing(listing) ? listingVenues(listing.symbol, deps).catch(() => []) : null;
}

/** What the resolver read a typed listing as (7203:TSE as 7203:JPX), for a command's warnings. */
export function listingReadNotes(listing: Pick<ListingArg, "readAs">): string[] {
  return listing.readAs ? [listing.readAs] : [];
}

/**
 * `listingChoiceNote` for a listing a command resolved, from the quote it was
 * read on: only a bare symbol went where the data service chose. A named
 * listing whose code names several venues says which it was read as
 * (`listingReadNotes`). A list, so a command can spread it into its warnings.
 */
export async function listingChoiceNotes(
  listing: Pick<CliListing, "symbol" | "exchange" | "saved" | "readAs">,
  deps: ListingDeps,
  quote: Pick<Quote, "name" | "listingExchangeName" | "exchangeName" | "instrumentType"> | null | undefined,
  /** The venues `loadBareVenues` already started; looked up here when not given. */
  venues?: Promise<ListingVenue[]> | null,
): Promise<string[]> {
  if (!isBareListing(listing)) return listingReadNotes(listing);
  if (!quote || UNLISTED_TYPES.has(quote.instrumentType?.trim().toUpperCase() ?? "")) return [];
  const exchange = canonicalExchange(quote.listingExchangeName || quote.exchangeName);
  if (!exchange) return [];
  const listed = await (venues ?? loadBareVenues(listing, deps) ?? []);
  const note = listingChoiceNote(listing.symbol, { exchange, name: quote.name }, listed);
  return note ? [note] : [];
}

/**
 * `listingChoiceNotes` for a command with no quote of its own to read the
 * listing from (`fn`): it loads the listing's quote, and only for a bare
 * symbol, so a named or saved listing costs nothing.
 */
export async function quotedListingChoiceNotes(
  listing: Pick<CliListing, "symbol" | "exchange" | "saved" | "request" | "readAs">,
  deps: ListingDeps,
): Promise<string[]> {
  const venues = loadBareVenues(listing, deps);
  if (!venues) return listingReadNotes(listing);
  return listingChoiceNotes(listing, deps, await loadListingQuote(deps.dataProvider, listing), venues);
}

/**
 * The same company's line on a US exchange, under the same symbol: SAN:MCE's
 * New York receipt. Null when the US line is another company (SAN:EPA is
 * Sanofi, SAN in New York is Banco Santander) or there is none.
 */
export async function usLineOfListing(
  listing: Pick<ListingArg, "symbol" | "exchange">,
  company: string | null | undefined,
  deps: ListingDeps,
): Promise<ListingVenue | null> {
  if (!listing.exchange || isUsListingExchange(listing.exchange) || !company) return null;
  const venues = await listingVenues(listing.symbol, deps).catch(() => []);
  return venues.find((venue) => isUsListingExchange(venue.exchange) && sameCompany(venue.name, company)) ?? null;
}

/**
 * The company's own listing on a US exchange: its line under the same symbol
 * (SAN:MCE's New York receipt), else the one search finds by its name
 * (Sanofi's SNY for SAN:EPA, Toyota's TM for 7203:JPX). Funds and contracts
 * that carry its name are not its listing. Null for a listing in the US or
 * with no venue, and when the company has no US line search knows.
 */
async function usListingOfCompany(
  listing: Pick<ListingArg, "symbol" | "exchange">,
  company: string | null | undefined,
  deps: ListingDeps,
): Promise<UsListing | null> {
  const sameSymbol = await usLineOfListing(listing, company, deps);
  if (sameSymbol) return { ...sameSymbol, symbol: listing.symbol };
  if (!listing.exchange || isUsListingExchange(listing.exchange)) return null;
  return findUsListingOfCompany(deps.dataProvider, company);
}

/**
 * What a function whose data covers US listings only (the US earnings board,
 * US options and trades, FINRA short interest) says for a listing abroad,
 * instead of a bare error or another company's numbers under the same
 * symbol: "Time and sales covers US listings only, and SAN:EPA is Sanofi on
 * Euronext Paris (EPA).", then the company's US listing with the command that
 * asks for it ("Sanofi's US listing: SNY (try: gloomberb fn TAS SNY)"), or that
 * none was found.
 */
export async function usListingsOnlyMessage(
  what: string,
  listing: Pick<CliListing, "symbol" | "exchange" | "key" | "request" | "saved">,
  deps: ListingDeps,
  retry: (key: string) => string | null,
): Promise<{ message: string; details: string }> {
  const quote = await loadListingQuote(deps.dataProvider, listing);
  const company = listingIdentity(listing, quote).name;
  const named = company ? `${shortCompanyName(company)} on ${exchangeLabel(listing.exchange)}` : exchangeLabel(listing.exchange);
  const us = await usListingOfCompany(listing, company, deps);
  const owner = company ? shortCompanyName(company) : listing.key;
  const command = us ? retry(us.symbol) : null;
  return {
    message: `${what} covers US listings only, and ${listing.key} is ${named}.`,
    details: us
      ? `${owner}'s US listing: ${us.symbol}${command ? ` (try: ${command})` : ""}`
      : `No US listing of ${owner} was found.`,
  };
}

/**
 * A bare symbol goes to its saved listing, else to the one search lists first,
 * unless several companies list it (2222 is Kotobuki Spirits in Tokyo and Saudi
 * Aramco in Riyadh): then it asks, and none of the venues is the answer. Null
 * when it named its exchange.
 */
async function bareListingVenues(listing: BareListing, deps: ListingDeps): Promise<BareListingVenues | null> {
  if (listing.exchange) return null;
  const venues = await listingVenues(listing.symbol, deps).catch(() => []);
  const savedExchange = canonicalExchange(listing.saved?.metadata.exchange);
  if (!savedExchange && listsSeveralCompanies(venues)) return { exchange: "", resolved: null, others: venues, choose: true };
  const resolved = venues.find((venue) => venue.exchange === savedExchange) ?? (savedExchange ? null : venues[0] ?? null);
  const exchange = resolved?.exchange ?? savedExchange;
  if (!exchange) return null;
  return { exchange, resolved, others: venues.filter((venue) => venue !== resolved && venue.exchange !== savedExchange), choose: false };
}

interface OtherListingsMessage {
  message: string;
  details: string;
  /** What `listings` are, as a sentence names them: "Other listings", or "Listings" when none is the one the symbol went to. */
  heading: string;
  /** SAN:EPA, for each other listing. */
  listings: string[];
}

/**
 * The command that asks again for another listing: `gloomberb history SAN:EPA
 * --range 5Y` keeps the options. Null where the request names listings alone.
 */
function retryCommand(request: ListingDataRequest, key: string): string | null {
  if (request.retry !== undefined) return request.retry?.(key) ?? null;
  const [command, ...options] = request.command.split(" ");
  return ["gloomberb", command, key, ...options].join(" ");
}

/**
 * "GC=F Gold future (try: gloomberb quote GC=F)", under a bare futures board
 * code a security keeps (GC, NG) when that security has no data: the future is
 * the other thing the code names. Null for any other symbol.
 */
export function futuresTryLine(symbol: string, request: ListingDataRequest): string | null {
  const future = futuresContractByCode(symbol);
  if (!future) return null;
  const retry = retryCommand(request, future.symbol);
  return `${future.symbol} ${future.name} future${retry ? ` (try: ${retry})` : ""}`;
}

function describeOtherListings(
  listing: BareListing,
  { exchange, resolved, others, choose }: BareListingVenues,
  request: ListingDataRequest,
): OtherListingsMessage | null {
  const future = futuresTryLine(listing.symbol, request);
  if (others.length === 0 && !future) return null;
  const name = resolved?.name || listing.saved?.metadata.name?.trim() || "";
  const lines = others.slice(0, MAX_OTHER_LISTINGS).map((venue) => {
    const key = `${listing.symbol}:${venue.exchange}`;
    const retry = retryCommand(request, key);
    return `${key}${venue.name ? ` ${venue.name}` : ""}${retry ? ` (try: ${retry})` : ""}`;
  });
  if (others.length > MAX_OTHER_LISTINGS) lines.push(`and ${others.length - MAX_OTHER_LISTINGS} more: gloomberb search ${listing.symbol}`);
  if (future) lines.push(future);
  const heading = choose ? "Listings" : "Other listings";
  return {
    // The symbol went to no venue, so none of them is said to lack the data.
    message: choose
      ? `Choose an exchange for ${listing.symbol}.`
      : `${listing.symbol} resolved to ${name ? `${name} (${exchange})` : exchange}, which has no ${request.noun}.`,
    details: lines.length === 1 ? `${heading}: ${lines[0]}` : [`${heading}:`, ...lines.map((line) => `  ${line}`)].join("\n"),
    heading,
    listings: [...others.map((venue) => `${listing.symbol}:${venue.exchange}`), ...future ? [futuresContractByCode(listing.symbol)!.symbol] : []],
  };
}

/**
 * For a bare symbol whose request found no source: the listing it went to and
 * the symbol's other listings, each with the command that asks for it, such
 * as "SXR8 resolved to iShares Core S&P 500 UCITS ETF USD (Acc) (XETRA), which has
 * no history." and "SXR8:BUD iShares Core S&P 500 UCITS ETF USD (Acc) (try:
 * gloomberb history SXR8:BUD)". When several
 * companies list the code, it went to none of them: "Choose an exchange for
 * 2222." and every listing with its retry command, as `2222:` asks. Null when
 * the symbol named its exchange or has no other listing. It searches, so ask
 * only after a request failed.
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
 * so this is left for one it reads on none, and for a home listing with no
 * quote. Search knows where the symbol trades: each listing is asked again by
 * its own key (SXR8:XETRA), as a named one is. The listing the symbol resolved
 * to goes first, then the others together, and the first in search order with a
 * quote is the answer. When none has one, the `otherListingsMessage` failure.
 * A code several companies list (2222) is never answered from one of them: it is
 * that failure, asking which. Null when the symbol named its exchange (a named
 * venue never switches) or search knows no listing of it. It searches, so ask
 * only after a request failed.
 */
export async function quoteBareListing(
  listing: CliListing,
  deps: ListingDeps,
  request: ListingDataRequest,
  { refresh = false }: { refresh?: boolean } = {},
): Promise<BareListingQuote | null> {
  const venues = await bareListingVenues(listing, deps);
  if (!venues) return null;
  if (venues.choose) {
    const other = describeOtherListings(listing, venues, request);
    return other && { kind: "missing", ...other };
  }
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
  return {
    kind: "quoted",
    listing: answer,
    quote: quotes[found]!,
    note: chosenListingNote(listing.symbol, answer.exchange, others, without),
  };
}

/**
 * "IEO -> BATS (other listings: IEX, BMV)": the venue a bare symbol went to,
 * the venues it was not quoted on, and the ones it also trades on.
 */
export function chosenListingNote(symbol: string, exchange: string, others: readonly string[], without: readonly string[] = []): string {
  const more = others.length - MAX_OTHER_LISTINGS;
  const aside = [
    without.length > 0 ? `no quote on ${without.join(", ")}` : "",
    others.length > 0
      ? `other listings: ${others.slice(0, MAX_OTHER_LISTINGS).join(", ")}${more > 0 ? ` and ${more} more: gloomberb search ${symbol}` : ""}`
      : "",
  ].filter(Boolean).join("; ");
  return `${symbol} -> ${exchange}${aside ? ` (${aside})` : ""}`;
}

// A quote this much older than now, and stale, is a listing that stopped trading, not a quiet day.
const ENDED_AFTER_MS = 183 * 24 * 60 * 60_000;

/**
 * The exchange-local date a listing last traded, when its quote is stale and
 * that was over half a year ago (TWTR's 2022-10-27); null for anything newer.
 */
function endedTradingDate(quote: Quote, now = Date.now()): string | null {
  const last = Math.max(...[quote.lastTradeTime, quote.lastUpdated].filter((time): time is number => Number.isFinite(time)));
  if (!(last > 0) || now - last < ENDED_AFTER_MS || !isQuoteStaleForCurrentSession(quote, now)) return null;
  const zone = resolveExchangeTimeZone(quote.listingExchangeName || quote.exchangeName) ?? "UTC";
  return zonedDateKey(last, zone);
}

/** "TWTR: no longer trading since 2022-10-27 (last price $53.86)", for a quote that stopped long ago. */
export function noLongerTradingNote(label: string, quote: Quote, now = Date.now()): string | null {
  const date = endedTradingDate(quote, now);
  if (!date) return null;
  const price = formatMarketPriceWithCurrency(quote.price, quote.currency, quoteFormatOptions(quote));
  return `${label}: no longer trading since ${date} (last price ${price})`;
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
  if (listing.sharedCode) {
    // 7203:TSE is the row saved on any venue TSE names.
    for (const exchange of exchangeCodeVenues(listing.sharedCode)) {
      const saved = await loadSavedListing(store, { symbol: listing.symbol, exchange, key: `${listing.symbol}:${exchange}` });
      if (saved) return saved;
    }
    return null;
  }
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
  const parsed = parseListingArg(raw, exchangeOption, options);
  if (!parsed.symbol) throw new ListingArgError("Ticker symbol is required.");
  await checkListingExchange(parsed, deps);
  let listing = await settleSharedCode(parsed, deps);
  const saved = await loadSavedListing(deps.store, listing);
  // A code nothing could read stays the venue it is saved on.
  const savedExchange = canonicalExchange(saved?.metadata.exchange);
  if (listing.sharedCode && savedExchange) listing = { symbol: listing.symbol, exchange: savedExchange, key: `${listing.symbol}:${savedExchange}` };
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
    if (listing.symbol.endsWith(":") || (listing.exchange && !isKnownExchangeCode(listing.exchange)) || listing.sharedCode) {
      return await withMarketData(ctx, async (market) => {
        await checkListingExchange(listing, market);
        return settleSharedCode(listing, market);
      });
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
  listing: Pick<CliListing, "symbol" | "exchange" | "saved">,
  quote?: Pick<Quote, "name" | "listingExchangeName" | "exchangeName"> | null,
): ListingIdentity {
  const quoteExchange = canonicalExchange(quote?.listingExchangeName || quote?.exchangeName);
  const exchange = listing.exchange || quoteExchange || canonicalExchange(listing.saved?.metadata.exchange);
  // A quote that prices another venue names another listing's company.
  const quoteName = !quoteExchange || quoteExchange === exchange ? quote?.name?.trim() : undefined;
  return { symbol: listing.symbol, exchange, name: quoteName || listing.saved?.metadata.name?.trim() || null };
}

/** The listing's own quote, for its company name and venue; null when it has none. */
export async function loadListingQuote(dataProvider: DataProvider, listing: Pick<CliListing, "request">): Promise<Quote | null> {
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
