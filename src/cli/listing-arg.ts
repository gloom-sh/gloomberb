import { logFailure } from "../utils/log-failure";
import type { DataProvider } from "../types/data-provider";
import type { Quote } from "../types/financials";
import type { CliCommandContext } from "../types/plugin";
import type { TickerRecord } from "../types/ticker";
import { perpetualListingOfMarket, typedPerpetualListing } from "../tickers/perpetual-listing";
import {
  listingVenues,
  quotedOnVenue,
  readAmbiguousCurrencyPair,
  readSharedCode,
  savedRowOfBareSymbol,
  type ListingDeps,
  type ListingStore,
  type ListingVenue,
} from "../tickers/listing-venues";
import { findUsListingOfCompany, type UsListing } from "../tickers/us-listing";
import { findListingOfCompanyName, isCompanyNameInput, readTerminalCodeArg, type CompanyNameListing } from "../tickers/company-name-listing";
import { movedAwayChange, startTickerChangeLookup, type MovedTickerChange } from "../tickers/ticker-changes";
import { loadListingFate, MovedSymbolError, type ListingFate } from "../tickers/listing-fate";
import { quotedListingName } from "../tickers/listing-name";
import { cliStyles } from "../utils/cli-output";
import { groupByCompany, namesDepositaryReceipt, sameCompany, sameListedName, shortCompanyName } from "../tickers/company-name";
import {
  canonicalExchange,
  exchangeCodeVenues,
  exchangeLabel,
  isKnownExchangeCode,
  isSharedExchangeCode,
  isUsListingExchange,
  parsePublicTickerKey,
  publicTickerKey,
  typedExchangeCode,
} from "../utils/exchanges";
import { withMarketData } from "./scoped-context";
import { failWithFields } from "./errors";
import { stripStrayEdges } from "./symbol-args";
import { isNoProviderMessage, isNoSourceAnswer, isProviderBusy } from "../sources/provider-errors";
import { dashedCoinPair, exchangeLineCoinListing, MAJOR_COIN_NAMES } from "../utils/crypto-pair";
import { boardCoinFor, primeBoardCoins } from "./board-coins";
import { knownGapMessage } from "./known-gaps";
import { currencyPairSpelling } from "../utils/currency-pair";
import { bareFuturesCode, futuresContractByCode } from "../market-data/futures-board";
import { classifyInstrumentType, kindFromListingSyntax } from "../tickers/instrument-kind";
import type { InstrumentOfKind } from "../tickers/instrument-coverage";
import { brokerIndexCode, brokerIndexReadAs } from "./index-roots";
import {
  bloombergCodeOf,
  bloombergMarketHint,
  endsInLegalForm,
  isSearchOnlyVenue,
  readLondonDottedSymbol,
  readNearMissListing,
  readTerminalListingCode,
  terminalCodeReadAs,
  unknownBloombergMarket,
  type NearMissListing,
  type TerminalListingCode,
} from "../tickers/terminal-codes";
import { listingAbroadVenue } from "../utils/sec";
import { savedAbroadForBareSymbol, savedUsListingOf } from "../tickers/search/bare-symbol";
import { listingSuffixCandidate, listingSuffixVenue, tickerHasListingSuffix } from "../sources/listing-symbols";
import { notTheCoinNote } from "./commands/crypto-hints";

/** The `--exchange` option of every command that takes a ticker. */
export const EXCHANGE_OPTION = {
  flags: "--exchange <code>",
  description: "Listing exchange, for a symbol that trades in several places (same as SYMBOL:CODE)",
};

/** One listing a symbol's question names: BDI:TSX and its company. */
export interface ListingChoice {
  key: string;
  name: string | null;
}

