import type { Quote } from "../types/financials";
import { getCompletedRegularSessionDisplay, type ActiveQuoteDisplay } from "../market-data/market/status";
import { regularSessionValuationTime } from "../market-data/quotes/regular-session-valuation";
import type { ReportTime } from "../utils/utc-time";
import { getPortfolioQuoteDisplay, type PortfolioPositionMetrics } from "./position-metrics";

/**
 * What a portfolio's market value is priced at. `latest-print` (the default,
 * as brokers value a book) takes the last trade, pre-market and after hours
 * included. `regular-close` takes the price Last shows: the regular session's
 * close once it is over, so a value is Last times the shares.
 */
export type PortfolioValuationBasis = "latest-print" | "regular-close";

/** The basis as reports and panes state it, after "Priced at". */
export const VALUATION_BASIS_LABELS: Record<PortfolioValuationBasis, string> = {
  "latest-print": "the latest print, extended hours included",
  "regular-close": "the regular close",
};

/** Whether the regular close values this position: an option keeps its mark on either basis. */
function valuesAtClose(metrics: Pick<PortfolioPositionMetrics, "valuesAtMark"> | null, basis: PortfolioValuationBasis): boolean {
  return basis === "regular-close" && !metrics?.valuesAtMark;
}

/**
 * The price a position is valued at on `basis`. The latest print is
 * getPortfolioQuoteDisplay's. The regular close is the completed regular
 * session's close and its move (getCompletedRegularSessionDisplay), the
 * headline Last and Chg show, and the live price while that session trades.
 */
export function getPortfolioValuationDisplay(
  metrics: PortfolioPositionMetrics,
  quote: Quote | null | undefined,
  basis: PortfolioValuationBasis = "latest-print",
): ActiveQuoteDisplay | null {
  const live = getPortfolioQuoteDisplay(metrics, quote);
  if (!live || !valuesAtClose(metrics, basis)) return live;
  return getCompletedRegularSessionDisplay(quote) ?? live;
}

/**
 * When the price a position is valued at on `basis` is from: the quote's time
 * for a print, the session's close for a regular close
 * (regularSessionValuationTime). Null without a dated quote.
 */
export function getPortfolioValuationTime(
  quote: Quote | null | undefined,
  basis: PortfolioValuationBasis = "latest-print",
  metrics: Pick<PortfolioPositionMetrics, "valuesAtMark"> | null = null,
): ReportTime | null {
  if (!quote) return null;
  if (valuesAtClose(metrics, basis)) return regularSessionValuationTime(quote);
  return Number.isFinite(quote.lastUpdated) && quote.lastUpdated > 0 ? { time: quote.lastUpdated, dateOnly: false } : null;
}

/** A valuation time as exports write it: an ISO instant in UTC, or an ISO date. */
export function valuationTimeIso(time: ReportTime | null): string | null {
  if (!time) return null;
  const iso = new Date(time.time).toISOString();
  return time.dateOnly ? iso.slice(0, 10) : iso;
}
