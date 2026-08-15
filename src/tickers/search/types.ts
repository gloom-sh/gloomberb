import type { InstrumentSearchResult } from "../../types/instrument";
import type { TickerRecord } from "../../types/ticker";

export type TickerSearchInstrumentClass = "equity" | "fund" | "derivative" | "other";
type TickerSearchCategory = "Saved" | "Primary Listing" | "Other Listings" | "Funds & Derivatives";

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
  exchangeLabel?: string;
  primaryExchangeLabel?: string;
  providerRank?: number;
  searchAliases?: string[];
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
  | { kind: "provider"; symbol: string; result: InstrumentSearchResult };

export interface TickerOpenTarget {
  symbol: string;
  ticker: TickerRecord;
  created: boolean;
}
