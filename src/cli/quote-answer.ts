import type { QuoteBatchResult } from "../types/data-provider";
import type { Quote } from "../types/financials";
import { bareListingNote } from "../tickers/listing-fate";
import { notATickerSymbol } from "../sources/provider-errors";
import { looksLikeCurrencyPair } from "../utils/currency-pair";
import { canonicalExchange } from "../utils/exchanges";
import type { CliCommandDef } from "../types/plugin";
import { currencyCodeNote } from "./currency-hints";
import { describeSuggestion, suggestListing, suggestUsTicker, type ListingSuggestion } from "./listing-suggestion";
import { indexRootAlsoLine, indexRootTryLine } from "./index-roots";
import { indexRootFor } from "../tickers/index-roots";
import { treasuryYieldLine, treasuryYieldTenor } from "./treasury-yields";
import { knownGapForTicker } from "./known-gaps";
import {
  futuresTryLine,
  isNoProviderError,
  listingChoiceNotes,
  listingReadNotes,
  ListingArgError,
  loadBareVenues,
  notTradedMessage,
  oneWordCompanyName,
  quoteBareListing,
  requireCliListing,
  resolveCliListing,
  tradingBoardNote,
  type CliListing,
  type ListingDataRequest,
  type ListingVenue,
} from "./listing-arg";
import { withListingSuggestion } from "./not-a-ticker";
import { isNetworkFailure } from "../utils/network-failure";
import type { MarketContext } from "./types";

/** The text of an error, or null for none. */
export function errorMessage(error: unknown): string | null {
  if (error == null) return null;
  return error instanceof Error ? error.message : String(error);
}

/**
 * "APPL is not a US ticker: it is Aptus Pharma Limited on BSE (INR). Did you
 * mean AAPL (Apple Inc.)?", for a symbol read on a listing abroad that is one
 * slip from a US ticker, worded as the not-a-ticker answers word it.
 */
export function notUsTickerSentence({ target, quote, listing, usSuggestion }: { target: { symbol: string }; quote: Quote | null; listing?: { name: string | null }; usSuggestion?: ListingSuggestion }): string | null {
  if (!quote || !usSuggestion) return null;
  const venue = canonicalExchange(quote.listingExchangeName || quote.exchangeName);
  const name = quote.name || listing?.name;
  const what = `${name ? `${name} on ` : ""}${venue}${quote.currency ? ` (${quote.currency})` : ""}`;
  return `${target.symbol} is not a US ticker: it is ${what}. Did you mean ${describeSuggestion(usSuggestion)}?`;
}

export interface QuoteAnswer {
  result: QuoteBatchResult;
  /** The listing the row is: the one asked for, or the venue a bare symbol was quoted on. */
  listing: CliListing;
  /** Why there is no quote, when there is more to say than the source's own error. */
  failure?: { message: string; details?: string; oneLine: string };
  notes: string[];
}

/**
 * One symbol's row of `quote` and `compare`. A listing on an exchange its symbol
 * is not listed on says so. A bare symbol the data service read on its home
 * listing abroad names that venue (SXR8 -> XETRA). One no source quotes is
 * quoted on its listings (`quoteBareListing`), else names them, or asks for an
 * exchange when several companies list it (2222); a bare index root (VIX) also
 * names its index (^VIX), and a futures board code a security keeps (GC) its
 * future (GC=F). Venues are only looked up for a
 * symbol with no quote, so a request that succeeds costs no search.
 */
