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
}
