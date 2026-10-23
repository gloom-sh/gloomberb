import type { QuoteIntradayBar } from "./financials";

/** Quote currency units per one base-currency unit; conversion rates use USD. */
export interface ExchangeRateSnapshot {
  fromCurrency: string;
  toCurrency: "USD";
  rate: number;
  source: string;
  /** Provider observation time, independent of retrieval/cache age. */
  asOf?: string;
  fetchedAt: string;
  staleAt?: string;
  stale: boolean;
  delayMinutes?: number;
  /** The rate is the close of this intraday bar of the pair's, its print having stopped behind it; asOf is the bar's end. */
  intradayBar?: QuoteIntradayBar;
  /** Why a stale rate stands, in Gloom Cloud's words. */
  staleReason?: string;
}
