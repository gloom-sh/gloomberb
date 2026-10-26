import { logFailure } from "../utils/log-failure";
import type { DataProvider } from "../types/data-provider";
import type { InstrumentSearchResult } from "../types/instrument";
import { canonicalExchange, isUsListingExchange, parsePublicTickerKey } from "../utils/exchanges";
import { companyNameMatch, sameCompany, shortCompanyName } from "./company-name";
import { LISTING_SEARCH_LIMIT } from "./search";
import { lineDistance } from "./search/home-listing";
import { classifyInstrumentKind, isCryptoInstrumentType } from "./search/ranking";
import { isProviderBusy, type ProviderBusyError } from "../sources/provider-errors";
import { readTerminalListingCode, type TerminalListing, type TerminalListingCode } from "./terminal-codes";
import { hasNonLatinLetters } from "../utils/typed-text";

export interface CompanyNameListing {
  symbol: string;
  /** Canonical code of its exchange. */
  exchange: string;
  /** The listing's name as search gives it. */
  name: string;
  /**
   * When the listing is a fund or an index carrying the name ("JP Morgan" read
   * as ^JTEK, JP MORGAN ETF TRUS), the company's common stock the name says
   * run together (JPM, JPMorgan Chase & Co.), which the reader is asked about.
   */
  meant?: Omit<CompanyNameListing, "meant">;
}

/** Share lines that are not the company's common stock, though search may type them as such. */
const NOT_COMMON = /preferred|warrant|right|unit|note|bond|debenture/i;
const RECEIPT = /depositary|^(?:ADR|ADS|GDR|CDR|BDR)$/i;

/** A list entry with a space inside is a company's name, never a symbol: "Whirlpool Corporation". */
export function isCompanyNameInput(input: string): boolean {
  return /\S\s+\S/.test(input.trim());
}

/**
 * The listing a company's name stands for when it is typed where a symbol
 * goes, as an entry of a comma list ("Whirlpool Corporation" is WHR on
 * NYSE). Of search's listings whose names have every word of it, or a word
 * it shortens ("philip morris intl" is Philip Morris International; the name
 * is also searched without its legal form, which can find more), the company
 * whose name says no more than the one typed goes first, so a subsidiary that
 * shares the word (Whirlpool of India) does not, and of those a name matched
 * word for word before one a short form matched; then a company's shares
 * (its stock or a receipt) before a fund or an index named alike; then its
 * primary listing, the line the service marks as its home (SIE on XETRA for
 * "SIEMENS AG"), before
 * its other plain lines, those before a line that only quotes shares listed
 * elsewhere (4SIE in Milan, OTC, a regional German venue) and those before a
 * depositary receipt (SAP's NYSE line for "SAP SE"), so a receipt is the
 * listing only of a company listed by receipts alone (PDD); then the row the
 * service marks with the name, a US line, the shortest symbol (WHR before
 * WHR-A) and search's order. The row the service marks with the name as typed
 * (`searchAliases`: JPM for "JP Morgan", SIE for "SIEMENS AG", though its name
 * is Siemens Aktiengesellschaft) is named by it exactly. Contracts, preferred
 * shares and notes are never the listing. With `quoted`, a listing with no
 * quote (a line search keeps for a venue that no longer prices it) gives way
 * to the next of the same company's lines that has one, never to another
 * company's home line; when none has, or the source is too busy to say, the
 * first stands. With `meant`, a fund or an index found for a name its
 * company's stock says run together ("JP Morgan" for JPMorgan Chase & Co.)
 * names that stock as `meant`, searched under the run-together name when the
 * answer lacks it. With `oneWord`, for a name typed as one word, which many
 * listings' names have ("oil", "steel"): only search's top result, a row the
 * service marks with the word, or a name that is the word and nothing more
 * (Apple Inc. for "apple") is the listing, never a short form ("grp" for any
 * Group) or a coin, whose name is the crypto board's. Null when none matches;
 * when none does because search was too busy to answer, `ProviderBusyError`.
 */