export async function answerQuote(
  result: QuoteBatchResult,
  listing: CliListing,
  market: MarketContext,
  request: ListingDataRequest,
  refresh: boolean,
  venues: Promise<ListingVenue[]> | null,
): Promise<QuoteAnswer> {
  const root = listing.exchange ? null : indexRootFor(listing.symbol);
  // A bare root that quoted something else, such as MOVE (Corvex), points at the index too.
  const also = (quote: Quote) => root && quote.instrumentType?.trim().toUpperCase() !== "INDEX"
    ? [indexRootAlsoLine(root, request.command)] : [];
  if (result.quote) {
    // "CAR = Avis Budget Group, NASDAQ (also XETRA, ASX)" names the venue too, so it replaces "SXR8 -> XETRA".
    const choice = venues ? await listingChoiceNotes(listing, market, result.quote, venues) : listingReadNotes(listing);
    const venue = choice.length > 0 ? null : bareListingNote(listing, result.quote);
    // A row saved as 247540:KRX is quoted from KOSDAQ, the board it trades on.
    const board = tradingBoardNote(listing, result.quote);
    return { result, listing, notes: [...choice, venue ?? [], board ?? [], also(result.quote), currencyCodeNote(listing, result.quote) ?? []].flat() };
  }
  // No answer from the data service: no venue lookup or other listing would get one either.
  if (isNetworkFailure(result.error)) return { result, listing, notes: [] };
  const notTraded = await notTradedMessage(listing, market);
  if (notTraded) return { result, listing, failure: { message: notTraded, oneLine: notTraded }, notes: [] };
  if (!isNoProviderError(result.error)) return { result, listing, notes: [] };
  const other = await quoteBareListing(listing, market, request, { refresh });
  if (other?.kind === "quoted") {
    return {
      result: { target: other.listing.request, quote: other.quote },
      listing: other.listing,
      notes: [other.note, ...also(other.quote), currencyCodeNote(listing, other.quote) ?? []].flat(),
    };
  }
  // Other listings already name a futures board code's future (GC=F); with none, it is named here.
  // A Treasury yield's root (TNX) names its FRED series and the curve beside its index.
  const yieldTenor = root ? treasuryYieldTenor(listing.symbol) : null;
  const tryLines = [
    yieldTenor ? treasuryYieldLine(yieldTenor) : root ? indexRootTryLine(root, request.command) : null,
    other || listing.exchange ? null : futuresTryLine(listing.symbol, request),
    // BDI asks which exchange (Black Diamond Group) and says nowhere that the Baltic Dry Index is not here.
    listing.exchange ? null : knownGapForTicker(listing.symbol),
  ].filter((line): line is string => !!line);
  if (!other && tryLines.length === 0) {
    return await answerCompanyName(result, listing, market, request, refresh)
      ?? { result: await withCurrencyPairHint(result, market), listing, notes: [] };
  }
  const message = other?.message ?? `${listing.symbol} has no ${request.noun}.`;
  const details = [other?.details, ...tryLines].filter(Boolean).join("\n");
  const oneLine = [
    message,
    other ? `${other.heading}: ${other.listings.join(", ")}.` : "",
    ...tryLines,
  ].filter(Boolean).join(" ");
  return { result, listing, failure: { message, details, oneLine }, notes: [] };
}

/**
 * A company's name typed as one word (`Apple`) that the source says is not a
 * ticker, answered as the listing search names for it with the line saying so
 * ("Read "Apple" as AAPL:NASDAQ (Apple Inc.)."), as a name of several words
 * is. Null when the word names no company, or that listing has no quote
 * either: the word keeps its own "Not a ticker".
 */
async function answerCompanyName(
  result: QuoteBatchResult,
  listing: CliListing,
  market: MarketContext,
  request: ListingDataRequest,
  refresh: boolean,
): Promise<QuoteAnswer | null> {
  if (!listing.typed || listing.exchange || !notATickerSymbol(errorMessage(result.error) ?? "")) return null;
  const named = await oneWordCompanyName(listing.typed, market);
  if (!named) return null;
  // A listing on a venue the app cannot read is no answer: the word keeps its own "Not a ticker".
  const resolved = await resolveCliListing(named.key, null, market).catch((error: unknown) => {
    if (error instanceof ListingArgError) return null;
    throw error;
  });
  if (!resolved) return null;
  const found = { ...resolved, readAs: named.readAs, ...named.meant ? { meant: named.meant } : {} };
  const [quoted] = await market.dataProvider.getQuotesBatch([found.request], { forceRefresh: refresh, revalidate: true });
  return quoted?.quote ? answerQuote(quoted, found, market, request, refresh, null) : null;
}

