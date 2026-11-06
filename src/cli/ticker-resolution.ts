import { logFailure } from "../utils/log-failure";
import { ApiRequestError, wasAskedTwice } from "../api-client/errors";
import { isNoSourceAnswer, isProviderBusy, SEARCH_BUSY_MESSAGE } from "../sources/provider-errors";
import type { DataProvider } from "../types/data-provider";
import type { Quote } from "../types/financials";
import type { InstrumentSearchResult } from "../types/instrument";
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
  isNoProviderError,
  ListingArgError,
  listingChoiceNote,
  listingReadNotes,
  listingVenues,
  movedSymbolLine,
  notTradedMessage,
  oneWordCompanyName,
  parseListingArg,
  quoteBareListing,
  resolveCliListing,
  savedListingName,
  UNLISTED_TYPES,
  type CliListing,
  type ListingChoice,
  type ListingDeps,
} from "./listing-arg";
import { listingChangeLine, loadListingFate, noLongerTradingNote, tradingListing } from "../tickers/listing-fate";
import { delistingLabel } from "../market-data/quotes/delisting";
import {
  describeFormerIssuer,
  describeTickerChange,
  isUsSymbolVenue,
  movedAwayChange,
  LOOKUP_TIMEOUT_MS,
  startTickerChangeLookup,
  tickerChangeLine,
  tickerChangeSymbol,
  type CurrentListing,
  type FormerIssuer,
  type TickerChange,
  type TickerChangeLookup,
} from "../tickers/ticker-changes";
import { batchedListLookups, type ListLookupPlan } from "../tickers/batched-lookups";
import { providerSearchQueries } from "../tickers/search";
import { coinElsewhereNote, savedListingCoinNote } from "./commands/crypto-hints";
import { NotASymbolError, notASymbolError } from "./symbol-cells";
import { kindFromListingSyntax } from "../tickers/instrument-kind";
import { classifyInstrumentKind, normalizeTickerSymbol } from "../tickers/search/ranking";
import { companyNameQueries, findFormerIssuerOfName, isCompanyNameInput, settledTerminalCode } from "../tickers/company-name-listing";

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
  /** How the input was read, when not as typed: a company's name as the listing it names (`listingReadNotes`). */
  readAs: string | null;
  /** The symbol changed (FB became META); when its company left it, the line leads `notes`. */
  change: TickerChange | null;
  /**
   * The company that last held the symbol merged into another (GOGL was
   * Golden Ocean, now CMB.Tech: CMBT); its line leads `notes` when no change does.
   */
  formerIssuer: FormerIssuer | null;
  /**
   * A bare coin ticker (ETH) read as a listing that is not the coin, such as a
   * fund named for it: "ETH is Grayscale Ethereum Mini Trust ETF, not ethereum.
   * For ethereum use ETH-USD." A live company that only shares the letters gets
   * "Also a coin: LINK-USD" (`notTheCoinNote`). It is also the last of `notes`.
   */
  coinNote: string | null;
  /**
   * The symbol as read when it named no exchange (DFS, not DFS:LSE or DFS
   * --exchange LSE): the listing is the one the lookup chose for it. Null when
   * the input named its listing, or a company's name was read as one.
   */
  bareSymbol: string | null;
  /**
   * The venues other than the stored one the symbol lists on, as far as the
   * lookup saw them: search's, or none when the symbol's own quote named the
   * listing and search was busy. Null when the lookup asked neither (a saved
   * row), so whether a bare symbol matched abroad also names a US listing is
   * still to be asked.
   */
  otherVenues: string[] | null;
  /**
   * A bare US-style symbol, or a company's name read as a listing, whose quote
   * could not be read (the service refused or failed it): whether the listing still trades is unknown, so an add
   * cannot tell a live match from a dead one (`choiceNeeded`). A list looks
   * it up again with the symbols that failed.
   */
  unchecked?: true;
  /**
   * The stored listing's own quote was answered with none (a venue no source
   * prices, ZION:IEX, FRC:BMV): it cannot quote, which a list add never
   * stores silently (`settleAdd`).
   */
  noQuote?: true;
}