export async function findListingOfCompanyName(
  dataProvider: Pick<DataProvider, "search"> & Partial<Pick<DataProvider, "getQuote">>,
  typed: string,
  options: { meant?: boolean; oneWord?: boolean; quoted?: boolean } = {},
): Promise<CompanyNameListing | null> {
  const name = typed.trim();
  if (!name) return null;
  const queries = [...new Set([name, shortCompanyName(name)])].filter(Boolean);
  const answers = await Promise.all(queries.map((query) => searchListings(dataProvider, query)));
  const busy = answers.find(isProviderBusy);
  const results = answers.flatMap((answer) => Array.isArray(answer) ? answer : []);
  const ranked = results.flatMap((result, order) => {
    const exchange = listedExchange(result);
    const type = listedType(result);
    const named = namedByService(name, result);
    const match = named ? { extra: 0, abbreviated: 0 } : companyNameMatch(name, result.name);
    if (!exchange || match == null || classifyInstrumentKind(type) === "derivative" || NOT_COMMON.test(type)
      || parsePublicTickerKey(result.symbol).exchange) return [];
    if (options.oneWord && (match.abbreviated > 0 || isCryptoInstrumentType(type) || !(order === 0 || named || match.extra === 0))) return [];
    // A receipt is a company's shares too, however search types it ("Depositary Receipt" or "American Depositary Receipt").
    const stock = classifyInstrumentKind(type) === "equity" || RECEIPT.test(type) ? 0 : 1;
    const home = result.homeListing === true;
    const line = home ? 0 : 1 + lineDistance(type, exchange, result.symbol);
    return [{
      result, exchange, stock, home,
      rank: [match.extra, match.abbreviated, stock, line, named ? 0 : 1, isUsListingExchange(exchange) ? 0 : 1, result.symbol.length, order],
    }];
  }).sort((left, right) => {
    const at = left.rank.findIndex((value, index) => value !== right.rank[index]);
    return at < 0 ? 0 : left.rank[at]! - right.rank[at]!;
  });
  const first = ranked[0];
  // Listings are named in Latin letters: a name in another script ("任天堂 ソニー") names none, answered or not.
  if (!first && busy && !hasNonLatinLetters(name)) throw busy;
  if (!first) return null;
  // The first may give way to its company's other lines: as near the name and of its kind. Another line the
  // service marks as a home is another company's (Siemens Ltd. on NSE, for "SIEMENS AG"), and so is a line
  // named as that one is (Siemens Ltd. on BSE).
  const otherHomes = new Set(ranked.filter((listing) => listing.home && listing !== first).map(({ result }) => plainName(result.name)));
  otherHomes.delete(plainName(first.result.name));
  const lines = ranked.filter((listing) => listing === first || (!listing.home && !otherHomes.has(plainName(listing.result.name))
    && sameCompany(first.result.name, listing.result.name)
    && listing.rank.slice(0, NAME_RANKS).every((value, index) => value === first.rank[index])));
  const best = options.quoted ? await firstQuoted(dataProvider, lines) : first;
  const found = { symbol: best.result.symbol.toUpperCase(), exchange: best.exchange, name: best.result.name };
  const meant = best.stock && options.meant ? await stockNamedRunTogether(dataProvider, name, results) : null;
  return meant ? { ...found, meant } : found;
}

/** The ranks that say how near a listing's name is to the one typed, and whether it is a stock: one company's lines share them. */
const NAME_RANKS = 3;

/** Lines past the first a name's listing is asked a quote for, at once, when the first has none. */
const QUOTE_FALLBACKS = 4;

interface RankedListing {
  result: InstrumentSearchResult;
  exchange: string;
}

/**
 * The first of a company's lines, in their order, that has a quote: the first
 * itself, or when it has none, the first of the next few that does, asked
 * together. The first stands when none has a quote, when the source is too
 * busy to say, and when nothing here can ask for quotes.
 */
async function firstQuoted<T extends RankedListing>(dataProvider: Partial<Pick<DataProvider, "getQuote">>, lines: readonly T[]): Promise<T> {
  const first = lines[0]!;
  if (!dataProvider.getQuote) return first;
  const quoted = ({ result, exchange }: RankedListing) => dataProvider.getQuote!(result.symbol.toUpperCase(), exchange).then(hasPrice);
  try {
    if (await quoted(first)) return first;
  } catch (error) {
    // A busy source says nothing of the listing; any other failure is a listing with no quote.
    if (isProviderBusy(error)) return first;
  }
  const keys = new Set([listingKey(first)]);
  const next: T[] = [];
  for (const line of lines) {
    if (next.length === QUOTE_FALLBACKS) break;
    if (keys.has(listingKey(line))) continue;
    keys.add(listingKey(line));
    next.push(line);
  }
  const priced = await Promise.all(next.map((line) => quoted(line).catch(() => {
    // Intentional ignore: a line whose quote fails is a line with no quote.
    return false;
  })));
  return next.find((_, index) => priced[index]) ?? first;
}