export class ListingArgError extends Error {
  constructor(
    message: string,
    readonly details?: string,
    /** The listings it asks to choose between, when it asks which. */
    readonly choices?: readonly ListingChoice[],
  ) {
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
  /**
   * The company's common stock a name read as a fund or an index means
   * (`CompanyNameListing.meant`): JPM for "JP Morgan" read as ^JTEK:NIM.
   * `readAs` asks about it, and a command the listing fails asks too.
   */
  meant?: { symbol: string; name: string };
}

/** "Did you mean JPM (JPMorgan Chase & Co.)?", for a name read as a fund or an index; empty for any other listing. */
export function meantQuestion(listing: Pick<ListingArg, "meant">): string {
  const meant = listing.meant;
  if (!meant) return "";
  return `Did you mean ${meant.name && meant.name.toUpperCase() !== meant.symbol ? `${meant.symbol} (${meant.name})` : meant.symbol}?`;
}

/**
 * `SAN:EPA` and `SAN --exchange EPA` name the same listing. Both spellings of
 * an exchange go through the app's alias table, so `SAN:XPAR` is `SAN:EPA`.
 * A symbol's own exchange and `--exchange` that disagree are an error, unless
 * the command takes several symbols and `--exchange` only fills in the ones
 * without an exchange of their own. A code that names several venues (TSE)
 * agrees with any of them. A futures board code no listed security uses is
 * its future: TTF is TTF=F, while NG stays NovaGold. A currency pair is the
 * one listing the service has for it, however it is written: EUR/USD,
 * EURUSD:CCY and JPY=X are EURUSD=X and USDJPY=X, so every spelling asks for
 * the same quote. USD-NGN and USDNGN could be a security's symbol, so
 * `resolveCliListing` asks search before reading them as USDNGN=X.
 */
export function parseListingArg(
  rawArg: string,
  exchangeOption?: string | null,
  { ownExchangeWins = false, terminalCode, listingSuffix = false }: {
    ownExchangeWins?: boolean;
    /**
     * The terminal code `readTerminalCodeArg` read the text as, or null for
     * words that read as a Bloomberg code but are a name. Read here when not given.
     */
    terminalCode?: TerminalListingCode | null;
    /**
     * Read a vendor's venue suffix as the venue it names (GARAN.IS as
     * GARAN:BIST, `listingSuffixVenue`), so what is saved, found or removed is
     * the listing's one row. Commands that store a listing ask for it.
     */
    listingSuffix?: boolean;
  } = {},
): ListingArg {
  // A pasted ticker can bring the separator or quote marks that sat beside it (`UPST;`); search would ask for them.
  const stripped = stripStrayEdges(rawArg);
  const raw = stripped.text || rawArg;
  // A terminal's code (WFC.N, "VOD LN", "JPM US Equity") is that listing (WFC:NYSE, VOD:LSE, JPM), and a symbol
  // written nearly as one is (700.HK, 6758.JP, BRK/B) its working form (0700.HK, 6758.T, BRK-B).
  const terminal = terminalCode === undefined ? readTerminalListingCode(raw) : terminalCode;
  const nearMiss = terminal ? null : readNearMissListing(raw);
  const reading = terminal ?? (nearMiss ? { typed: nearMiss.typed, key: nearMiss.symbol } : null);
  const parsed = parseCleanListingArg(reading?.key ?? raw, exchangeOption, { ownExchangeWins });
  const listing = listingSuffix ? readListingSuffix(parsed) ?? parsed : parsed;
  const notes = [...stripped.text ? stripped.notes : [], ...reading ? [terminalCodeReadAs(reading)] : []];
  return notes.length > 0 ? { ...listing, readAs: notes.join(" ") } : listing;
}

function parseCleanListingArg(
  raw: string,
  exchangeOption: string | null | undefined,
  { ownExchangeWins }: { ownExchangeWins: boolean },
): ListingArg {
  const optionCode = (exchangeOption ?? "").trim().toUpperCase();
  const option = canonicalExchange(optionCode);
  // VIX.X and $VIX.X, a broker's code for an index, are its own symbol ^VIX; $VIX is read in `resolveCliListing`.
  const index = option ? null : brokerIndexCode(raw);
  if (index && !index.bare) return { symbol: index.symbol, exchange: "", key: index.symbol, readAs: brokerIndexReadAs(index) };
  // A perpetual's market id (binance:BZUSDT, as PERP names it) is its listing on that venue (BZUSDT:BINANCE).
  let typed = (typedPerpetualListing(raw)?.key ?? raw).trim().replace(/^\$/, "").toUpperCase();
  // `SAN:` asks which listing; with --exchange it has its answer.
  if (option && typed.endsWith(":")) typed = typed.slice(0, -1);
  const venueKey = parsePublicTickerKey(typed);
  // A crypto exchange's line of a pair (BTC/GBP:COINBASE PRO, as search offered it) is the crypto venue's BTC-GBP:CCC.
  const line = venueKey.exchange || optionCode ? exchangeLineCoinListing(venueKey.symbol, venueKey.exchange ?? optionCode) : null;
  if (line) return { symbol: line.symbol, exchange: line.exchange, key: `${line.symbol}:${line.exchange}` };
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
  const pair = currencyPairSpelling(parsed.symbol, exchange);
  if (pair && !pair.ambiguous) return { symbol: pair.symbol, exchange: "", key: pair.symbol };
  const shared = isSharedExchangeCode(code) ? { sharedCode: code } : {};
  if (exchange) return { symbol: parsed.symbol, exchange, key: `${parsed.symbol}:${exchange}`, ...shared };
  // A futures board code no security uses is its future: TTF is TTF=F.
  const symbol = bareFuturesCode(parsed.symbol)?.symbol ?? parsed.symbol;
  return { symbol, exchange, key: symbol };
}

export { listingVenues, type ListingDeps, type ListingVenue };

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
  const { symbol } = listing;
  const meanings = exchangeCodeVenues(code);
  const reading = await readSharedCode(symbol, code, deps);
  if (reading.kind === "several") {
    throw new ListingArgError(
      `${code} is ${venueChoices(meanings)}, and ${symbol} trades on ${reading.venues.join(" and ")}.`,
      `Name one: ${reading.venues.map((venue) => `${symbol}:${venue}`).join(" or ")}.`,
    );
  }
  if (reading.kind === "unknown") return listing;
  if (reading.kind === "none") {
    throw new ListingArgError(`${code} is ${venueChoices(meanings)}, and ${symbol} trades on none of them.${tradesOn(symbol, reading.venues)}`);
  }
  const { exchange } = reading;
  const key = `${symbol}:${exchange}`;
  const readAs = [
    listing.readAs,
    exchange === meanings[0] ? null : `Read ${symbol}:${code} as ${key}: ${code} is ${venueChoices(meanings)}, and ${symbol} trades on ${exchange}.`,
  ].filter(Boolean).join(" ");
  return { symbol, exchange, key, ...readAs ? { readAs } : {} };
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
  // A row saved on that venue says it is real (GARAN:BIST, which the exchange table lacks), with no request.
  if (await loadSavedListing(deps.store, listing)) return;
  const venues = await listingVenues(listing.symbol, deps);
  if (venues.some((venue) => venue.exchange === listing.exchange)) return;
  // Search busy, or missing the venue: the listing's own quote there settles it, as `quote` reads it.
  if (await quotedOnVenue(listing, deps)) return;
  throw new ListingArgError(
    `Unknown exchange ${listing.exchange} for ${listing.symbol}.${tradesOn(listing.symbol, venues)}`,
    venues.length > 0 ? undefined : `No listings of ${listing.symbol} were found.`,
  );
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
  const venues = await listingVenues(listing.symbol, deps).catch(logFailure("cli.listing-arg", "Read listing venues failed", []));
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
   * command (`gloom watchlist add Growth SAN:EPA`); null names the listings alone.
   */
  retry?: ((key: string) => string) | null;
  /**
   * What became of the symbol (`loadListingFate`), for a command a listing
   * that stopped trading has nothing for (history, options): a request no
   * source serves fails with `fate.note` instead of the source's miss, and the
   * change line leads any listings the failure names. A symbol whose company
   * moved, with nothing new listed under it, fails naming its new symbol
   * whatever came back (`failMovedSymbol`).
   */
  fate?: () => Promise<ListingFate>;
}

/**
 * The router's answer when no source serves a symbol: "No history provider available for 2222",
 * or "Not a ticker: 2222." when the service found no listing for it.
 */
export function isNoProviderError(error: unknown): boolean {
  return isNoProviderMessage(error instanceof Error ? error.message : String(error ?? ""));
}

/**
 * The router's answer that no source served a request because one failed (a
 * timeout, a rate limit, a refused session) rather than missed: it says
 * nothing about whether the symbol exists, unlike "Not a ticker".
 */
