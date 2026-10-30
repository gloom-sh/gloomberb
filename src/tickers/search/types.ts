import type { BrokerContractRef, InstrumentSearchResult, TickerListingRef } from "../../types/instrument";
import type { Quote } from "../../types/financials";
import type { TickerRecord } from "../../types/ticker";

export type TickerSearchInstrumentClass = "equity" | "fund" | "derivative" | "other";
/**
 * `Other Matches`: rows `gloom search` finds for the query that are not a listing
 * of the primary listing's company (another company's DK, a line search names
 * no company for), kept apart from its Other Listings.
 */
type TickerSearchCategory = "Saved" | "Primary Listing" | "Other Listings" | "Other Matches" | "Funds & Derivatives" | "Related";

export interface TickerSearchRankableItem {
  id: string;
  label: string;
  detail: string;
  kind: string;
  category: string;
  right?: string;
  symbol?: string;
  saved?: boolean;
  instrumentClass?: TickerSearchInstrumentClass;
  instrumentType?: string;
  contractKey?: string;
  exchangeLabel?: string;
  primaryExchangeLabel?: string;
  providerRank?: number;
  popularity?: number;
  searchAliases?: string[];
  /**
   * The names the service sent the row for (`InstrumentSearchResult.searchAliases`: a trade name, or the name a
   * renamed company had), apart from the symbol spellings `searchAliases` also holds.
   */
  nameAliases?: string[];
  /** Themes the row answers to that its name does not say (`InstrumentSearchResult.searchKeywords`). */
  searchKeywords?: string[];
}

export interface TickerSearchCandidate extends TickerSearchRankableItem {
  category: TickerSearchCategory;
  kind: "ticker" | "search";
  symbol: string;
  saved: boolean;
  instrumentClass: TickerSearchInstrumentClass;
  searchAliases: string[];
  ticker?: TickerRecord;
  result?: InstrumentSearchResult;
}

export type ResolvedTickerSearch =
  | { kind: "local"; symbol: string; ticker: TickerRecord }
  | {
    kind: "provider";
    symbol: string;
    result: InstrumentSearchResult;
    /** A bare symbol's other listings (SYM:EXCH) when its quote chose one of several. */
    otherListings?: string[];
    /** The quote that vouched for a listing search does not carry, so the caller need not ask again. */
    quote?: Quote;
  };

export interface TickerOpenTarget {
  symbol: string;
  ticker: TickerRecord;
  created: boolean;
  instrument?: BrokerContractRef | null;
  listing?: TickerListingRef;
}