export interface CliTickerOptions {
  /** The command that takes one listing, for the choices a failure names: `gloom watchlist add Growth 2222:JPX`. */
  retry?: (key: string) => string;
  /** `--exchange` only fills in the symbols that name no exchange of their own, as for a list of symbols. */
  ownExchangeWins?: boolean;
  /** Look up whether the symbol changed (FB became META). True by default. */
  changes?: boolean;
  /**
   * How long the answer waits for that lookup once the listing is found. A
   * command printing one symbol waits a moment and goes on without the note;
   * a list waits for it, since a symbol's company leaving it decides whether
   * the listing is stored.
   */
  changeGraceMs?: number;
  /**
   * Ask a listing already saved for its quote and save the name the quote
   * gives, as `quote` and `portfolio show` name it. True by default.
   */
  refreshName?: boolean;
  /**
   * A bare symbol several listings carry, and no quote settles, fails with the
   * choice instead of going to the first listing that has a quote, for a caller
   * that asks which listing is meant (the command bar's single add does).
   */
  askWhenAmbiguous?: boolean;
}

/**
 * A bare coin ticker several companies list, none of them the coin (SOL): the
 * listings to choose from in `details`, and where the coin is in `hint`, which
 * is also the last line of `details`.
 */
export class CoinListingError extends ListingArgError {
  constructor(message: string, details: string, readonly hint: string) {
    // A listing message that already ends in the coin note (`describeOtherListings`) keeps it once.
    super(message, details.endsWith(hint) ? details : `${details}\n${hint}`);
    this.name = "CoinListingError";
  }
}

/**
 * A bare symbol several companies list, so it went to none of them: `choices`
 * are the first listings to pick from, of `listingCount`, and `successor` what
 * search says became of the symbol ("NEP became XIFR on 2025-02-03"), often the
 * company meant. `details` has both, each with the command that adds it.
 */
export class ListingChoiceError extends ListingArgError {
  constructor(
    message: string,
    details: string,
    override readonly choices: readonly ListingChoice[],
    readonly listingCount: number,
    readonly successor: string | null,
  ) {
    super(message, details, choices);
    this.name = "ListingChoiceError";
  }
}

/** Search found no listing for the symbol: the message says so, or why (no longer trading, not on that exchange). */
export class TickerNotFoundError extends ListingArgError {
  constructor(
    message: string,
    /** The symbol its company trades as now, when the message says it moved or merged away (PPBI: COLB). */
    readonly successor: string | null = null,
  ) {
    super(message);
    this.name = "TickerNotFoundError";
  }
}

/**
 * A list's symbol Gloom Cloud kept refusing to look up, through every wait:
 * the lookup did not happen, so the symbol is neither found nor missing.
 */
export class LookupUnansweredError extends Error {
  constructor(readonly input: string) {
    super(`Could not look up ${input}: Gloom Cloud did not answer. Try again in a minute.`);
    this.name = "LookupUnansweredError";
  }
}

