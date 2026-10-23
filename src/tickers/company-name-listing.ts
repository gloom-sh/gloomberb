import { logFailure } from "../utils/log-failure";
import type { DataProvider } from "../types/data-provider";
import type { InstrumentSearchResult } from "../types/instrument";
import { canonicalExchange, isUsListingExchange, parsePublicTickerKey } from "../utils/exchanges";
import { companyNameMatch, shortCompanyName } from "./company-name";
import { LISTING_SEARCH_LIMIT } from "./search";
import { classifyInstrumentKind } from "./search/ranking";
import { isProviderBusy, type ProviderBusyError } from "../sources/provider-errors";
import { readTerminalListingCode, type TerminalListing, type TerminalListingCode } from "./terminal-codes";

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
 * word for word before one a short form matched; then its line on a US
 * exchange, then a plain line before a depositary receipt, then a
 * company's common stock before a fund or an index named alike, the
 * shortest symbol (WHR before WHR-A) and search's order. The row the service
 * marks with the name as typed (`searchAliases`: JPM for "JP Morgan") is
 * named by it exactly. Contracts, preferred shares and notes are never the
 * listing. With `meant`, a fund or an index found for a name its company's
 * stock says run together ("JP Morgan" for JPMorgan Chase & Co.) names that
 * stock as `meant`, searched under the run-together name when the answer
 * lacks it. Null when none matches; when none does because search was too
 * busy to answer, `ProviderBusyError`.
 */
export async function findListingOfCompanyName(
  dataProvider: Pick<DataProvider, "search">,
  typed: string,
  options: { meant?: boolean } = {},
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
    const match = companyNameMatch(name, result.name) ?? (namedByService(name, result) ? { extra: 0, abbreviated: 0 } : null);
    if (!exchange || match == null || classifyInstrumentKind(type) === "derivative" || NOT_COMMON.test(type)
      || parsePublicTickerKey(result.symbol).exchange) return [];
    const stock = classifyInstrumentKind(type) === "equity" ? 0 : 1;
    return [{ result, exchange, stock, rank: [match.extra, match.abbreviated, isUsListingExchange(exchange) ? 0 : 1, RECEIPT.test(type) ? 1 : 0, stock, result.symbol.length, order] }];
  }).sort((left, right) => {
    const at = left.rank.findIndex((value, index) => value !== right.rank[index]);
    return at < 0 ? 0 : left.rank[at]! - right.rank[at]!;
  });
  const best = ranked[0];
  if (!best && busy) throw busy;
  if (!best) return null;
  const found = { symbol: best.result.symbol.toUpperCase(), exchange: best.exchange, name: best.result.name };
  const meant = best.stock && options.meant ? await stockNamedRunTogether(dataProvider, name, results) : null;
  return meant ? { ...found, meant } : found;
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
