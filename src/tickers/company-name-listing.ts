import type { DataProvider } from "../types/data-provider";
import type { InstrumentSearchResult } from "../types/instrument";
import { canonicalExchange, isUsListingExchange, parsePublicTickerKey } from "../utils/exchanges";
import { companyNameExtraWords, shortCompanyName } from "./company-name";
import { LISTING_SEARCH_LIMIT } from "./search";
import { classifyInstrumentKind } from "./search/ranking";

export interface CompanyNameListing {
  symbol: string;
  /** Canonical code of its exchange. */
  exchange: string;
  /** The listing's name as search gives it. */
  name: string;
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
 * NYSE). Of search's listings whose names have every word of it (the name is
 * also searched without its legal form, which can find more), the company
 * whose name says no more than the one typed goes first, so a subsidiary that
 * shares the word (Whirlpool of India) does not; then its line on a US
 * exchange, then a plain line before a depositary receipt, the shortest
 * symbol (WHR before WHR-A) and search's order. Contracts, preferred shares
 * and notes are never the listing. Null when none matches.
 */
export async function findListingOfCompanyName(
  dataProvider: Pick<DataProvider, "search">,
  typed: string,
): Promise<CompanyNameListing | null> {
  const name = typed.trim();
  if (!name) return null;
  const queries = [...new Set([name, shortCompanyName(name)])].filter(Boolean);
  const results = (await Promise.all(queries.map((query) => dataProvider.search(query, { limit: LISTING_SEARCH_LIMIT })
    .catch((): InstrumentSearchResult[] => [])))).flat();
  const ranked = results.flatMap((result, order) => {
    const exchange = canonicalExchange(result.exchange === "SMART" ? result.primaryExchange : result.exchange || result.primaryExchange);
    const type = result.brokerContract?.secType || result.type || "";
    const extra = companyNameExtraWords(name, result.name);
    if (!exchange || extra == null || classifyInstrumentKind(type) === "derivative" || NOT_COMMON.test(type)
      || parsePublicTickerKey(result.symbol).exchange) return [];
    return [{ result, exchange, rank: [extra, isUsListingExchange(exchange) ? 0 : 1, RECEIPT.test(type) ? 1 : 0, result.symbol.length, order] }];
  }).sort((left, right) => {
    const at = left.rank.findIndex((value, index) => value !== right.rank[index]);
    return at < 0 ? 0 : left.rank[at]! - right.rank[at]!;
  });
  const best = ranked[0];
  return best ? { symbol: best.result.symbol.toUpperCase(), exchange: best.exchange, name: best.result.name } : null;
}