/**
 * `resolveTickerForCli`, saying which listing a bare symbol went to. A bare
 * symbol goes where `quote` reads it: the listing its own quote is on, else,
 * when no quote settles it, the first of its listings with a quote
 * (`quoteBareListing`); a code several companies list asks which. A symbol
 * search no longer lists, whose quote stopped long ago, is no longer trading,
 * and a named exchange the symbol is not on says where it is. Those failures
 * are `ListingArgError`s, with any choices in `details`. What cannot be a
 * symbol (`N/A`, `$$$`, a price such as `2.582,52`) fails with
 * `NotASymbolError` before anything is asked.
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
  const notSymbol = notASymbolError(symbol);
  if (notSymbol) throw notSymbol;
  const deps: ListingDeps = { store, dataProvider };
  // A vendor's suffix is the venue it names (GARAN.IS is GARAN:BIST), so the listing is saved under one key.
  const listing = await resolveCliListing(symbol, exchange, deps, { ownExchangeWins: options.ownExchangeWins, listingSuffix: true });
  const read = listingReadNotes(listing);
  // Looked up beside the search, so saying FB is now META costs no wait.
  const changes = options.changes === false ? null : startTickerChangeLookup(dataProvider, listing.symbol, listing.exchange);
  const withChange = (resolved: ResolvedListing, current: CurrentListing | null | undefined) =>
    describeResolution(listing, changes, resolved, current, options.changeGraceMs);
  // A listing already saved says, as one search found does, when its quote stopped long ago.
  const withEnded = (named: { ticker: TickerRecord; quote: Quote | null }, notes: string[]): ResolvedListing => {
    const ended = named.quote ? noLongerTradingNote(savedListingName(named.ticker).label, named.quote) : null;
    return { ticker: named.ticker, notes: [...notes, ...ended ? [ended] : []], ended };
  };
  // A saved listing names what lists there; the issuer that left, if it is that one, is its old line.
  if (listing.saved) {
    const saved = options.refreshName === false ? { ticker: listing.saved, quote: null } : await nameFromListingQuote(listing.saved, store, dataProvider, null);
    // A saved line that stopped trading is the old line, not something listed under the symbol now.
    const ended = withEnded(saved, read);
    return withChange({ ...ended, ...uncheckedIf(listing, saved, ended.ended) }, saved.quote ? tradingListing(saved.quote) : { name: saved.ticker.metadata.name });
  }
  // A listing its own quote names is found as `quote` finds it, the quote cache first, so a busy search never
  // blocks a listing the quote knows. Search is asked after, for the venues a note names, and may fail.
  const known = await listingOfOwnQuote(listing, dataProvider);
  if (known) {
    const { ticker, created } = await upsertTickerFromSearchResult(store, known.result);
    const named = created ? await nameFromListingQuote(ticker, store, dataProvider, known.quote) : { ticker, quote: known.quote };
    const saved = savedListingName(named.ticker);
    const venues = listing.exchange ? [] : await listingVenues(listing.symbol, deps).catch(logFailure("cli.ticker-resolution", "Read quoted listing venues failed", []));
    const others = venues.map((venue) => venue.exchange).filter((venue) => venue !== saved.exchange);
    const venueNote = others.length > 0 && saved.exchange
      ? listingChoiceNote(listing.symbol, saved, venues) ?? chosenListingNote(listing.symbol, saved.exchange, others)
      : null;
    return withChange({ ticker: named.ticker, notes: [...read, ...venueNote ? [venueNote] : []], ended: null, otherVenues: others }, tradingListing(known.quote));
  }

  const localTickers = new Map(
    (await store.loadAllTickers()).map((ticker) => [ticker.metadata.ticker.toUpperCase(), ticker] as const),
  );
  const search = (query: string) => resolveTickerSearch({ query, activeTicker: null, tickers: localTickers, dataProvider });
  let resolved: ResolvedTickerSearch | null;
  let bareNote: string | null = null;
  let bareQuote: Quote | null = null;
  let bareVenues: string[] = [];
  try {
    resolved = await search(listing.key);
  } catch (error) {
    if (!(error instanceof AmbiguousTickerError) || error instanceof AmbiguousContractError || listing.exchange || options.askWhenAmbiguous) throw error;
    // No quote of the bare symbol settles which listing it is: the one `quote` reads instead.
    const bare = await quoteBareListing(listing, deps, { command: "quote", noun: "quote", retry: options.retry ?? null });
    if (!bare) throw error;
    if (bare.kind === "missing") {
      const hint = coinElsewhereNote(listing.symbol, error.listings.map((key) => ({ key, name: error.listingNames[key] ?? "" })));
      if (hint) throw new CoinListingError(bare.message, bare.details, hint);
      if (!bare.choose) throw new ListingArgError(bare.message, bare.details);
      // What search says became of the symbol: a company that moved away (NEP became XIFR) is often the one meant.
      const fate = await loadListingFate(listing, dataProvider, changes ? { changes } : {});
      const successor = listingChangeLine(fate);
      const moved = movedAwayChange(fate.change);
      const successorLine = moved && options.retry ? movedSymbolLine(moved, options.retry(moved.tradesAs)) : successor;
      throw new ListingChoiceError(bare.message, [bare.details, successorLine].filter(Boolean).join("\n"), bare.choices, bare.listings.length, successor);
    }
    resolved = await search(bare.listing.key);
    bareNote = bare.note;
    bareQuote = bare.quote;
    bareVenues = error.listings.flatMap((key) => parsePublicTickerKey(key).exchange ?? []).filter((venue) => venue !== bare.listing.exchange);
  }

  if (!resolved) {
    const message = await missingListingMessage(listing, deps);
    const payload = await changes?.settle(options.changeGraceMs) ?? null;
    const change = describeTickerChange(listing.symbol, payload, null);
    const changeLine = tickerChangeLine(change);
    const formerIssuer = changeLine ? null : describeFormerIssuer(listing.symbol, payload, null);
    // A company's old name ("Comerica") that search finds on the row of the company it merged into (FITB). A word
    // a US ticker can be (NVDA) is not asked after: its own search just answered it.
    const typed = listing.typed || listing.symbol;
    const merged = changeLine || formerIssuer || !/\p{Ll}|\s|^\p{L}{6,}$/u.test(typed) ? null
      : await findFormerIssuerOfName(dataProvider, typed).catch(logFailure("cli.ticker-resolution", "Search a former issuer's name failed", null));
    const line = changeLine ?? formerIssuer?.note ?? merged?.note;
    const successor = changeLine ? change?.tradesAs ?? null : formerIssuer?.successor.symbol ?? merged?.successor ?? null;
    throw new TickerNotFoundError(line ? `${message} ${line}.` : message, successor);
  }
  if (resolved.kind === "local") {
    const local = options.refreshName === false ? { ticker: resolved.ticker, quote: null } : await nameFromListingQuote(resolved.ticker, store, dataProvider, bareQuote);
    const ended = withEnded(local, [...read, ...bareNote ? [bareNote] : []]);
    return withChange({ ...ended, otherVenues: bareNote ? bareVenues : null, ...uncheckedIf(listing, local, ended.ended) }, local.quote ? tradingListing(local.quote) : { name: local.ticker.metadata.name });
  }

  const { ticker, created } = await upsertTickerFromSearchResult(store, resolved.result);
  // A listing saved before (by an earlier look at a list) is read again too: its quote says whether it still trades.
  const named = created || !bareQuote ? await nameFromListingQuote(ticker, store, dataProvider, bareQuote) : { ticker, quote: bareQuote };
  const saved = savedListingName(named.ticker);
  const others = resolved.otherListings?.map((key) => parsePublicTickerKey(key).exchange ?? key) ?? [];
  // Several companies' listings name the company it went to and theirs; one company's name its other venues.
  const venueNote = bareNote ?? (others.length > 0 && saved.exchange
    ? listingChoiceNote(listing.symbol, saved, await listingVenues(listing.symbol, deps).catch(logFailure("cli.ticker-resolution", "Read resolved ticker listing venues failed", [])))
      ?? chosenListingNote(listing.symbol, saved.exchange, others)
    : null);
  // A row search marks as delisted (UBSH, no venue, no quote) says so when its quote cannot.
  const listed = resolved.result.delisting;
  const ended = (named.quote ? noLongerTradingNote(saved.label, named.quote) : listed ? `${saved.label}: ${delistingLabel(listed)}` : null)
    ?? (listing.exchange ? null : await ownLineEnded(listing, saved.exchange, dataProvider));
  // Search listed it, so something trades there; its quote says whether that is the issuer that left.
  const current = named.quote ? tradingListing(named.quote) : { name: named.ticker.metadata.name };
  return withChange({
    ticker: named.ticker,
    notes: [...read, venueNote, ended].filter((note): note is string => !!note),
    ended,
    otherVenues: bareNote ? bareVenues : others,
    ...uncheckedIf(listing, named, ended),
  }, current);
}

/**
 * `unchecked` for a bare US-style symbol or a company's name whose quote could
 * not be read (`CliTicker.unchecked`), and `noQuote` for a company's listing whose quote
 * was answered with none, unless it is known to have stopped trading (`ended`).
 */