export function isUnsettledNoProvider(error: unknown): boolean {
  return isNoProviderError(error) && !isNoSourceAnswer(error);
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

/**
 * Every other company or fund that lists the symbol, once, at its first venue
 * in search order. A venue is another's only when its name says so: one with
 * no name, or a depositary receipt named unlike the company (a CEDEAR's short
 * form of its fund's name), is left out rather than guessed at, and one
 * fund's venues are one fund however each words it (`sameListedName`).
 */
function otherCompanies(venues: readonly ListingVenue[], company: string): ListingVenue[] {
  if (!company.trim()) return [];
  const known = venues.filter((venue) => !namesDepositaryReceipt(venue.name) || sameListedName(venue.name, company));
  return groupByCompany(known, (venue) => venue.name, sameListedName)
    .filter((group) => !group.some((venue) => sameListedName(venue.name, company)))
    .map((group) => group[0]!);
}

/**
 * "CAR = Avis Budget Group, NASDAQ (different companies on XETRA, ASX)": the
 * listing a bare symbol several companies list was read on, and where the
 * others list it. Null when no other company is known to list it, so a symbol
 * that means one thing (XLK, and its receipt in Buenos Aires) says nothing.
 */
export function listingChoiceNote(
  symbol: string,
  chosen: { exchange: string; name?: string | null },
  venues: readonly ListingVenue[],
): string | null {
  if (!chosen.exchange) return null;
  const chosenVenue = venues.find((venue) => venue.exchange === chosen.exchange);
  const name = chosen.name?.trim() || chosenVenue?.name || "";
  const others = otherCompanies(venues, chosenVenue?.name || name).map((venue) => venue.exchange)
    .filter((exchange) => exchange !== chosen.exchange);
  if (others.length === 0) return null;
  const more = others.length - MAX_OTHER_LISTINGS;
  const named = `${others.slice(0, MAX_OTHER_LISTINGS).join(", ")}${more > 0 ? ` and ${more} more: gloom search ${symbol}` : ""}`;
  const which = others.length === 1 ? "a different company" : "different companies";
  return `${symbol} = ${name ? `${shortCompanyName(name)}, ` : ""}${chosen.exchange} (${which} on ${named})`;
}

// Quotes of these never name a company's listing, so they are never a choice between companies.
export const UNLISTED_TYPES = new Set(["FUTURE", "INDEX", "CURRENCY", "CRYPTOCURRENCY", "OPTION"]);

/** Whether the data service chose the listing: a bare symbol, with no venue named and none saved. */
function isBareListing(listing: Pick<CliListing, "exchange" | "saved">): boolean {
  return !listing.exchange && !listing.saved;
}

/**
 * The venues of a bare listing, started beside its data request so naming the
 * choice costs no wait; null for a listing whose venue was named or saved.
 */
export function loadBareVenues(listing: Pick<CliListing, "symbol" | "exchange" | "saved">, deps: ListingDeps): Promise<ListingVenue[]> | null {
  return isBareListing(listing) ? listingVenues(listing.symbol, deps).catch(logFailure("cli.listing-arg", "Read listing venues failed", [])) : null;
}

/** What the resolver read a typed listing as (7203:TSE as 7203:JPX), for a command's warnings. */
export function listingReadNotes(listing: Pick<ListingArg, "readAs">): string[] {
  return listing.readAs ? [listing.readAs] : [];
}

/**
 * The coin line for a bare coin ticker (SOL, ETH) a command read as a listing that is
 * not the coin, from the quote it was read on (`notTheCoinNote`). A list, so a command can
 * spread it into its warnings. A named listing (`ETH:ARCA`, `--exchange`) asked for that
 * listing on purpose and gets none.
 */
export function coinListingNotes(
  listing: Pick<CliListing, "symbol" | "exchange">,
  quote: Pick<Quote, "name" | "instrumentType" | "stale" | "delisting"> | null | undefined,
): string[] {
  const note = listing.exchange ? null : notTheCoinNote(listing.symbol, quote);
  return note ? [note] : [];
}

/**
 * `listingChoiceNote` for a listing a command resolved, from the quote it was
 * read on: only a bare symbol went where the data service chose. A named
 * listing whose code names several venues says which it was read as
 * (`listingReadNotes`). A bare coin ticker read as another listing ends with
 * the coin's pair (`coinListingNotes`). A list, so a command can spread it into
 * its warnings.
 */
export async function listingChoiceNotes(
  listing: Pick<CliListing, "symbol" | "exchange" | "saved" | "readAs">,
  deps: ListingDeps,
  quote: Pick<Quote, "name" | "listingExchangeName" | "exchangeName" | "instrumentType" | "stale" | "delisting"> | null | undefined,
  /** The venues `loadBareVenues` already started; looked up here when not given. */
  venues?: Promise<ListingVenue[]> | null,
): Promise<string[]> {
  const coin = coinListingNotes(listing, quote);
  if (!isBareListing(listing)) return [...listingReadNotes(listing), ...coin];
  if (!quote || UNLISTED_TYPES.has(quote.instrumentType?.trim().toUpperCase() ?? "")) return coin;
  const exchange = canonicalExchange(quote.listingExchangeName || quote.exchangeName);
  if (!exchange) return coin;
  const listed = await (venues ?? loadBareVenues(listing, deps) ?? []);
  const note = listingChoiceNote(listing.symbol, { exchange, name: quote.name }, listed);
  return [...note ? [note] : [], ...coin];
}

/**
 * `listingChoiceNotes` for a command with no quote of its own to read the
 * listing from (`fn`): it loads the listing's quote, and only for a bare
 * symbol, so a named or saved listing costs nothing. A bare coin ticker read
 * as another listing (BTC, the Grayscale trust) ends with the coin's pair.
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
  const venues = await listingVenues(listing.symbol, deps).catch(logFailure("cli.listing-arg", "Read listing venues failed", []));
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
 * asks for it ("Sanofi's US listing: SNY (try: gloom fn TAS SNY)"), or that
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
  const venues = await listingVenues(listing.symbol, deps).catch(logFailure("cli.listing-arg", "Read listing venues failed", []));
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
  /** Each other listing and its company. */
  choices: ListingChoice[];
  /** Several companies list the symbol, so it went to none of them and the message asks which. */
  choose: boolean;
}

/**
 * The command that asks again for another listing: `gloom history SAN:EPA
 * --range 5Y` keeps the options. Null where the request names listings alone.
 */
function retryCommand(request: Pick<ListingDataRequest, "command" | "retry">, key: string): string | null {
  if (request.retry !== undefined) return request.retry?.(key) ?? null;
  const [command, ...options] = request.command.split(" ");
  return ["gloom", command, key, ...options].join(" ");
}

/**
 * "GC=F Gold future (try: gloom quote GC=F)", under a bare futures board
 * code a security keeps (GC, NG) when that security has no data: the future is
 * the other thing the code names. Null for any other symbol.
 */
export function futuresTryLine(symbol: string, request: ListingDataRequest): string | null {
  const future = futuresContractByCode(symbol);
  if (!future) return null;
  const retry = retryCommand(request, future.symbol);
  return `${future.symbol} ${future.name} future${retry ? ` (try: ${retry})` : ""}`;
}

/** A venue's listing as its key names it: under its own symbol there (BP:LSE for `BP.`), else the one asked for. */
function venueKey(symbol: string, venue: Pick<ListingVenue, "exchange" | "symbol">): string {
  return `${venue.symbol ?? symbol}:${venue.exchange}`;
}

function describeOtherListings(
  listing: BareListing,
  { exchange, resolved, others, choose }: BareListingVenues,
  request: ListingDataRequest,
  /** Listings just asked that had none: named as having none, never offered to try. */
  without: readonly ListingVenue[] = [],
): OtherListingsMessage | null {
  const future = futuresTryLine(listing.symbol, request);
  const offered = others.filter((venue) => !without.includes(venue));
  if (offered.length === 0 && !future && without.length === 0) return null;
  const name = resolved?.name || listing.saved?.metadata.name?.trim() || "";
  const lines = offered.slice(0, MAX_OTHER_LISTINGS).map((venue) => {
    const key = venueKey(listing.symbol, venue);
    const retry = retryCommand(request, key);
    return `${key}${venue.name ? ` ${venue.name}` : ""}${retry ? ` (try: ${retry})` : ""}`;
  });
  if (offered.length > MAX_OTHER_LISTINGS) lines.push(`and ${offered.length - MAX_OTHER_LISTINGS} more: gloom search ${listing.symbol}`);
  if (future) lines.push(future);
  // Every other listing was asked and had nothing: they are named as such, with nothing to try.
  const heading = choose ? "Listings" : lines.length === 0 ? `No ${request.noun} on its other listings either` : "Other listings";
  const named = lines.length === 0 ? without : offered;
  const details = lines.length === 0 ? `${heading}: ${without.map((venue) => venueKey(listing.symbol, venue)).join(", ")}.`
    : lines.length === 1 ? `${heading}: ${lines[0]}` : [`${heading}:`, ...lines.map((line) => `  ${line}`)].join("\n");
  return {
    // The symbol went to no venue, so none of them is said to lack the data.
    message: choose
      ? `Choose an exchange for ${listing.symbol}.`
      : `${listing.symbol} resolved to ${name ? `${name} (${exchange})` : exchange}, which has no ${request.noun}.`,
    details,
    heading,
    listings: [...named.map((venue) => venueKey(listing.symbol, venue)), ...future ? [futuresContractByCode(listing.symbol)!.symbol] : []],
    choices: offered.slice(0, MAX_OTHER_LISTINGS).map((venue) => ({ key: venueKey(listing.symbol, venue), name: venue.name || null })),
    choose,
  };
}

/**
 * For a bare symbol whose request found no source: the listing it went to and
 * the symbol's other listings, each with the command that asks for it, such
 * as "SXR8 resolved to iShares Core S&P 500 UCITS ETF USD (Acc) (XETRA), which has
 * no history." and "SXR8:BUD iShares Core S&P 500 UCITS ETF USD (Acc) (try:
 * gloom history SXR8:BUD)". When several
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

/** The listing on one venue, as `SYM:EXCH` names it, under the venue's own symbol when search lists one. */
function namedListing(listing: CliListing, venue: Pick<ListingVenue, "exchange" | "symbol">): CliListing {
  const { exchange } = venue;
  const symbol = venue.symbol ?? listing.symbol;
  const key = `${symbol}:${exchange}`;
  const saved = canonicalExchange(listing.saved?.metadata.exchange) === exchange ? listing.saved : null;
  return { symbol, exchange, key, saved, request: { symbol: key, exchange } };
}

