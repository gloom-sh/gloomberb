import { logFailure } from "../utils/log-failure";
import type { DataProvider } from "../types/data-provider";
import type { CompanyProfile, ListingDelisting, PricePoint, Quote } from "../types/financials";
import { savedCopyAt } from "../data/saved-copies";
import { sameCompany } from "./company-name";
import type { TickerChanges } from "../types/ticker-changes";
import {
  describeFormerIssuer,
  describeTickerChange,
  movedAwayChange,
  quotedListing,
  startTickerChangeLookup,
  tickerChangeLine,
  type CurrentListing,
  type FormerIssuer,
  type MovedTickerChange,
  type TickerChange,
  type TickerChangeLookup,
} from "./ticker-changes";
import { isQuoteBeforeLatestSession, isQuoteStaleForCurrentSession } from "../market-data/quotes/freshness";
import { formatMarketPriceWithCurrency, quoteFormatOptions } from "../market-data/market/format";
import { canonicalExchange, isUsListingExchange, parsePublicTickerKey, resolveExchangeTimeZone } from "../utils/exchanges";
import { zonedDateKey } from "../utils/zoned-date-time";
import { delistingLabel } from "../market-data/quotes/delisting";

/*
 * What became of a symbol, read the way `quote` reads it: the listing's own
 * quote says whether and when it stopped trading, and the symbol's ticker
 * changes say whether its company moved. The CLI commands and the app's panes
 * both decide from here what a symbol has to serve.
 */

// A quote this much older than now, and stale, is a listing that stopped trading, not a quiet day.
const ENDED_AFTER_MS = 183 * 24 * 60 * 60_000;

/**
 * The exchange-local date a listing last traded, when its quote is stale and
 * that was over half a year ago (TWTR's 2022-10-27); null for anything newer.
 * A quote that says its listing no longer trades gives its last session.
 */
function endedTradingDate(quote: Quote, now = Date.now()): string | null {
  if (quote.delisting) return quote.delisting.lastTradeDate;
  const last = Math.max(...[quote.lastTradeTime, quote.lastUpdated].filter((time): time is number => Number.isFinite(time)));
  if (!(last > 0) || now - last < ENDED_AFTER_MS || !isQuoteStaleForCurrentSession(quote, now)) return null;
  return quoteDateKey(quote, last);
}

/** A time as a date on the quote's exchange (2024-10-25). */
function quoteDateKey(quote: Quote, time: number): string {
  return zonedDateKey(time, resolveExchangeTimeZone(quote.listingExchangeName || quote.exchangeName) ?? "UTC");
}

/**
 * The exchange-local date of a quote's last trade (2024-10-25), as a stale
 * row is dated: its trade time when it has one, else when it was last
 * updated; null when it has neither.
 */
export function lastTradeDate(quote: Quote): string | null {
  const last = [quote.lastTradeTime, quote.lastUpdated].find((time): time is number => typeof time === "number" && Number.isFinite(time) && time > 0);
  return last == null ? null : quoteDateKey(quote, last);
}

/** What trades under a symbol now, from its quote: nothing when it has none or stopped long ago. */
export function tradingListing(quote: Quote | null | undefined, now = Date.now()): CurrentListing | null {
  return quote && !endedTradingDate(quote, now) ? quotedListing(quote) : null;
}

/**
 * "TWTR: no longer trading since 2022-10-27 (last price $53.86)", for a quote
 * that stopped long ago; "TWTR: Delisted Oct 27, 2022 (last price $53.86)"
 * when the quote says the listing no longer trades.
 */
export function noLongerTradingNote(label: string, quote: Quote, now = Date.now()): string | null {
  const date = endedTradingDate(quote, now);
  if (!date) return null;
  const price = formatMarketPriceWithCurrency(quote.price, quote.currency, quoteFormatOptions(quote));
  return quote.delisting
    ? `${label}: ${delistingLabel(quote.delisting)} (last price ${price})`
    : `${label}: no longer trading since ${date} (last price ${price})`;
}