function uncheckedIf(
  listing: Pick<CliListing, "symbol" | "exchange" | "readAs">,
  read: { ticker: TickerRecord; failed?: true; missing?: true },
  ended: string | null = null,
): { unchecked?: true; noQuote?: true } {
  // Shares and funds only: a pair, a future or an index is quoted by its own source, or not at all.
  const kind = classifyInstrumentKind(read.ticker.metadata.assetCategory ?? "");
  if (read.missing && !ended && (kind === "equity" || kind === "fund")) return { noQuote: true };
  // A company's name read as a listing whose quote failed ("First Republic Bank" as FRC:BMV while the source was
  // rate limited) may be a line that cannot quote: it is checked again too, never stored unchecked.
  return read.failed && ((!listing.exchange && tickerChangeSymbol(listing.symbol)) || !!listing.readAs) ? { unchecked: true } : {};
}

/**
 * The listing a symbol's own quote names, asked as `quote` asks it (the quote
 * cache first): a priced quote answering for that symbol, on the venue named
 * when one was, that still trades. Null when there is none, and for a pair, a
 * future, an index or a coin, which search types; search then looks it up. So
 * is a named US venue: the US exchanges share one symbol, and a quote asked
 * for on any of them answers as that venue (AAPL:NYSE), where search says
 * AAPL trades on NASDAQ, unless search named that venue for a company's name.
 */