/**
 * Each listing's quote, null where it has none; `undefined` where the request
 * itself failed, which says nothing of whether it has one.
 */
async function quoteListings(
  dataProvider: DataProvider,
  listings: readonly CliListing[],
  refresh: boolean,
  datesChangeBasis = false,
): Promise<Array<Quote | null | undefined>> {
  if (listings.length === 0) return [];
  const targets = listings.map((listing) => listing.request);
  if (dataProvider.getQuotesBatch) {
    const results = await dataProvider.getQuotesBatch(targets, { forceRefresh: refresh, ...(datesChangeBasis ? { datesChangeBasis } : {}) })
      .catch(logFailure("cli.listing-arg", "Read listing quote batch failed", null));
    if (!results) return targets.map(() => undefined);
    return targets.map((target, index) => {
      const result = results.find((entry) => entry.target === target) ?? results[index];
      // No source quotes it, which is an answer; any other failure is none.
      return result?.quote ?? (result && (result.error == null || isNoProviderError(result.error)) ? null : undefined);
    });
  }
  return Promise.all(targets.map((target) => dataProvider.getQuote(target.symbol, target.exchange, {
    cacheMode: refresh ? "refresh" : "default",
    ...(datesChangeBasis ? { datesChangeBasis } : {}),
  }).catch((error: unknown) => {
    logFailure("cli.listing-arg", "Read listing quote failed")(error);
    return isNoProviderError(error) ? null : undefined;
  })));
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
  { refresh = false, datesChangeBasis = false }: { refresh?: boolean; datesChangeBasis?: boolean } = {},
): Promise<BareListingQuote | null> {
  const venues = await bareListingVenues(listing, deps);
  if (!venues) return null;
  if (venues.choose) {
    const other = describeOtherListings(listing, venues, request);
    return other && { kind: "missing", ...other };
  }
  const first = [namedListing(listing, venues.resolved ?? { exchange: venues.exchange })];
  const rest = venues.others.map((venue) => namedListing(listing, venue));
  let tried = first;
  let quotes = await quoteListings(deps.dataProvider, first, refresh, datesChangeBasis);
  if (!quotes[0] && rest.length > 0) {
    tried = [...first, ...rest];
    quotes = [...quotes, ...await quoteListings(deps.dataProvider, rest, refresh, datesChangeBasis)];
  }
  const found = quotes.findIndex(Boolean);
  if (found < 0) {
    // A listing just asked that had no quote is no listing to try.
    const without = venues.others.filter((_venue, index) => quotes[index + 1] === null);
    const other = describeOtherListings(listing, venues, request, without);
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
    // Under the venue's own symbol (BP:LSE for `BP.`), the note names the listing, not only its venue.
    note: chosenListingNote(listing.symbol, answer.symbol === listing.symbol ? answer.exchange : answer.key, others, without),
  };
}

/** A bare symbol as `quote` reads it (`readBareListing`). */
export interface ReadListing {
  symbol: string;
  /** The venue it was read on: the one it is saved on, or the listing that quoted it; empty when its own quote answered on none named. */
  exchange: string;
  /** The listing's company, from its quote. */
  name: string | null;
  /** A bare coin ticker read as a listing that is not the coin (`coinListingNotes`); null otherwise. */
  coinNote: string | null;
}

/**
 * A bare symbol read as `quote` reads it, for a command that draws its data
 * without asking for a quote (a chart's series): its own quote answers it, a
 * symbol no source quotes is read on the first of its listings that has one
 * (`quoteBareListing`), and a code several companies list (BDI is Black
 * Diamond Group in Toronto and B. D. Industries in Pune) fails asking which,
 * with `quote`'s message and each listing's retry. Null when nothing better
 * than the symbol itself is known, so the command's own request speaks.
 */
export async function readBareListing(
  symbol: string,
  deps: ListingDeps,
  request: ListingDataRequest,
  { refresh = false }: { refresh?: boolean } = {},
): Promise<ReadListing | null> {
  const listing = await resolveCliListing(symbol, null, deps);
  if (listing.exchange) return null;
  const answer = await loadListingQuoteAnswer(deps.dataProvider, listing);
  if (answer.quote) {
    return { symbol: listing.symbol, exchange: listing.request.exchange, name: answer.quote.name?.trim() || null, coinNote: coinListingNotes(listing, answer.quote)[0] ?? null };
  }
  if (!isNoProviderError(answer.error)) return null;
  const other = await quoteBareListing(listing, deps, request, { refresh });
  if (other?.kind === "quoted") {
    return { symbol: listing.symbol, exchange: other.listing.exchange, name: other.quote.name?.trim() || null, coinNote: coinListingNotes(listing, other.quote)[0] ?? null };
  }
  if (other?.choose) throw new ListingArgError(other.message, other.details, other.choices);
  return null;
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
      ? `other listings: ${others.slice(0, MAX_OTHER_LISTINGS).join(", ")}${more > 0 ? ` and ${more} more: gloom search ${symbol}` : ""}`
      : "",
  ].filter(Boolean).join("; ");
  return `${symbol} -> ${exchange}${aside ? ` (${aside})` : ""}`;
}

/**
 * "HFC became DINO on 2022-03-15: `gloom history DINO`": a symbol whose
 * company moved, with the command that asks for it under its new symbol.
 */
export function movedSymbolLine(change: MovedTickerChange, retry: string | null): string {
  return retry ? `${change.note}: \`${retry}\`` : change.note;
}

/**
 * Fails a command that has nothing to serve for a symbol whose company
 * moved (`ListingFate.moved`) with `movedSymbolLine`; `--json` reads the
 * change as quote rows carry it (`tickerChange`) and the command that asks
 * for the new symbol (`retry`). Exits as any failure does.
 */
export function failMovedSymbol(change: MovedTickerChange, request: Pick<ListingDataRequest, "command" | "retry">): never {
  const retry = retryCommand(request, change.tradesAs);
  return failWithFields(movedSymbolLine(change, retry), "ticker_moved", { tickerChange: change, retry });
}

/**
 * `loadListingFate` for a command's listing, looked up once whenever it is
 * asked for: the change lookup starts now, beside the command's own request,
 * and the fate reads the quote the command loads.
 */
export function listingFateLoader(
  listing: Pick<CliListing, "symbol" | "exchange" | "request">,
  deps: Pick<ListingDeps, "dataProvider">,
  quote: Promise<Quote | null>,
): () => Promise<ListingFate> {
  const changes = startTickerChangeLookup(deps.dataProvider, listing.symbol, listing.exchange);
  let fate: Promise<ListingFate> | null = null;
  return () => fate ??= loadListingFate(listing, deps.dataProvider, { quote, changes });
}

/**
 * A command's load for one listing beside its fate (`listingFateLoader`): a
 * symbol whose company moved serves nothing, whatever came back or failed,
 * and the command fails naming its new symbol (`failMovedSymbol`). A loader
 * that finds that itself (`MovedSymbolError`) fails the same way.
 */
export async function refuseMovedListing<T>(
  fate: (() => Promise<ListingFate>) | null,
  request: Pick<ListingDataRequest, "command" | "retry">,
  load: () => Promise<T>,
): Promise<T> {
  let value: T;
  try {
    value = await load();
  } catch (error) {
    if (error instanceof MovedSymbolError) failMovedSymbol(error.change, request);
    const moved = (await fate?.())?.moved;
    if (moved) failMovedSymbol(moved, request);
    throw error;
  }
  const moved = (await fate?.())?.moved;
  if (moved) failMovedSymbol(moved, request);
  return value;
}