// A listing with no quote whose newest bar is this old has not traded since; a newer one is a quiet month.
const NO_QUOTE_ENDED_AFTER_MS = 30 * 24 * 60 * 60_000;

/**
 * When a listing the service has no quote for last traded, and whether the
 * service says it no longer trades. `recorded`: its history carries the
 * service's delisting record, whose last day wins over the bars. Otherwise
 * only its newest bar, over 30 days old, says it: a retired line and a thin
 * one that has not traded in a month look alike, so that says no more than
 * "no trades since".
 */
export interface NoQuoteLastTrade {
  date: string;
  recorded: boolean;
}

/**
 * When a listing the service has no quote for last traded (`NoQuoteLastTrade`).
 * Null for one that traded within the month, has no bars, or whose bars are a
 * copy saved earlier because the refresh failed: the age of a saved copy's
 * bars says when it was saved, not that the listing stopped.
 */
export function noQuoteLastTraded(
  history: { points: readonly Pick<PricePoint, "date">[]; delisting?: ListingDelisting; savedCopyBehind?: true },
  now = Date.now(),
): NoQuoteLastTrade | null {
  if (history.delisting) return { date: history.delisting.lastTradeDate, recorded: true };
  if (history.savedCopyBehind || savedCopyAt(history) != null) return null;
  const newest = Math.max(...history.points.map((point) => new Date(point.date).getTime()).filter(Number.isFinite));
  return Number.isFinite(newest) && now - newest > NO_QUOTE_ENDED_AFTER_MS
    ? { date: new Date(newest).toISOString().slice(0, 10), recorded: false }
    : null;
}

/** "FLAT last traded 2020-06-03; no longer listed": what `quote`, `ticker`, `history` and `search` say of such a listing. */
export function noLongerListedNote(symbol: string, lastTraded: string): string {
  return `${symbol} last traded ${lastTraded}; no longer listed`;
}

/**
 * What a command says of a listing with no quote that has not traded in over
 * a month: "no longer listed" only on the service's record of it, else "XYZ:
 * no trades since 2026-08-14".
 */
export function noQuoteLastTradeNote(symbol: string, lastTrade: NoQuoteLastTrade): string {
  return lastTrade.recorded ? noLongerListedNote(symbol, lastTrade.date) : `${symbol}: no trades since ${lastTrade.date}`;
}

/** What says whether a profile served under a stopped listing's symbol is its own (`otherListingProfile`). */
export interface ListingProfileEvidence {
  /** The listing asked for is a US line: a bare symbol, read on its US line, or one on a US venue. */
  usLine: boolean;
  /** The names on record for the symbol's own issuer: its saved listing's, its ticker change's, a former issuer's. */
  issuerNames?: readonly (string | null | undefined)[];
}

const US_COUNTRY = /^(?:us|usa|united states(?: of america)?)$/i;

/**
 * The name of the other listing a profile served under a stopped listing's
 * symbol is of (STPP: a UCITS fund domiciled abroad took the symbol after the
 * iPath steepener ended), only on evidence: it names a company none of the
 * names on record for the symbol's issuer are, or, with none of those
 * matching it, its issuer is domiciled outside the US while the listing asked
 * for is a US line. Otherwise the profile is the listing's own (a stopped
 * company keeps its profile), and the answer is null. A profile that names no
 * one, shown to be abroad, is named by its country.
 */
export function otherListingProfile(
  profile: Pick<CompanyProfile, "name" | "country"> | null | undefined,
  evidence: ListingProfileEvidence,
): string | null {
  const named = profile?.name?.trim() || null;
  const country = profile?.country?.trim() || null;
  const issuers = (evidence.issuerNames ?? []).flatMap((name) => name?.trim() ? [name.trim()] : []);
  const ownName = !!named && issuers.some((issuer) => sameCompany(issuer, named));
  const otherIssuer = !!named && issuers.length > 0 && !ownName;
  const abroad = evidence.usLine && !!country && !US_COUNTRY.test(country) && !ownName;
  if (!otherIssuer && !abroad) return null;
  return named ?? `a company domiciled in ${country}`;
}