async function listingOfOwnQuote(listing: CliListing, dataProvider: DataProvider): Promise<{ result: InstrumentSearchResult; quote: Quote } | null> {
  if (listing.sharedCode || kindFromListingSyntax(listing.key, listing.exchange)) return null;
  if (listing.exchange && isUsSymbolVenue(listing.exchange) && !listing.venueFromSearch) return null;
  let quote: Quote;
  try {
    quote = await dataProvider.getQuote(listing.request.symbol, listing.request.exchange);
  } catch (error) {
    // Search then says what is wrong with the symbol.
    if (!isNoProviderError(error)) logFailure("cli.ticker-resolution", "Quote listing before search failed")(error);
    return null;
  }
  const exchange = canonicalExchange(quote.listingExchangeName || quote.exchangeName);
  const answered = normalizeTickerSymbol(quote.symbol ?? "");
  if (!exchange || (answered !== listing.symbol && answered !== listing.key)) return null;
  if (listing.exchange && exchange !== listing.exchange) return null;
  if (!Number.isFinite(quote.price) || quote.price === 0 || !(quote.lastUpdated > 0)) return null;
  if (quote.delisting || noLongerTradingNote(listing.key, quote)) return null;
  if (UNLISTED_TYPES.has(quote.instrumentType?.trim().toUpperCase() ?? "")) return null;
  return {
    quote,
    result: {
      providerId: dataProvider.id,
      symbol: listing.symbol,
      name: quote.name?.trim() || listing.symbol,
      exchange,
      ...quote.currency ? { currency: quote.currency } : {},
      type: quote.instrumentType || "",
    },
  };
}

/**
 * A bare US symbol is the line its own quote names, as `quote` reads it. When
 * that line stopped trading on another US venue than the row search listed
 * first (SBNY on OTC since 2026-02-05, where search lists SBNY on NASDAQ), the
 * venues share the symbol, so the row is that line: "SBNY: no longer trading
 * since 2026-02-05 (last price $0.95)". Null otherwise. The quote was read
 * already (`listingOfOwnQuote`), so this asks nothing new.
 */
async function ownLineEnded(listing: CliListing, venue: string, dataProvider: DataProvider): Promise<string | null> {
  if (!isUsSymbolVenue(venue)) return null;
  const quote = await dataProvider.getQuote(listing.request.symbol, listing.request.exchange).catch(() => {
    // Intentional ignore: with no quote of its own, the row search listed stands.
    return null;
  });
  const own = canonicalExchange(quote?.listingExchangeName || quote?.exchangeName);
  if (!quote || !own || own === venue || !isUsSymbolVenue(own) || normalizeTickerSymbol(quote.symbol ?? "") !== listing.symbol) return null;
  return noLongerTradingNote(listing.symbol, quote);
}

type ResolvedListing = Omit<CliTicker, "change" | "formerIssuer" | "coinNote" | "readAs" | "bareSymbol" | "otherVenues"> & { otherVenues?: string[] | null };

/**
 * The resolution with the symbol's change, when it has one, and the coin note
 * for a bare coin ticker on a listing that is not the coin: a company that left
 * the symbol leads the notes, the coin note ends them. A named exchange (ETH:ARCA,
 * --exchange) asked for that listing on purpose and gets no coin note, as in `quote`.
 */
async function describeResolution(
  listing: Pick<CliListing, "symbol" | "exchange" | "readAs">,
  lookup: TickerChangeLookup | null,
  resolved: ResolvedListing,
  current: CurrentListing | null | undefined,
  graceMs?: number,
): Promise<CliTicker> {
  const payload = await lookup?.settle(graceMs) ?? null;
  const change = describeTickerChange(listing.symbol, payload, current);
  const formerIssuer = describeFormerIssuer(listing.symbol, payload, current);
  // One line: a company that left the symbol, else one that merged away from it.
  const line = tickerChangeLine(change) ?? formerIssuer?.note;
  const coinNote = listing.exchange ? null : savedListingCoinNote(listing.symbol, resolved.ticker, { ended: !!resolved.ended });
  return { ...resolved, notes: [...line ? [line] : [], ...resolved.notes, ...coinNote ? [coinNote] : []], change, formerIssuer, coinNote,
    readAs: listing.readAs ?? null, bareSymbol: listing.exchange ? null : listing.symbol, otherVenues: resolved.otherVenues ?? null };
}

/**
 * Why search found no listing: a named exchange the symbol is not on names
 * the ones it is; a symbol search no longer lists, whose quote stopped long
 * ago, is no longer trading (TWTR).
 */