/**
 * "Read 247540:KRX on KOSDAQ, where 247540 trades." for a listing Gloom Cloud
 * quoted from the board its symbol trades on rather than the one asked for: a
 * KOSDAQ code saved on KRX before search listed it on KOSDAQ. Null when the
 * quote is the listing's own line.
 */
export function tradingBoardNote(
  listing: Pick<CliListing, "symbol" | "request">,
  quote: Pick<Quote, "tradingExchangeName" | "listingExchangeName" | "exchangeName"> | null | undefined,
): string | null {
  const board = canonicalExchange(quote?.tradingExchangeName);
  const asked = canonicalExchange(listing.request.exchange || quote?.listingExchangeName || quote?.exchangeName);
  return board && asked && board !== asked ? `Read ${listing.symbol}:${asked} on ${board}, where ${listing.symbol} trades.` : null;
}

/**
 * Ends a command with what it says for a bare symbol no source serves: a
 * company that moved is under its new symbol, else the listing the symbol went
 * to and the others (`other`, from `otherListingsMessage`), else what became of
 * it. Returns when there is nothing to say.
 */
async function failUnservedListing(
  ctx: Pick<CliCommandContext, "fail">,
  request: ListingDataRequest,
  other: Promise<OtherListingsMessage | null>,
): Promise<void> {
  const [listings, fate] = await Promise.all([other, request.fate?.() ?? null]);
  // Nothing served either way: a company that moved is under its new symbol, before any other listing.
  const moved = movedAwayChange(fate?.change);
  if (moved) failMovedSymbol(moved, request);
  if (listings) ctx.fail(listings.message, [fate?.note, listings.details].filter(Boolean).join("\n"));
  if (fate?.note) ctx.fail(`${fate.note}.`);
}

/**
 * Refuses a bare symbol several companies list (FP is a newspaper group in
 * Toronto and Fondul Proprietatea in Bucharest) with the message `quote`
 * gives it, whatever the command's own request served: the data service answers
 * a history for the bare symbol from one of the listings, which is a pick the
 * user never made. Asked once the symbol's own quote (`loadListingQuoteAnswer`)
 * failed with no provider, so a symbol with a quote, a named or saved listing,
 * and a symbol one company lists go on as they were. It searches, so ask only then.
 */
export async function failUnchosenListing(
  listing: BareListing,
  deps: ListingDeps,
  ctx: Pick<CliCommandContext, "fail">,
  request: ListingDataRequest,
  quoteError: unknown,
): Promise<void> {
  if (!isNoProviderError(quoteError)) return;
  const venues = await bareListingVenues(listing, deps);
  if (venues?.choose) await failUnservedListing(ctx, request, Promise.resolve(describeOtherListings(listing, venues, request)));
}

/**
 * A data request for the listings a command named. When it throws, or `isMiss`
 * calls what it returned empty, and a listing's exchange is one its symbol does
 * not trade on, the command ends in that message instead of the request's own
 * "unavailable". With `request`, a bare symbol no source serves ends naming
 * its other listings (`otherListingsMessage`), and with `request.fate` a symbol
 * whose company moved ends naming its new symbol, served or not. A request
 * that succeeds costs no extra lookup beyond the fate the command reads anyway.
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
    if (request && all.length === 1 && isNoProviderError(error)) await failUnservedListing(ctx, request, otherListingsMessage(all[0]!, deps, request));
    throw error;
  }
  if (isMiss?.(value)) await checkVenues();
  // Data came back, but the symbol's company moved and nothing new lists there: the data is another security's.
  if (request?.fate && all.length === 1) {
    const { moved } = await request.fate();
    if (moved) failMovedSymbol(moved, request);
  }
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

/**
 * The listings a typed symbol may be saved as, most likely first. With a
 * vendor's suffix, its venue's listing (GARAN.IS as GARAN:BIST, 7203.T as
 * 7203:JPX), then the suffixed key as typed, for a row saved under it: a
 * broker's, or MKC.V, a US share class the suffix only looks like. A
 * one-letter suffix's venue is a guess that a row saved there confirms
 * (`loadSavedListingOf`). One listing for anything else.
 */
export function savedListingCandidates(raw: string, exchangeOption?: string | null, options: { ownExchangeWins?: boolean } = {}): ListingArg[] {
  const literal = parseListingArg(raw, exchangeOption, options);
  const venue = literal.exchange ? null : listingSuffixCandidate(literal.symbol);
  if (!venue) return [literal];
  return [{ symbol: venue.symbol, exchange: venue.exchange, key: `${venue.symbol}:${venue.exchange}`, ...literal.readAs ? { readAs: literal.readAs } : {} }, literal];
}

/**
 * The first of the listings that is saved, with its row; one `wanted` says is
 * meant (held in the list a command changes) before any other. Null when none is.
 */
export async function loadSavedListingOf(
  store: ListingStore,
  listings: readonly ListingArg[],
  wanted?: (ticker: TickerRecord) => boolean,
): Promise<{ listing: ListingArg; ticker: TickerRecord } | null> {
  const found: Array<{ listing: ListingArg; ticker: TickerRecord }> = [];
  const add = (listing: ListingArg, ticker: TickerRecord | null | undefined) => {
    if (ticker && !found.some((entry) => entry.ticker.metadata.ticker === ticker.metadata.ticker)) found.push({ listing, ticker });
  };
  for (const listing of listings) {
    if (found.some((entry) => entry.listing.key === listing.key)) continue;
    const ticker = await loadSavedListing(store, listing);
    // A bare symbol's US listing comes before a row abroad saved under its bare key (SHEL, saved from SHEL.L).
    if (ticker && !listing.exchange && savedAbroadForBareSymbol(listing.symbol, ticker)) {
      add(listing, savedUsListingOf(listing.symbol, await store.loadAllTickers()));
    }
    add(listing, ticker);
    // A suffixed key as typed may be saved with a venue (7203.T:JPX, GARAN.IS:XNYS): any row of that symbol.
    if (!ticker && !listing.exchange && tickerHasListingSuffix(listing.symbol)) {
      for (const row of await store.loadAllTickers()) {
        if (parsePublicTickerKey(row.metadata.ticker).symbol === listing.symbol) add(listing, row);
      }
    }
  }
  return (wanted && found.find((entry) => wanted(entry.ticker))) || found[0] || null;
}

/**
 * The saved row a command that changes a list names, and the listing it was
 * found as: one of `savedListingCandidates`, with no request when one is
 * saved (a broker's GARAN.IS while GARAN:BIST has no row), else the typed
 * listing as `requireListingArg` checks it, which fails the command when it
 * is no listing. The row is null when that listing has none.
 */
export async function requireSavedListing(
  raw: string,
  exchangeOption: string | null | undefined,
  ctx: Pick<CliCommandContext, "fail" | "initMarketData">,
  store: ListingStore,
  wanted?: (ticker: TickerRecord) => boolean,
): Promise<{ listing: ListingArg; ticker: TickerRecord | null }> {
  let candidates: ListingArg[] = [];
  try {
    candidates = savedListingCandidates(raw, exchangeOption);
  } catch {
    // Intentional ignore: requireListingArg below fails with what is wrong with the text.
  }
  const saved = await loadSavedListingOf(store, candidates, wanted);
  if (saved) return saved;
  const listing = await requireListingArg(raw, exchangeOption, ctx, { listingSuffix: true });
  return { listing, ticker: (await loadSavedListingOf(store, [listing], wanted))?.ticker ?? null };
}

