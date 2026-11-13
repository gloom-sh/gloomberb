import type { PriceHistorySource } from "../../types/financials";

export interface CloudPricePointPayload {
  /** @deprecated No longer read; a history's boundary is its response `coverage`. */
  historySource?: PriceHistorySource;
  date: string;
  open?: number;
  high?: number;
  low?: number;
  close: number;
  volume?: number;
  /**
   * One venue's count for a bar whose market volume is unavailable (a US session still trading, counted on IEX
   * alone), served in place of `volume`.
   */
  venueVolume?: { venue: string; volume: number };
  /** What a coin bar's volume counts: `aggregate` across venues, or `3 spot venues` summed. */
  volumeBasis?: string;
  /** A daily bar still forming when served: a coin's UTC day, or the trade date a future is trading. */
  partial?: boolean;
  /** A coin's daily bar whose prices were rebuilt from hourly bars; a day the source left empty has no volume. */
  filled?: boolean;
  /** A future's closed session whose settlement is not confirmed yet: it closes on the last trade. */
  unsettled?: boolean;
  /** An index session's closing print as its last intraday bar, taken from its daily bar. */
  sessionClose?: boolean;
  /** An index session's last intraday bar, which ends before its close: the closing print was not at hand. */
  beforeClose?: boolean;
  /** A bar the source served in the wrong unit: the factor its prices were multiplied by (10, 100, 0.1); its volume was divided by it. */
  rescaled?: number;
  /** A continuous future's calendar bar: the contract it closes on (NGZ26), where the server knows it. */
  contract?: string;
  /** A currency pair's daily bar: when its close was taken (17:00 New York), as an ISO time, where the server knows it. */
  closedAt?: string;
  /** A currency pair's daily bar whose source repeated its open as its close: the close is the next session's open. */
  closeRebuilt?: boolean;
  /**
   * A currency pair's daily bar whose source repeated its open as its close, which no next open in its week rebuilds
   * (none, or one over 5% away): the close is no day's close.
   */
  closeCopied?: boolean;
}

type CloudMarketStatus =
  | "success"
  | "partial"
  | "empty"
  | "unsupported"
  | "retryable_error"
  | "fatal_error";

/** The dates a history source vouches for. Which boundary fields appear depends on the reason. */
export interface CloudHistoryCoverage {
  source: string;
  reasonCode?: string;
  /** First date (YYYY-MM-DD) whose share lineage the source verified. */
  verifiedLineageStart?: string;
  /** First bar date (YYYY-MM-DD) the source serves, such as a fund's inception. */
  firstAllowedBarDate?: string;
  inceptionDate?: string;
  /** Why nothing earlier is served, such as "old-shekel quotes before 1992 are not served". */
  note?: string;
  sourceUrl?: string;
  firstBarDate: string | null;
  lastBarDate: string | null;
  barCount: number;
}

export interface CloudMarketResponse<T> {
  status: CloudMarketStatus;
  data: T | null;
  reasonCode?: string;
  /** Untrusted, human-readable reason the answer is empty. Cleaned before it is shown. */
  message?: string;
  asOf?: string;
  staleAt?: string;
  stale?: boolean;
  currency?: string;
  /** Untrusted history-only failure evidence, validated by the history adapter. */
  historyRetention?: unknown;
  /** Source-declared history semantics; validated separately from quote metadata. */
  historySession?: unknown;
  /** "extended" when the history includes the pre-market and after-hours bars asked for. */
  session?: unknown;
  /** "1day" when daily bars answer an intraday range: the listing has no intraday bars. */
  servedResolution?: unknown;
  /**
   * Untrusted: daily sessions the bars leave out and why, as
   * `[{ date: "2020-04-20", reason: "non-positive-close" }]`. Validated by the history adapter.
   */
  omittedSessions?: unknown;
  /** Untrusted until the history adapter validates its boundary dates. */
  coverage?: CloudHistoryCoverage;
  /**
   * Untrusted: a US listing that no longer trades, `{ status, lastTradeDate,
   * historyStart }`. Its history ends on `lastTradeDate`. Read by parseListingDelisting.
   */
  delisting?: unknown;
  providerMeta?: {
    provider?: string;
    upstream?: string;
    status?: CloudMarketStatus;
    reasonCode?: string;
    normalizedSymbol?: string;
    normalizedExchange?: string;
    stale?: boolean;
    fallbackReason?: string;
    requestedResolution?: string;
    servedResolution?: string;
    latencyMs?: number;
    range?: string;
    granularity?: string;
    timezone?: string;
    currency?: string;
    barCount?: number;
  };
}

export interface CloudMarketBatchTarget {
  symbol: string;
  exchange?: string;
}

export interface CloudMarketBatchItem<T> {
  symbol: string;
  exchange: string;
  status: CloudMarketStatus;
  data: T | null;
  reasonCode?: string;
  /** Untrusted, human-readable reason this item is empty. Cleaned before it is shown. */
  message?: string;
  stale?: boolean;
}

export interface CloudMarketBatchPayload<T> {
  items: Array<CloudMarketBatchItem<T>>;
}