async function missingListingMessage(listing: CliListing, deps: ListingDeps): Promise<string> {
  const notTraded = await notTradedMessage(listing, deps);
  if (notTraded) return notTraded;
  const quote = await deps.dataProvider.getQuote(listing.request.symbol, listing.request.exchange).catch(logFailure("cli.ticker-resolution", "Read missing listing quote failed", null));
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
): Promise<{ ticker: TickerRecord; quote: Quote | null; failed?: true; missing?: true }> {
  const { metadata } = ticker;
  try {
    const quote = known ?? await dataProvider.getQuote(metadata.ticker, metadata.exchange);
    const name = quote.name?.trim();
    // A quote that names no listing may be another venue's line served from cache. A bare US row (RAD, no
    // venue) is asked with none, and its own quote names none when the line stopped trading.
    const quoteExchange = canonicalExchange(quote.listingExchangeName || quote.exchangeName);
    const ownExchange = canonicalExchange(metadata.exchange);
    if (quoteExchange !== ownExchange || (!quoteExchange && !quote.delisting)) return { ticker, quote: null };
    if (!name || name === metadata.name) return { ticker, quote };
    const named: TickerRecord = { ...ticker, metadata: { ...metadata, name } };
    await store.saveTicker(named);
    return { ticker: named, quote };
  } catch (error) {
    // Without a quote the catalogue name stands. Refused, whether the listing still trades is unknown; answered
    // with an error of the listing's own, a later look would answer the same, so the match stands as it is.
    // Only a source's answer that it has no quote says the listing cannot quote; a failure of its own says nothing.
    return { ticker, quote: null, ...quoteRefused(error) ? { failed: true as const } : isNoSourceAnswer(error) ? { missing: true as const } : {} };
  }
}

/**
 * Whether a quote failed as the service refusing or not reaching it (a rate
 * limit, an overload, a timeout, no connection), which a later look may get
 * past. A failure the service gave for the listing itself (no quote for it, a
 * 4xx, a source that failed it twice) is the listing's own: a symbol whose
 * quote always errors costs no wait. What cannot be told apart is taken for
 * a refusal, so a busy service never lets a line that stopped trading pass as
 * one that trades.
 */
function quoteRefused(error: unknown): boolean {
  if (isNoSourceAnswer(error)) return false;
  for (let current = error, depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    if (current instanceof ApiRequestError) {
      const { status } = current;
      if (status === 408 || status === 429 || status === 503) return true;
      if (status !== undefined && status >= 400 && status < 500) return false;
      return !wasAskedTwice(current);
    }
    if (wasAskedTwice(current)) return false;
    current = (current as { failure?: unknown }).failure ?? (current as { cause?: unknown }).cause;
  }
  return true;
}

export type CliTickerResolution =
  | ({ input: string; error?: undefined } & CliTicker)
  | { input: string; ticker?: undefined; error: Error };

/** Symbols looked up at once. Each is a catalogue search and a quote, so this bounds the requests in flight. */
const RESOLVE_CONCURRENCY = 8;
/**
 * Symbols looked up at once whose searches a batch already answered: each asks
 * only for a quote, gathered with the others' into batch requests of a hundred.
 */
const ANSWERED_CONCURRENCY = 100;
/** Symbols looked up again at once after requests failed, gently, as the service may be limiting the rate. */
const RETRY_CONCURRENCY = 4;
/** The data service's market requests (search, quotes), as connection health names them. */
const MARKET_OPERATION = /^(?:GET|POST) \/market\//;
/**
 * Waits before each new look at the symbols that failed while requests were
 * failing. The first outlasts the five seconds the router keeps an empty
 * search answer. Two, so a long add is done within a minute: what is still
 * refused after them is named with the command that adds it.
 */
const RETRY_WAITS_MS = [6_000, 15_000];

/**
 * Counts the data service's market requests that fail while it watches. A
 * lookup fails as busy while search refuses it (rate limited), reads a search
 * it cannot reach (offline) as no match, and a refused quote as a listing it
 * cannot settle, so a symbol looked up while one failed may be there after all.
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

/** Whether a lookup's failure may be the service refusing it, so a new look could answer: not one refused before any request. */
function mayBeRefusal(error: Error): boolean {
  return !(error instanceof NotASymbolError);
}

function lookUpTickers(
  symbols: readonly string[],
  concurrency: number,
  resolve: (symbol: string) => Promise<CliTicker>,
  looked?: () => void,
): Promise<CliTickerResolution[]> {
  return mapWithConcurrency(symbols, concurrency, async (input): Promise<CliTickerResolution> => {
    try {
      return { input, ...await resolve(input) };
    } catch (error) {
      return { input, error: error instanceof Error ? error : new Error(String(error)) };
    } finally {
      looked?.();
    }
  });
}

