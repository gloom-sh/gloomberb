/**
 * What a ticker is, at the grain that decides which research has data for it:
 * filings, executives and analyst coverage exist for a company's stock,
 * distributions and 13F ownership for funds too, and none of them for a coin,
 * a currency pair or an index.
 */
export type TickerInstrumentKind =
  | "equity"
  | "fund"
  | "crypto"
  | "currency"
  | "index"
  | "future"
  | "option"
  | "bond"
  | "other";

/** Source price convention. Percent-of-par quantities are nominal face amounts;
 * prices are percentage points per 100 face, independently of contract multiplier. */
export type PriceBasis = "per-unit" | "percent-of-par";

export interface BrokerContractRef {
  brokerId: string;
  brokerInstanceId?: string;
  conId?: number;
  symbol: string;
  localSymbol?: string;
  secType?: string;
  exchange?: string;
  primaryExchange?: string;
  currency?: string;
  lastTradeDateOrContractMonth?: string;
  right?: "C" | "P";
  strike?: number;
  multiplier?: string;
  tradingClass?: string;
}

/** Public listing metadata supplied by a selected search result. */
export interface TickerListingRef {
  name: string;
  exchange: string;
  currency?: string;
  type: string;
}

export interface InstrumentSearchResult {
  providerId: string;
  brokerInstanceId?: string;
  brokerLabel?: string;
  symbol: string;
  name: string;
  exchange: string;
  type: string;
  currency?: string;
  primaryExchange?: string;
  brokerContract?: BrokerContractRef;
  /** How often the listing is searched, higher is more (Yahoo's search score,
   * sent by newer cloud servers). Only comparable within one response. */
  popularity?: number;
}