/** A row saved under a vendor's suffixed key (RY.TO) for the listing it was read as: on that venue, or on none it names. */
async function loadSuffixedRow(store: ListingStore, key: string, exchange: string): Promise<TickerRecord | null> {
  const ticker = await store.loadTicker(key);
  const savedExchange = canonicalExchange(ticker?.metadata.exchange);
  return ticker && (!savedExchange || savedExchange === exchange) ? ticker : null;
}

export interface CliListing extends ListingArg {
  saved: TickerRecord | null;
  /** What was typed for it, as written (`Apple`), so a word no listing trades as can be read as a company's name. */
  typed?: string;
  /**
   * What data requests take: a named listing goes by its key (SAN:EPA), never
   * the bare symbol's cache; a bare symbol goes on its saved venue, as the
   * command bar opens it.
   */
  request: { symbol: string; exchange: string };
}

/**
 * `XYZ:BRENTOIL`, which reads as a symbol on an exchange no venue has, as Hyperliquid's name for a market on one
 * of its builder dexes (`xyz:BRENTOIL`, its listing XYZ-BRENTOIL:HYPERLIQUID), when that market exists. Asked only
 * after the exchange was not found, so a mistyped exchange still says so.
 */
async function builderDexMarket(listing: ListingArg, deps: ListingDeps): Promise<ListingArg | null> {
  if (!/^[A-Z][A-Z0-9]{0,11}$/.test(listing.symbol) || !/^[A-Z0-9]{1,32}$/.test(listing.exchange)) return null;
  const market = perpetualListingOfMarket(`hyperliquid:${listing.symbol.toLowerCase()}:${listing.exchange}`);
  if (!market) return null;
  const found = await deps.dataProvider.search(market.key).catch(logFailure("cli.listing-arg", "Search market listing failed", []));
  return found.some((result) => result.symbol.toUpperCase() === market.key)
    ? { symbol: market.symbol, exchange: market.exchange, key: market.key }
    : null;
}

/** A symbol written with a venue's suffix, as data vendors write a listing abroad: RY.TO, 7203.T, VOD.L, 0700.HK. */
const VENUE_SUFFIX = /^([A-Z0-9][A-Z0-9&-]*)\.([A-Z]{1,3})$/;

/**
 * RY.TO, 7203.T, VOD.L: a listing abroad written with a data vendor's venue
 * suffix, read as the listing its own quote names (RY:TSX, 7203:JPX,
 * VOD:LSE), the way `quote` names it, so data that is read by venue (a
 * company's SEC filings, data that covers US listings only) finds the same
 * listing the quote is for. A US share class (BRK.B, quoted on NYSE), a
 * suffix no quote answers and a named venue stay as typed.
 */
async function readVenueSuffix(listing: ListingArg, deps: Pick<ListingDeps, "dataProvider">): Promise<ListingArg | null> {
  const match = listing.exchange ? null : VENUE_SUFFIX.exec(listing.symbol);
  if (!match) return null;
  let quote: Quote | null;
  try {
    quote = await deps.dataProvider.getQuote(listing.symbol, "");
  } catch (error) {
    // The command's own request then says what is wrong with the symbol.
    if (!isNoProviderError(error)) logFailure("cli.listing-arg", "Quote venue suffix failed")(error);
    return null;
  }
  const venue = canonicalExchange(quote?.listingExchangeName || quote?.exchangeName);
  const key = `${match[1]}:${venue}`;
  if (!venue || !isKnownExchangeCode(venue) || !listingAbroadVenue(key)) return null;
  return { symbol: match[1]!, exchange: venue, key, readAs: `Read ${listing.symbol} as ${key}.` };
}

/** 7203.T as 7203:JPX when a row of 7203 on JPX is saved: a suffix `readListingSuffix` leaves to be confirmed. Null otherwise. */
async function savedSuffixVenue(listing: ListingArg, store: ListingStore): Promise<ListingArg | null> {
  const venue = listing.exchange ? null : listingSuffixCandidate(listing.symbol);
  if (!venue) return null;
  const candidate = { symbol: venue.symbol, exchange: venue.exchange, key: `${venue.symbol}:${venue.exchange}` };
  if (!await loadSavedListing(store, candidate)) return null;
  return listing.readAs ? { ...candidate, readAs: listing.readAs } : candidate;
}

/** GARAN.IS as GARAN:BIST: a vendor's venue suffix read as the venue it names (`listingSuffixVenue`), with no request. */
function readListingSuffix(listing: ListingArg): ListingArg | null {
  const venue = listing.exchange ? null : listingSuffixVenue(listing.symbol);
  return venue ? { symbol: venue.symbol, exchange: venue.exchange, key: `${venue.symbol}:${venue.exchange}` } : null;
}

export async function resolveCliListing(
  raw: string,
  exchangeOption: string | null | undefined,
  deps: ListingDeps,
  options: {
    ownExchangeWins?: boolean;
    /**
     * Read a venue suffix (RY.TO) as the listing its quote names (RY:TSX).
     * Only pane functions ask for it (`applyListingArgument`, which `fn` and
     * `shot` run through), as their data is read by venue.
     */
    venueSuffix?: boolean;
    /** Read a venue suffix as the venue it names, with no request (`parseListingArg`). */
    listingSuffix?: boolean;
  } = {},
): Promise<CliListing> {
  // "JPM US Equity" is Bloomberg's code for JPM; "Putnam US Equity", whose root is no US ticker, is a name.
  const typed = stripStrayEdges(raw).text || raw;
  const read = await readTerminalCodeArg(deps.dataProvider, typed);
  // A company's name, an entry of a comma list (`WHR, Whirlpool Corporation`), is the listing search names for it.
  // A name before a legal form ("SAP SE", "SIEMENS AG") is looked up first: SE is also SIX Swiss's market code.
  const named = !read || endsInLegalForm(typed) ? await companyNameListingArg(raw, deps) : null;
  const terminal = named ? null : read;
  // "AAPL GP" is written as a code, with a market code no venue answers to and no company's name: one entry, never AAPL and GP.
  if (!terminal && !named) await refuseUnknownMarketCode(typed, deps);
  // `BP.` is London's code for BP: its London line where London lists it, and `GE.` a US ticker with a stray dot.
  const dotted = terminal || named || exchangeOption?.trim() ? null : readLondonDottedSymbol(typed);
  let parsed = named ?? (dotted ? await londonDottedListing(dotted, deps) : parseListingArg(raw, exchangeOption, { ...options, terminalCode: terminal }));
  if (!parsed.symbol) throw new ListingArgError("Ticker symbol is required.");
  // $VIX is Schwab's code for ^VIX, unless a security trades as VIX: $AAPL is a cashtag.
  const index = named || parsed.exchange ? null : await readDollarIndexCode(raw, deps);
  if (index) parsed = index;
  // USD-NGN and USDNGN are the pair USDNGN=X unless a security is listed under those letters.
  const pair = parsed.exchange ? null : await readAmbiguousCurrencyPair(parsed.symbol, deps);
  if (pair) parsed = { symbol: pair, exchange: "", key: pair };
  // A one-letter suffix (7203.T) is read as its venue only when a row saved there says so; the listing's quote may later.
  const venueRow = options.listingSuffix && !pair && !named ? await savedSuffixVenue(parsed, deps.store) : null;
  if (venueRow) parsed = venueRow;
  const suffixed = pair || named || venueRow || !options.venueSuffix ? null : await readVenueSuffix(parsed, deps);
  // The row may be saved under the suffixed key itself: a link or a layout's key is kept as it came.
  const typedKey = suffixed ? parsed.symbol : null;
  if (suffixed) {
    const readAs = [parsed.readAs, suffixed.readAs].filter(Boolean).join(" ");
    parsed = { ...suffixed, ...readAs ? { readAs } : {} };
  }
  try {
    // A code's venue is one the app reads; where search alone knows it (`BBCA IJ`) or the codes differ (`DBS SP`), search says what trades there.
    if (terminal?.market && parsed.exchange === terminal.exchange) await checkTerminalCodeVenue(parsed, terminal.market, deps);
    else await checkListingExchange(parsed, deps);
  } catch (error) {
    const market = error instanceof ListingArgError ? await builderDexMarket(parsed, deps) : null;
    if (!market) throw error;
    parsed = market;
  }
  let listing = await settleSharedCode(parsed, deps);
  const found = await loadSavedListing(deps.store, listing) ?? (typedKey ? await loadSuffixedRow(deps.store, typedKey, listing.exchange) : null);
  // A bare symbol is its US listing when it has one, whatever row abroad holds the bare key (SHEL saved from SHEL.L).
  const saved = listing.exchange ? found : await savedRowOfBareSymbol(listing.symbol, found, deps);
  // A code nothing could read stays the venue it is saved on.
  const savedExchange = canonicalExchange(saved?.metadata.exchange);
  if (listing.sharedCode && savedExchange) listing = { symbol: listing.symbol, exchange: savedExchange, key: `${listing.symbol}:${savedExchange}` };
  return {
    ...listing,
    saved,
    typed: typed.trim(),
    request: listing.exchange
      ? { symbol: listing.key, exchange: listing.exchange }
      : { symbol: listing.symbol, exchange: saved?.metadata.exchange ?? "" },
  };
}