/** "The profile served under STPP is another listing's (...), not shown.": the line for `otherListingProfile`'s answer. */
export function otherListingProfileNote(symbol: string, other: string): string {
  return `The profile served under ${symbol} is another listing's (${other}), not shown.`;
}

/**
 * The US venue to read a bare symbol's own US line on, where a source can
 * otherwise answer it with a listing abroad: the one its listing metadata
 * names, else NYSE. The US exchanges share one symbol, and the service reads
 * any of them as the symbol's one US line (STPP's ended on BATS in 2020).
 */
export async function usVenueOf(
  symbol: string,
  dataProvider: Pick<DataProvider, "getQuoteMetadata">,
): Promise<string> {
  const venue = (await dataProvider.getQuoteMetadata?.(symbol, "")
    .catch(logFailure("tickers-listing-fate", "Read a stopped listing's venue failed", null)))?.listingExchangeName;
  return venue && isUsListingExchange(venue) ? venue : "NYSE";
}

/** When a listing with no quote last traded (`NoQuoteLastTrade`), and its last close then. */
export interface NoQuoteEnding extends NoQuoteLastTrade {
  lastClose: number | null;
}

/**
 * `noQuoteLastTraded` for a listing a command has no quote for, from its
 * latest month of daily bars (a listing that stopped answers its last ones),
 * with its last close: a bare symbol's on the US venue its metadata names,
 * whose bars a source can otherwise answer with a listing abroad's. Fails
 * soft: a source that does not answer says nothing.
 */
export async function loadNoQuoteEnding(
  listing: { symbol: string; exchange?: string | null },
  dataProvider: Pick<DataProvider, "getPriceHistory" | "getPriceHistoryWithMetadata" | "getQuoteMetadata">,
  now = Date.now(),
): Promise<NoQuoteEnding | null> {
  try {
    const exchange = listing.exchange || await usVenueOf(listing.symbol, dataProvider);
    // Asked afresh: a copy saved for the bare symbol (a listing abroad's bars) can otherwise answer for the venue.
    const history = dataProvider.getPriceHistoryWithMetadata
      ? await dataProvider.getPriceHistoryWithMetadata(listing.symbol, exchange, "1M", { cacheMode: "refresh" })
      : { points: await dataProvider.getPriceHistory(listing.symbol, exchange, "1M", { cacheMode: "refresh" }) };
    const lastTrade = noQuoteLastTraded(history, now);
    const close = history.points.at(-1)?.close;
    return lastTrade ? { ...lastTrade, lastClose: typeof close === "number" && Number.isFinite(close) ? close : null } : null;
  } catch (error) {
    logFailure("tickers-listing-fate", "Could not read a listing's last bars")(error);
    return null;
  }
}

/** `loadNoQuoteEnding` without the close: what `quote`, `ticker` and `history` say of a listing with no quote. */
export async function loadNoQuoteLastTraded(
  listing: { symbol: string; exchange?: string | null },
  dataProvider: Pick<DataProvider, "getPriceHistory" | "getPriceHistoryWithMetadata" | "getQuoteMetadata">,
  now = Date.now(),
): Promise<NoQuoteLastTrade | null> {
  const ending = await loadNoQuoteEnding(listing, dataProvider, now);
  return ending ? { date: ending.date, recorded: ending.recorded } : null;
}

/**
 * What became of a symbol, from what `quote` reads it by: the listing's own
 * quote, which says when it stopped trading, and the symbol's ticker changes
 * beside that quote (FB became META).
 */