/** A name as two venues may spell it alike: "SIEMENS LTD" for Siemens Ltd. */
function plainName(name: string | null | undefined): string {
  return (name ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function listingKey({ result, exchange }: RankedListing): string {
  return `${result.symbol.toUpperCase()}:${exchange}`;
}

function hasPrice(quote: { price?: number } | null | undefined): boolean {
  return !!quote && Number.isFinite(quote.price) && quote.price !== 0;
}

function searchListings(dataProvider: Pick<DataProvider, "search">, query: string): Promise<InstrumentSearchResult[] | ProviderBusyError> {
  return dataProvider.search(query, { limit: LISTING_SEARCH_LIMIT })
    .catch((error: unknown): InstrumentSearchResult[] | ProviderBusyError => {
      if (isProviderBusy(error)) return error;
      logFailure("tickers-company-name-listing", "Could not search company listings")(error);
      return [];
    });
}

function listedExchange(result: InstrumentSearchResult): string {
  return canonicalExchange(result.exchange === "SMART" ? result.primaryExchange : result.exchange || result.primaryExchange);
}

function listedType(result: InstrumentSearchResult): string {
  return result.brokerContract?.secType || result.type || "";
}

/** Letters and digits only, in capitals: "JP Morgan" and "JPMorgan" are JPMORGAN. */
function runTogether(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** Whether the service marked the row with the name as typed: the company it means by it. */
export function namedByService(typed: string, result: InstrumentSearchResult): boolean {
  const wanted = runTogether(typed);
  return !!wanted && Array.isArray(result.searchAliases)
    && result.searchAliases.some((alias) => typeof alias === "string" && runTogether(alias) === wanted);
}

/**
 * The company's common stock on a US exchange whose name starts with the
 * typed words run together ("JPMorgan Chase & Co." for "JP Morgan"), first in
 * search's order; the answer at hand is searched first, then the run-together
 * name itself. Null when none is, or when a single word was typed.
 */
async function stockNamedRunTogether(
  dataProvider: Pick<DataProvider, "search">,
  typed: string,
  results: readonly InstrumentSearchResult[],
): Promise<Omit<CompanyNameListing, "meant"> | null> {
  const wanted = runTogether(typed);
  if (wanted.length < 4 || !/\s/.test(typed.trim())) return null;
  const stockOf = (rows: readonly InstrumentSearchResult[]) => rows.find((result) => {
    const type = listedType(result);
    return classifyInstrumentKind(type) === "equity" && !NOT_COMMON.test(type) && !RECEIPT.test(type)
      && isUsListingExchange(listedExchange(result)) && !parsePublicTickerKey(result.symbol).exchange
      && (runTogether(result.name).startsWith(wanted) || namedByService(typed, result));
  });
  let stock = stockOf(results);
  if (!stock) {
    const answer = await searchListings(dataProvider, typed.trim().replace(/\s+/g, ""));
    stock = Array.isArray(answer) ? stockOf(answer) : undefined;
  }
  return stock ? { symbol: stock.symbol.toUpperCase(), exchange: listedExchange(stock), name: stock.name } : null;
}

/** `BRK.B`, `BRK-B` and `BRK/B` alike. */
const shareClassSymbol = (symbol: string) => symbol.trim().toUpperCase().replace(/[-/]/g, ".");

/**
 * A terminal's code typed where a symbol goes, when it is one, on the listing
 * search knows it by. A Reuters code (WFC.N), an index, a currency and a
 * future always are. A Bloomberg equity code is words, which a fund's name can
 * be too ("Putnam US Equity", "Global US Equity"), so one for the US, or typed
 * in lower case, is one only when search lists its root there (JPM on a US
 * exchange, VOD on LSE); otherwise it is the name it reads as, and is searched
 * as one. One in capitals naming a venue abroad (`MC FP`) is one as typed: the
 * venue's own check speaks when the symbol is not there. A code that can name
 * several listings (`VOLVB SS` is VOLVB or VOLV.B in Stockholm, `RY CN`
 * Toronto or the Venture exchange) is the first of them search lists. A
 * search that fails says nothing either way, and the code stands. Null for
 * anything else.
 */
export async function readTerminalCodeArg(
  dataProvider: Pick<DataProvider, "search">,
  typed: string,
): Promise<TerminalListingCode | null> {
  const code = readTerminalListingCode(typed);
  if (!code?.market) return code;
  const us = !code.exchange || isUsListingExchange(code.exchange);
  const verify = us || /\p{Ll}/u.test(code.typed.split(" ")[0]!);
  if (!verify && !code.alternatives) return code;
  const listings: TerminalListing[] = [code, ...code.alternatives ?? []];
  try {
    const searched = new Set<string>();
    for (const { symbol } of listings) {
      if (searched.has(shareClassSymbol(symbol))) continue;
      searched.add(shareClassSymbol(symbol));
      const results = await dataProvider.search(symbol, { limit: LISTING_SEARCH_LIMIT });
      for (const listing of listings) {
        const listed = results.find((result) => shareClassSymbol(result.symbol) === shareClassSymbol(listing.symbol)
          && (us ? isUsListingExchange(listedExchange(result)) : listedExchange(result) === listing.exchange));
        // Abroad, the listing goes by search's own spelling of it, as the venue lists it.
        const symbol = listed && !us ? listed.symbol.toUpperCase() : listing.symbol;
        if (listed) return { ...code, symbol, exchange: listing.exchange, key: listing.exchange ? `${symbol}:${listing.exchange}` : symbol };
      }
    }
    return verify ? null : code;
  } catch (error) {
    if (!isProviderBusy(error)) logFailure("tickers-company-name-listing", "Could not search a terminal code's root")(error);
    return code;
  }
}