/**
 * A two-letter symbol written with London's trailing dot (`BP.`, `RR.`) as its
 * London line, said as "Read BP. as BP:LSE.", where search lists it on LSE or
 * its quote there says it trades. Elsewhere the dot was a slip after the
 * ticker, dropped as a stray edge is (`GE.` is GE).
 */
async function londonDottedListing(dotted: NearMissListing, deps: ListingDeps): Promise<ListingArg> {
  const london = { symbol: dotted.symbol, exchange: "LSE" };
  const venues = await listingVenues(dotted.symbol, deps).catch(logFailure("cli.listing-arg", "Read listing venues failed", []));
  const listed = venues.some((venue) => venue.exchange === london.exchange) || await quotedOnVenue(london, deps);
  if (!listed) return parseListingArg(dotted.symbol);
  const key = `${london.symbol}:${london.exchange}`;
  return { ...parseListingArg(key), readAs: `Read ${dotted.typed} as ${key}.` };
}

/**
 * Fails a line written as a Bloomberg code whose market code no venue answers
 * to (`AAPL GP`), suggesting the code of the symbol's own listing (`AAPL
 * US`), where else it trades, and, when the words could be two symbols, how
 * to write them as two. A real market no source quotes (`SM PM`) says so.
 * Run once no company's name was found in the words. Returns for anything else.
 */
async function refuseUnknownMarketCode(typed: string, deps: ListingDeps): Promise<void> {
  const unknown = unknownBloombergMarket(typed);
  if (!unknown) return;
  const twoSymbols = unknown.keyed ? null : `For two symbols, separate them with a comma: ${unknown.symbol}, ${unknown.market}.`;
  // A real market no source quotes (PM): the symbol's listings elsewhere are as likely another company's (SM US is SM Energy).
  if (unknown.unquoted) throw new ListingArgError(`${unknown.market} is the ${unknown.unquoted}, which has no quotes here.`, twoSymbols ?? undefined);
  const venues = await listingVenues(unknown.symbol, deps).catch(logFailure("cli.listing-arg", "Read listing venues failed", []));
  const codes = [...new Set(venues.flatMap((venue) => bloombergCodeOf(unknown.symbol, venue.exchange) ?? []))];
  const also = codes.slice(1, 1 + MAX_OTHER_LISTINGS);
  const details = [also.length > 0 ? `${unknown.symbol} also trades as ${also.join(", ")}.` : null, twoSymbols].filter(Boolean).join("\n");
  throw new ListingArgError(`${unknown.market} is not a market code; did you mean ${codes[0] ?? unknown.symbol}?`, details || undefined);
}

/**
 * A code's venue where the exchange table has no entry for it (`BBCA IJ` is
 * JAKARTA) or Bloomberg's ticker is not the venue's code (`MAY MK`, Bursa's
 * 1155): "MAY does not trade on BURSAMY", with where it does and what to
 * type instead, rather than an unknown exchange. Returns for a venue the table
 * knows, which the listing's own request checks, and when search lists the
 * symbol there or cannot say.
 */
async function checkTerminalCodeVenue(listing: ListingArg, market: string, deps: ListingDeps): Promise<void> {
  const hint = bloombergMarketHint(market);
  if (!hint && !isSearchOnlyVenue(listing.exchange)) return;
  const venues = await listingVenues(listing.symbol, deps).catch(logFailure("cli.listing-arg", "Read listing venues failed", []));
  if (venues.length === 0 || venues.some((venue) => venue.exchange === listing.exchange)) return;
  throw new ListingArgError(`${listing.symbol} does not trade on ${listing.exchange}.${tradesOn(listing.symbol, venues)}`, hint ?? undefined);
}

/**
 * The index a broker's code names, as a listing: VIX.X and $VIX.X at once,
 * $VIX when the sources answer that nothing trades as VIX. `$MOVE` stays
 * Corvex, whose quote then names the index beside it, and `$AAPL` is AAPL, as
 * no index is rooted at it. A quote that fails another way (a timeout, the
 * network) says nothing about what trades, so `$MID` stays MID as typed.
 * Null for anything else.
 */
export async function readBrokerIndexCode(raw: string, deps: Pick<ListingDeps, "dataProvider">): Promise<ListingArg | null> {
  const code = brokerIndexCode(stripStrayEdges(raw).text || raw);
  if (!code) return null;
  if (code.bare && !await nothingTradesAs(code.bare, deps)) return null;
  return { symbol: code.symbol, exchange: "", key: code.symbol, readAs: brokerIndexReadAs(code) };
}

/** Whether the sources answer that no security trades as `symbol`: no quote, or a no-provider miss. */
async function nothingTradesAs(symbol: string, deps: Pick<ListingDeps, "dataProvider">): Promise<boolean> {
  try {
    return !await deps.dataProvider.getQuote(symbol, "");
  } catch (error) {
    if (isNoProviderError(error)) return true;
    logFailure("cli.listing-arg", "Quote broker index root failed")(error);
    return false;
  }
}

/** `readBrokerIndexCode` for a `$ROOT` code only: the `ROOT.X` codes are read where the listing is parsed. */
function readDollarIndexCode(raw: string, deps: Pick<ListingDeps, "dataProvider">): Promise<ListingArg | null> {
  return brokerIndexCode(stripStrayEdges(raw).text || raw)?.bare ? readBrokerIndexCode(raw, deps) : Promise.resolve(null);
}

/**
 * The listing a company's name typed where a symbol goes stands for
 * (`findListingOfCompanyName`), saying which one it was read as; null for a
 * symbol, and for a name search finds no listing for, which then fails as a
 * symbol would.
 */
async function companyNameListingArg(raw: string, deps: ListingDeps): Promise<ListingArg | null> {
  const typed = stripStrayEdges(raw).text || raw;
  return isCompanyNameInput(typed) ? readCompanyName(typed, deps) : null;
}