export interface ListingFate {
  /** The exchange-local date the listing last traded, when its quote stopped long ago (TWTR's 2022-10-27). */
  endedOn: string | null;
  /** The symbol's change as `quote` reads it; null when it has none, or was read on a listing abroad. */
  change: TickerChange | null;
  /**
   * The line a command with nothing to serve for the symbol says: `quote`'s
   * change line when its company left it ("FB now lists ...; Meta Platforms
   * trades as META (changed 2022-06-09)"), else, for a listing the service
   * says no longer trades, "TWTR: Delisted Oct 27, 2022", and for another
   * that stopped, "XYZ stopped trading 2022-10-27; no history or options
   * served". Null for a symbol that trades as it always has.
   */
  note: string | null;
  /**
   * "TWTR: Delisted Oct 27, 2022" when the listing's quote says it no longer
   * trades: its history is served, ending on that session, and says so.
   */
  delisted?: string;
  /**
   * The change when the symbol's company trades under another symbol now
   * and its own quote shows nothing new listed under it (`movedAwayChange`):
   * the old line, stopped or named for that company. Whatever data comes
   * back under the symbol is then another security's (a listing abroad with
   * the same letters, or the new symbol's bars under the old one), so a
   * command or pane serves none and names the new symbol. Null without a
   * quote to tell by.
   */
  moved: MovedTickerChange | null;
  /**
   * The company that last held the symbol merged into another one, read as
   * `quote` reads it ("GOGL was Golden Ocean Group until 2025, now Cmb.Tech:
   * CMBT"); null when none is on record, or for a listing abroad.
   */
  formerIssuer: FormerIssuer | null;
}

/**
 * The one line `search` says about what became of a symbol: a company that
 * left it ("NEP became XIFR on 2025-02-03"), else one that merged away from
 * it (GOGL). Null for a symbol nothing became of.
 */
export function listingChangeLine(fate: Pick<ListingFate, "change" | "formerIssuer">): string | null {
  return tickerChangeLine(fate.change) ?? fate.formerIssuer?.note ?? null;
}

/** Nothing became of the symbol, or nothing could be told. */
export const NO_FATE: ListingFate = { endedOn: null, change: null, note: null, moved: null, formerIssuer: null };
/** How long a fate waits for a change lookup it started late, or for a stopped line's. */
export const LATE_CHANGE_WAIT_MS = 2_000;
/**
 * How long a command that says what became of a symbol's company (GOGL's merger) waits for the lookup it started
 * beside its own request, once that is in: the lookup takes about a third of a second, and a cached request answers
 * at once. A lookup that hangs costs a symbol that trades no more than this.
 */
export const SUCCESSOR_CHANGE_WAIT_MS = 750;

// The zones of the US exchanges; a venue in another is abroad.
const US_TIME_ZONES = new Set(["America/New_York", "America/Chicago"]);

/** A venue the app places outside the US: not a US exchange, OTC or a futures exchange, nor one it cannot place. */
export function isVenueAbroad(venue: string): boolean {
  const zone = resolveExchangeTimeZone(venue);
  return !!zone && !US_TIME_ZONES.has(zone) && !isUsListingExchange(venue);
}

/**
 * "SXR8 -> XETRA" for a bare symbol the data service read on its home listing
 * abroad, as it reads a symbol with no US listing whose listings belong to one
 * company or fund: a row that shows the symbol as typed says which listing it
 * is. Null for a named or saved venue, and for a venue the app does not place
 * outside the US (a US exchange, OTC, a futures exchange).
 */
export function bareListingNote(
  listing: { symbol: string; request: { exchange: string } },
  quote: Pick<Quote, "listingExchangeName" | "exchangeName"> | null | undefined,
): string | null {
  if (listing.request.exchange || !quote || !/^[A-Z0-9]{1,10}$/.test(listing.symbol)) return null;
  const venue = canonicalExchange(quote.listingExchangeName || quote.exchangeName);
  return isVenueAbroad(venue) ? `${listing.symbol} -> ${venue}` : null;
}

/** `ListingFate` from a listing's quote (null when it has none) and its ticker changes. */
export function describeListingFate(
  listing: { symbol: string; exchange?: string | null },
  quote: Quote | null,
  changes: TickerChanges | null,
  now = Date.now(),
): ListingFate {
  const symbol = listing.symbol.trim().toUpperCase();
  const endedOn = quote ? endedTradingDate(quote, now) : null;
  // A bare symbol read on a listing abroad (SXR8 -> XETRA) is not the US symbol the changes are of.
  const abroad = !!quote && !!bareListingNote({ symbol, request: { exchange: listing.exchange ?? "" } }, quote);
  const current = tradingListing(quote, now);
  const change = abroad ? null : describeTickerChange(symbol, changes, current);
  const delisted = quote?.delisting && !abroad ? `${symbol}: ${delistingLabel(quote.delisting)}` : undefined;
  const note = tickerChangeLine(change) ?? delisted ?? (endedOn ? `${symbol} stopped trading ${endedOn}; no history or options served` : null);
  const formerIssuer = abroad ? null : describeFormerIssuer(symbol, changes, current);
  return { endedOn, change, note, moved: quote ? movedAwayChange(change) : null, formerIssuer, ...(delisted ? { delisted } : {}) };
}