/**
 * Whether a lookup failed as busy: a search no source answered in time
 * ("Search is busy"), which gives up before its request fails, so the
 * requests the service failed do not count it.
 */
function busyLookup(entry: CliTickerResolution): boolean {
  return !!entry.error && (entry.error.message === SEARCH_BUSY_MESSAGE || isProviderBusy(entry.error));
}

/** Whether a lookup is to be made again while requests fail: one that failed as refused, or a match whose quote was refused. */
function lookAgain(entry: CliTickerResolution): boolean {
  return entry.error ? mayBeRefusal(entry.error) : entry.unchecked === true;
}

/**
 * What a symbol of a list asks the sources for, so the whole list's searches
 * and change lookups go out in batches first: a bare symbol searches its
 * spellings (`providerSearchQueries`); one with a venue, or read another way,
 * is searched as it always is.
 */
function listLookupPlan(input: string, exchange: string | undefined): ListLookupPlan {
  // What cannot be a symbol is refused without a request.
  if (notASymbolError(input)) return { searches: [], changes: null };
  // A terminal's code abroad (`VOD LN`) is its listing as written: it asks only for its quote.
  const code = settledTerminalCode(input);
  if (code) return { searches: [], changes: null };
  // A company's name searches what its reading searched (`readNameEntries`), answered by the same batch.
  if (isCompanyNameInput(input)) return { searches: companyNameQueries(input), changes: null };
  try {
    // GARAN.IS names its venue, as GARAN:BIST does: it is looked up as a named listing is.
    const listing = parseListingArg(input, exchange, { ownExchangeWins: true, listingSuffix: true });
    const searchable = !listing.exchange && /^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(listing.symbol);
    // A named US venue (ZION:NASDAQ, as a company's name reads) is looked up by search (`listingOfOwnQuote`).
    const usVenue = !!listing.exchange && !listing.sharedCode && isUsSymbolVenue(listing.exchange);
    return {
      searches: searchable ? providerSearchQueries(listing.symbol) : usVenue ? providerSearchQueries(listing.key) : [],
      changes: tickerChangeSymbol(listing.symbol, listing.exchange),
      quote: searchable ? listing.symbol : null,
    };
  } catch {
    // Intentional ignore: an input that is not a listing fails its own lookup, which says why.
    return { searches: [], changes: null };
  }
}

/**
 * `resolveCliTicker` for a list of symbols, several at a time; a symbol that
 * fails gives its error without failing the rest. `--exchange` names the
 * venue of the symbols that do not name their own. Every symbol's change is
 * looked up and waited for, the searches and changes of the whole list in a
 * few batched requests first (`batchedListLookups`). "Not found" means search
 * found no listing: while the service refuses requests, the symbols that
 * failed are looked up again after a pause, and any it still did not answer
 * for fail with `LookupUnansweredError`. One that cannot be a symbol fails
 * with `NotASymbolError` at once: it is never asked for, looked up again or
 * waited for.
 */