/** A listing a command found a quote for, with what `quote` says beside it. */
interface QuotedListing {
  /** The listing the quote is of: the one typed, or the venue a bare symbol was quoted on. */
  listing: CliListing;
  quote: Quote;
  /** The venue a bare symbol was read on, the currency it may have meant, the US ticker it is one slip from. */
  notes: string[];
}

/**
 * The listing a command that keeps a symbol (`alerts add`) was given, read as
 * `quote` reads it: the same resolver and the same quote request, so what is
 * kept is the listing `quote` prints (USDMXN and USD/MXN are USDMXN=X, MXN is
 * MXN:FWB2) and `quote`'s own notes come back with it. A symbol nothing
 * quotes fails the command with why, and the nearest listing search finds when
 * it is near ("Not a ticker: ZZZQQ. Did you mean ZZZQ?"), so nothing is kept
 * for it.
 */
export async function requireQuotedListing(
  raw: string,
  exchange: string | null | undefined,
  market: MarketContext,
  ctx: Pick<Parameters<CliCommandDef["execute"]>[1], "fail">,
  command: string,
): Promise<QuotedListing> {
  const listing = await requireCliListing(raw, exchange, market, ctx);
  const venues = loadBareVenues(listing, market);
  const [result] = await market.dataProvider.getQuotesBatch([listing.request], { revalidate: true });
  const answer = await answerQuote(result ?? { target: listing.request, quote: null }, listing, market, { command, noun: "quote" }, false, venues);
  const quote = answer.result.quote;
  if (!quote) {
    if (answer.failure) ctx.fail(answer.failure.message, answer.failure.details);
    const message = errorMessage(answer.result.error) ?? `No quote found for ${listing.key}.`;
    // The listing search names, else the US ticker it is one slip from (AAPLL for AAPL), which search does not list for a typo.
    const suggestion = notATickerSymbol(message) && !message.includes(" Did you mean ")
      ? await suggestListing(listing.symbol, market) ?? await suggestUsTicker(listing.symbol, market)
      : null;
    ctx.fail(suggestion ? withListingSuggestion(message, describeSuggestion(suggestion)) : message);
  }
  // A bare symbol read on a listing abroad that is one slip from a US ticker says so, as `quote` does.
  const venue = answer.listing.saved ? null : bareListingNote(answer.listing, quote);
  const usSuggestion = venue && answer.notes.includes(venue) ? await suggestUsTicker(answer.listing.symbol, market) : null;
  const notUs = notUsTickerSentence({ target: answer.result.target, quote, listing: { name: quote.name ?? null }, usSuggestion: usSuggestion ?? undefined });
  return { listing: answer.listing, quote, notes: [...answer.notes, ...notUs ? [notUs] : []] };
}

/**
 * A symbol written like a currency pair that is not a ticker (USD_NGN, as some
 * FX feeds write a pair) names the listing `gloom search` finds nearest to
 * it, as `watchlist add` does: "Did you mean USDNGN=X (US Dollar/Nigerian
 * Naira)?". When search finds nothing near, the row keeps its own error and its
 * search hint.
 */
async function withCurrencyPairHint(result: QuoteBatchResult, market: MarketContext): Promise<QuoteBatchResult> {
  const message = errorMessage(result.error);
  const symbol = message ? notATickerSymbol(message) : null;
  if (!message || !symbol || !looksLikeCurrencyPair(symbol)) return result;
  const suggestion = await suggestListing(symbol, market);
  return suggestion ? { ...result, error: withListingSuggestion(message, describeSuggestion(suggestion)) } : result;
}