/**
 * Whether a quote's line stopped: a whole session traded without it, or it
 * ended long ago. Only such a line can be a company that moved away, so only
 * its change lookup is waited for.
 */
export function lineMayHaveMoved(quote: Quote | null, now = Date.now()): boolean {
  return !!quote && (isQuoteBeforeLatestSession(quote, now) || endedTradingDate(quote, now) != null);
}

/**
 * `describeListingFate` for a listing: its quote is `quote` when the command
 * has it, else loaded; its changes come from `changes` when the command started
 * that lookup beside its own request, else from one started here. Fails soft:
 * a source that does not answer says nothing became of it.
 */
export async function loadListingFate(
  listing: { symbol: string; exchange?: string | null; request?: { symbol: string; exchange: string } },
  dataProvider: Pick<DataProvider, "getQuote" | "getTickerChanges">,
  /**
   * `graceMs`: how long a lookup the command started waits once the quote is in, for a command that says what
   * became of the company beside what it serves (GOGL's merger), not only whether it moved. A short grace by default.
   */
  options: { quote?: Quote | null | Promise<Quote | null>; changes?: TickerChangeLookup; graceMs?: number } = {},
): Promise<ListingFate> {
  const request = listing.request ?? { symbol: listing.symbol, exchange: listing.exchange ?? "" };
  const lookup = options.changes ?? startTickerChangeLookup(dataProvider, listing.symbol, listing.exchange);
  try {
    const quote = await (options.quote !== undefined
      ? options.quote
      : dataProvider.getQuote(request.symbol, request.exchange).catch(logFailure("tickers-listing-fate", "Could not load listing fate quote", null)));
    // A lookup started beside the command's request gets a short grace once that is ready, so a slow
    // one never holds a symbol that trades. A line that stopped is waited for: only its company can
    // have moved, and then the answer decides whether the command serves anything at all.
    const changes = await lookup.settle(!options.changes || lineMayHaveMoved(quote) ? LATE_CHANGE_WAIT_MS : options.graceMs);
    return describeListingFate(listing, quote, changes);
  } catch (error) {
    logFailure("tickers-listing-fate", "Could not resolve listing fate")(error);
    return NO_FATE;
  }
}

/**
 * The lines a command says about a symbol's fate beside what it served. With
 * nothing served, `fate.note`. With data, `fate.delisted` for a listing that
 * no longer trades ("TWTR: Delisted Oct 27, 2022"), `quote`'s change line when the
 * symbol's company left it (FB's bars are the fund listed there now), and, for
 * bars from before the symbol's holder took it (META's from 2021), that they
 * are from its old symbol: "Includes FB-era bars: META was FB until 2022-06-09".
 */
export function listingFateNotes(fate: ListingFate, served: { served: boolean; firstDate?: string | null }): string[] {
  if (!served.served) return fate.note ? [fate.note] : [];
  const { change } = fate;
  const first = served.firstDate?.slice(0, 10);
  const earlier = change?.kind === "formerly" && first ? change.changes.filter((hop) => first < hop.date).map((hop) => hop.from) : [];
  return [
    // What it served ends on the listing's last session, and says so.
    fate.delisted ?? null,
    // A company that left the symbol, else one that merged away from it (GOGL), as `quote` says it.
    listingChangeLine(fate),
    earlier.length > 0 ? `Includes ${earlier.join("- and ")}-era bars: ${change!.note}` : null,
  ].filter((line): line is string => !!line);
}