/** One word that can be a company's name: letters first, no venue, pair or index mark (`Apple`, `Petrobras`, `Coca-Cola`). */
const ONE_WORD_NAME = /^\p{L}[\p{L}\p{N}&'’.-]*$/u;

/**
 * A company's name typed as one word (`Apple`) where a symbol goes, once the
 * sources said no listing trades as it, read as the listing search names for
 * it the way a name of several words is (`companyNameListingArg`): "Read
 * "Apple" as AAPL:NASDAQ (Apple Inc.).". A real ticker never gets here, so it
 * always wins over a name. A word many names share (`oil`) is a name only
 * when search puts it first, the service marks it, or a listing's name is
 * the word alone (`findListingOfCompanyName` with `oneWord`). A coin's name
 * (`bitcoin`, or any the crypto board lists) and a subject the app knows of
 * (`carbon`, `freight`) are never read as a company: they keep their own
 * hint, the coin's pair (BTC-USD) or the search that says where it is. Null
 * for anything else, and when search names no company or is too busy to say.
 */
export async function oneWordCompanyName(typed: string, deps: Pick<ListingDeps, "dataProvider">): Promise<ListingArg | null> {
  const found = await findOneWordCompany(typed, deps);
  return found ? companyListingArg(typed, found) : null;
}

/** The company `oneWordCompanyName` reads a word as, before it is read as a listing. */
async function findOneWordCompany(typed: string, deps: Pick<ListingDeps, "dataProvider">): Promise<CompanyNameListing | null> {
  const word = typed.trim();
  if (!ONE_WORD_NAME.test(word) || knownGapMessage(word) || isMajorCoinName(word)) return null;
  const found = await findCompanyName(word, deps, { oneWord: true }).catch((error: unknown) => {
    if (!isProviderBusy(error)) throw error;
    // Intentional ignore: a busy search says nothing about the name, so the word keeps its own "Not a ticker".
    return null;
  });
  if (!found) return null;
  // The board is read only for a word that names a company, and once for the run (`primeBoardCoins`).
  if (/^[A-Za-z0-9]+$/.test(word)) await primeBoardCoins([`Not a ticker: ${word.toUpperCase()}.`]);
  return boardCoinFor(word) ? null : found;
}

function isMajorCoinName(word: string): boolean {
  const wanted = word.toLowerCase();
  return [...MAJOR_COIN_NAMES.values()].some((name) => name.toLowerCase() === wanted);
}

function findCompanyName(typed: string, deps: Pick<ListingDeps, "dataProvider">, options: { oneWord?: boolean } = {}): Promise<CompanyNameListing | null> {
  return findListingOfCompanyName(deps.dataProvider, typed, { meant: true, quoted: true, ...options });
}

async function readCompanyName(typed: string, deps: Pick<ListingDeps, "dataProvider">, options: { oneWord?: boolean } = {}): Promise<ListingArg | null> {
  const found = await findCompanyName(typed, deps, options);
  return found ? companyListingArg(typed, found) : null;
}

function companyListingArg(typed: string, found: CompanyNameListing): ListingArg {
  const key = `${found.symbol}:${found.exchange}`;
  // A fund or an index carrying the name asks about the company's stock: "Did you mean JPM (JPMorgan Chase & Co.)?".
  const meant = found.meant ? { symbol: found.meant.symbol, name: found.meant.name } : null;
  const question = meant ? ` ${meantQuestion({ meant })}` : "";
  return { ...parseListingArg(key), readAs: `Read "${typed.trim()}" as ${key} (${found.name}).${question}`, ...meant ? { meant } : {} };
}

/**
 * The listing search names for a company's name typed where a ticker goes,
 * as a sentence offers it: `PLTR (Palantir Technologies Inc.)`, a listing
 * abroad with its venue (`SIE:XETRA (Siemens AG)`), a fund or an index that
 * carries the name as the company's stock it means. Null when the words name
 * no company, search is busy, or the listing found is the word itself: a
 * real ticker is never a company's name. Never throws.
 */
export async function companyNameSuggestion(typed: string, deps: Pick<ListingDeps, "dataProvider">): Promise<{ symbol: string; name: string } | null> {
  const words = typed.trim().replace(/^\$/, "");
  if (!words) return null;
  try {
    const found = isCompanyNameInput(words) ? await findCompanyName(words, deps).catch(busyAsMiss) : await findOneWordCompany(words, deps);
    const listing = found?.meant ?? found;
    if (!listing || listing.symbol.toUpperCase() === words.toUpperCase()) return null;
    return { symbol: isUsListingExchange(listing.exchange) ? listing.symbol : `${listing.symbol}:${listing.exchange}`, name: listing.name };
  } catch (error) {
    logFailure("cli.listing-arg", "Search a company name for a suggestion failed")(error);
    return null;
  }
}

/** A search too busy to answer is no company, as a name that matches none. */
function busyAsMiss(error: unknown): null {
  if (!isProviderBusy(error)) throw error;
  // Intentional ignore: a busy search says nothing about the name, so no company is suggested.
  return null;
}

/** `resolveCliListing` for a command: a bad exchange fails the command with its message. */
export async function requireCliListing(
  raw: string,
  exchangeOption: string | null | undefined,
  deps: ListingDeps,
  ctx: Pick<CliCommandContext, "fail">,
  options: { ownExchangeWins?: boolean; venueSuffix?: boolean } = {},
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
  options: { listingSuffix?: boolean } = {},
): Promise<ListingArg> {
  try {
    const listing = parseListingArg(raw, exchangeOption, options);
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
  // The listing's own quote names it, as a portfolio and search do; a quote that prices another venue names another listing's company.
  return { symbol: listing.symbol, exchange, name: quotedListingName(exchange, quote) || listing.saved?.metadata.name?.trim() || null };
}

/** The listing's own quote, for its company name and venue; null when it has none. */
export async function loadListingQuote(dataProvider: DataProvider, listing: Pick<CliListing, "request">): Promise<Quote | null> {
  return (await loadListingQuoteAnswer(dataProvider, listing)).quote;
}

/** The listing's own quote, or the error its request failed with: "Not a ticker: PALANTIR." for a name typed as a symbol. */
export async function loadListingQuoteAnswer(
  dataProvider: DataProvider,
  listing: Pick<CliListing, "request">,
): Promise<{ quote: Quote | null; error?: unknown }> {
  try {
    return { quote: await dataProvider.getQuote(listing.request.symbol, listing.request.exchange) };
  } catch (error) {
    return { quote: null, error };
  }
}

/**
 * What a listing is: an index, a pair, a future or a coin by its symbol
 * (^VIX, EURUSD=X), anything else by its quote's type, then its saved record's.
 * A specific kind outranks a generic equity type, as brokers file funds as
 * stocks. Null when nothing says, as for a symbol whose quote fails.
 */
export async function listingInstrument(
  listing: Pick<CliListing, "key" | "exchange" | "request" | "saved">,
  deps: Pick<ListingDeps, "dataProvider">,
): Promise<InstrumentOfKind | null> {
  const syntax = kindFromListingSyntax(listing.key, listing.exchange);
  if (syntax) return { symbol: listing.key, kind: syntax };
  const quote = await loadListingQuote(deps.dataProvider, listing);
  const types = [quote?.instrumentType, listing.saved?.metadata.broker_contracts?.[0]?.secType, listing.saved?.metadata.assetCategory];
  const typed = types.flatMap((type) => {
    const kind = classifyInstrumentType(type);
    return kind ? [{ kind, type }] : [];
  });
  const found = typed.find(({ kind }) => kind !== "equity") ?? typed[0];
  return found ? { symbol: listing.key, kind: found.kind, type: found.type ?? null } : null;
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

/** What every collection command reports about the listing it changed, as JSON and as the sentence's subject. */
export function listingFields(saved: Pick<SavedListingName, "key" | "symbol" | "exchange" | "name">) {
  return { listing: saved.key, symbol: saved.symbol, exchange: saved.exchange || null, name: saved.name };
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