export async function resolveTickersForCli(
  symbols: readonly string[],
  store: AppTickerRepositoryPort,
  dataProvider: DataProvider,
  exchange?: string,
  {
    retry,
    askWhenAmbiguous,
    onRetry,
    onProgress,
    retryWaitsMs = RETRY_WAITS_MS,
  }: Pick<CliTickerOptions, "retry" | "askWhenAmbiguous"> & {
    /** Told before each new look, with how many symbols and how long it waits first. */
    onRetry?: (count: number, waitMs: number) => void;
    /** Told as each symbol of the first look is settled, with how many are and how many there are. */
    onProgress?: (looked: number, total: number) => void;
    retryWaitsMs?: readonly number[];
  } = {},
): Promise<CliTickerResolution[]> {
  const plans = new Map(symbols.map((input) => [input, listLookupPlan(input, exchange)] as const));
  let settled = 0;
  const progress = onProgress ? () => onProgress(++settled, symbols.length) : undefined;
  // Symbols every search and own quote of which the service answered in some look: one found nothing for is not
  // found, whatever it refused the others, so it is neither looked up again nor offered to try again.
  const told = new Set<string>();
  const notFound = (entry: CliTickerResolution) => entry.error instanceof TickerNotFoundError && told.has(entry.input);
  // Each look asks for its symbols' searches and changes in batches first.
  const look = async (inputs: readonly string[], concurrency: number, looked?: () => void): Promise<Map<string, CliTickerResolution>> => {
    const batched = await batchedListLookups(dataProvider, inputs.map((input) => plans.get(input)!));
    for (const input of inputs) if (batched.settled(plans.get(input)!)) told.add(input);
    const resolve = (symbol: string) => resolveCliTicker(symbol, store, batched.dataProvider, exchange, {
      retry, askWhenAmbiguous, ownExchangeWins: true, changeGraceMs: LOOKUP_TIMEOUT_MS,
    });
    // Symbols whose searches were answered ask only for quotes, which go out together; the rest ask as before.
    const answered = (input: string) => batched.answered(plans.get(input)!);
    return new Map((await Promise.all([
      lookUpTickers(inputs.filter(answered), ANSWERED_CONCURRENCY, resolve, looked),
      lookUpTickers(inputs.filter((input) => !answered(input)), concurrency, resolve, looked),
    ])).flat().map((entry) => [entry.input, entry] as const));
  };
  const failedRequests = watchFailedRequests();
  try {
    const looked = await look(symbols, RESOLVE_CONCURRENCY, progress);
    let lookups = symbols.map((input) => looked.get(input)!);
    let failing = failedRequests.count() > 0 || lookups.some(busyLookup);
    for (const waitMs of retryWaitsMs) {
      // A match whose quote was refused is looked at again too, so it gets the check a first look gives.
      const failed = lookups.filter((entry) => lookAgain(entry) && !notFound(entry)).map((entry) => entry.input);
      if (!failing || failed.length === 0) break;
      onRetry?.(failed.length, waitMs);
      await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
      const before = failedRequests.count();
      const again = await look(failed, RETRY_CONCURRENCY);
      lookups = lookups.map((entry) => again.get(entry.input) ?? entry);
      failing = failedRequests.count() > before || [...again.values()].some(busyLookup);
    }
    // A company's name typed as one word (Canon, ADVANTEST) that no listing trades as is read as `quote` reads it.
    lookups = await withOneWordNames(lookups, store, dataProvider, { retry, askWhenAmbiguous });
    if (!failing) return lookups;
    // Still refused after the last wait: a failure may only be the refusal, so none is called not found,
    // and a match whose quote was refused is not taken as trading.
    return lookups.map((entry) => lookAgain(entry) && !notFound(entry)
      ? { input: entry.input, error: new LookupUnansweredError(entry.input) }
      : entry);
  } finally {
    failedRequests.stop();
  }
}

/** Names of one word looked up at once: each is a search and a quote. */
const NAME_CONCURRENCY = 4;

/**
 * The lookups, each word no listing trades as (`TickerNotFoundError`) that
 * names a company read as that company's listing, as `quote` reads it
 * (`oneWordCompanyName`): CANON is 7751:JPX, and its row says so ("Read
 * "CANON" as 7751:JPX (Canon Inc.)."). A word that names none keeps its own
 * error.
 */
async function withOneWordNames(
  lookups: CliTickerResolution[],
  store: AppTickerRepositoryPort,
  dataProvider: DataProvider,
  options: Pick<CliTickerOptions, "retry" | "askWhenAmbiguous">,
): Promise<CliTickerResolution[]> {
  const words = lookups.filter((entry) => entry.error instanceof TickerNotFoundError && !entry.error.successor && ONE_WORD.test(entry.input));
  if (words.length === 0) return lookups;
  const read = new Map((await mapWithConcurrency(words, NAME_CONCURRENCY, async (entry): Promise<CliTickerResolution> => {
    try {
      const named = await oneWordCompanyName(entry.input, { dataProvider });
      if (!named) return entry;
      const found = await resolveCliTicker(named.key, store, dataProvider, undefined, { ...options, ownExchangeWins: true, changeGraceMs: LOOKUP_TIMEOUT_MS });
      return { input: entry.input, ...found, readAs: named.readAs ?? found.readAs };
    } catch (error) {
      // Intentional ignore: a name that cannot be read keeps the word's own "not found".
      logFailure("cli.ticker-resolution", "Read a word as a company's name failed")(error);
      return entry;
    }
  })).map((entry) => [entry.input, entry] as const));
  return lookups.map((entry) => read.get(entry.input) ?? entry);
}

/** A word that can be a company's name: letters, three and more, as a pasted name is (`Canon`, `ENEOS`). */
const ONE_WORD = /^\p{L}[\p{L}&'-]{2,}$/u;