/**
 * A report's notes and errors beside what became of its symbol, worded as
 * `quote`, `history` and `options` word it: with nothing served, the fate is
 * why ("TWTR: Delisted Oct 27, 2022", "FB now lists ...; Meta Platforms
 * trades as META") and stands in for the errors the empty load raised ("Not
 * a ticker", "No options provider"); with data, `listingFateNotes` beside
 * the errors. A symbol whose company moved, with nothing listed under it now,
 * has nothing of its own to serve and throws `MovedSymbolError`.
 */
export function listingFateReport(
  fate: ListingFate,
  served: { served: boolean; firstDate?: string | null },
  errors: readonly string[],
): { notes: string[]; errors: string[] } {
  if (fate.moved) throw new MovedSymbolError(fate.moved);
  const notes = listingFateNotes(fate, served);
  return { notes, errors: !served.served && notes.length > 0 ? [] : [...errors] };
}

/**
 * A report that served nothing for its symbol (`listingFateReport`): what
 * became of the symbol is the one reason it is empty, said once in place of
 * every table's "No data." and of the load's errors; the errors alone when
 * nothing became of it.
 */
export function listingFateEmpty(fate: ListingFate, errors: readonly string[]): { empty?: string; errors: string[] } {
  const report = listingFateReport(fate, { served: false }, errors);
  return report.notes.length ? { empty: report.notes.join(" "), errors: report.errors } : { errors: report.errors };
}

/**
 * What a report or loader with nothing of its own to serve for a symbol
 * throws when the symbol's company moved (`ListingFate.moved`): its message
 * is the change's line, "HFC became DINO on 2022-03-15".
 */
export class MovedSymbolError extends Error {
  constructor(readonly change: MovedTickerChange) {
    super(change.note);
    this.name = "MovedSymbolError";
  }
}

/**
 * The listing an instrument's fate is read for: its symbol without the venue
 * a key carries (HFC:NYSE is HFC on NYSE). Null for a broker's contract,
 * which is not a listing the change history is about.
 */
export function fateListing(instrument: {
  symbol: string;
  exchange?: string | null;
  brokerId?: string;
  instrument?: unknown;
}): { symbol: string; exchange: string } | null {
  if (instrument.brokerId || instrument.instrument) return null;
  const key = parsePublicTickerKey(instrument.symbol);
  return { symbol: key.symbol, exchange: key.exchange ?? instrument.exchange ?? "" };
}

/**
 * What a pane does with a symbol: serve it, wait to know, or show that its
 * company moved (`ListingFate.moved`) instead of another security's data.
 * A symbol waits only while what is known says nothing trades under it: a
 * quote that shows the line ended waits for the change lookup, and a change
 * that says the company left with nothing known listed there waits for the
 * quote. Any other symbol is served at once, whatever is still coming, a
 * quote cached from an earlier session included. A lookup that failed or
 * answered nothing is no change.
 */
export type ListingFateGate =
  | { kind: "serve" }
  | { kind: "wait" }
  | { kind: "moved"; change: MovedTickerChange };

const SERVE: ListingFateGate = { kind: "serve" };
const WAIT: ListingFateGate = { kind: "wait" };

/**
 * `ListingFateGate` from what is known so far. `quote` and `changes` are
 * undefined while they load and null when there is none. A move on record
 * is told by the quote, which says whether the old line stopped or something
 * new trades there (FB's fund); until it is in, the change's own word on
 * what lists there now decides whether to wait for it.
 */
export function listingFateGate(
  listing: { symbol: string; exchange?: string | null },
  { quote, changes }: { quote: Quote | null | undefined; changes: TickerChanges | null | undefined },
  now = Date.now(),
): ListingFateGate {
  if (changes === undefined) return quote && endedTradingDate(quote, now) ? WAIT : SERVE;
  if (!changes?.moved) return SERVE;
  if (quote === undefined) return movedAwayChange(describeTickerChange(listing.symbol, changes)) ? WAIT : SERVE;
  const { moved } = describeListingFate(listing, quote, changes, now);
  return moved ? { kind: "moved", change: moved } : SERVE;
}
