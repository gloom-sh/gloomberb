import { apiClient } from "../../../api-client";
import { companyNameExtraWords, shortCompanyName } from "../../../tickers/company-name";
import { classifyInstrumentKind } from "../../../tickers/search/ranking";
import type { InstrumentSearchResult } from "../../../types/instrument";
import { canonicalExchange } from "../../../utils/exchanges";

/** A company's listing as Gloom Cloud's search marks its primary one. */
export interface FoundListing {
  ticker: string;
  exchange: string | null;
  entityName: string | null;
}

/** The listing of each name asked, null for a name with none that qualifies; rejects when the search could not answer. */
export type ListingFinder = (names: readonly string[], signal?: AbortSignal) => Promise<Map<string, FoundListing | null>>;

/** Rows asked of the search for each name: enough to see every company's primary listing that carries it. */
const SEARCH_LIMIT = 30;

/**
 * Legal forms that say which country's company a name is. The search drops
 * them when it compares names, so "Merck KGaA" reads as "Merck & Co.": a
 * sponsor filed with one of them is only matched to a listing that has it.
 */
const COUNTRY_FORMS = new Set([
  "ag", "kgaa", "gmbh", "kg", "se", "sa", "sas", "sarl", "srl", "spa", "nv", "bv", "ab", "as", "asa", "aps", "oy", "oyj", "plc", "pcl", "bhd", "berhad",
]);

/** Legal forms and titles written out in a listing's name ("Bayer Aktiengesellschaft", "Koninklijke Philips"), which the search reads as words of the name. */
const WRITTEN_FORMS = new Set([
  "aktiengesellschaft", "aktieselskab", "aktiebolag", "naamloze", "vennootschap", "societe", "anonyme", "sociedad", "anonima",
  "kabushiki", "kaisha", "spolka", "akcyjna", "osakeyhtio", "koninklijke",
]);

function wordsOf(name: string): string[] {
  return name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function listedExchange(result: InstrumentSearchResult): string {
  return canonicalExchange(result.exchange === "SMART" ? result.primaryExchange : result.exchange || result.primaryExchange);
}

/** What a sponsor's name is searched as: the name without its legal form, when that is one word; null for any longer name. */
export function sponsorSearchName(sponsor: string): string | null {
  const short = shortCompanyName(sponsor.trim());
  return short && !/\s/.test(short) ? short : null;
}

/**
 * The listing of the company a sponsor's name stands for, from the rows the
 * search gave for `sponsorSearchName`, for a sponsor Gloom Cloud has no
 * reviewed name for (`Bayer` is Bayer AG, BAYN on Xetra). Careful by design,
 * since a wrong ticker beside a sponsor is worse than none:
 * - only a name that is one word once its legal form is dropped is asked;
 * - the listing is a primary listing whose name is that word and nothing
 *   more, apart from legal forms (Bayer AG, but not Evolv Technologies
 *   Holdings for Evolv);
 * - when more than one company's primary listing fits (Siemens), none does;
 * - a sponsor filed under a legal form of its own country (Merck KGaA) never
 *   takes a listing without it.
 * A longer name (a university, a hospital, a start-up with its subsidiary
 * line) is never matched.
 */
export function pickSponsorListing(sponsor: string, rows: readonly InstrumentSearchResult[]): FoundListing | null {
  const short = sponsorSearchName(sponsor);
  if (!short) return null;
  const sponsorForms = wordsOf(sponsor).filter((word) => COUNTRY_FORMS.has(word));
  const fits = rows.filter((row) => {
    if (row.homeListing !== true || classifyInstrumentKind(row.type) !== "equity" || !listedExchange(row)) return false;
    const words = wordsOf(row.name);
    if (sponsorForms.some((form) => !words.includes(form))) return false;
    return companyNameExtraWords(short, row.name) === words.filter((word) => WRITTEN_FORMS.has(word)).length;
  });
  if (fits.length !== 1) return null;
  const [row] = fits;
  return { ticker: row!.symbol.toUpperCase(), exchange: listedExchange(row!), entityName: row!.name };
}

/** One batched search of Gloom Cloud for every sponsor name that can be matched; the rest answer null without a request. */
export const findSponsorListings: ListingFinder = async (sponsors, signal) => {
  const found = new Map<string, FoundListing | null>(sponsors.map((sponsor) => [sponsor, null]));
  const searched = new Map(sponsors.flatMap((sponsor) => {
    const name = sponsorSearchName(sponsor);
    return name ? [[sponsor, name] as const] : [];
  }));
  if (searched.size === 0) return found;
  const answers = await apiClient.searchInstrumentsBatch([...new Set(searched.values())], SEARCH_LIMIT, signal ? { signal } : {});
  for (const [sponsor, name] of searched) found.set(sponsor, pickSponsorListing(sponsor, answers.get(name) ?? []));
  return found;
};
