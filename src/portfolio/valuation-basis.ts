import type { Quote } from "../types/financials";
import { getCompletedRegularSessionDisplay, type ActiveQuoteDisplay } from "../market-data/market/status";
import { regularSessionValuationTime } from "../market-data/quotes/regular-session-valuation";
import type { ReportTime } from "../utils/utc-time";
import { futuresSettlementDisplay, type FuturesSettlement } from "./futures-positions";
import { getPortfolioQuoteDisplay, type PortfolioPositionMetrics } from "./position-metrics";

/**
 * What a portfolio's market value is priced at. `latest-print` (the default,
 * as brokers value a book) takes the last trade, pre-market and after hours
 * included. `regular-close` takes the price Last shows: the regular session's
 * close once it is over, so a value is Last times the shares. A future has no
 * regular close but its exchange settlement, which `quote` gives as Settle:
 * on that basis it is valued there, dated by its session.
 */
export type PortfolioValuationBasis = "latest-print" | "regular-close";

/** The basis as reports and panes state it, after "Priced at". */
export const VALUATION_BASIS_LABELS: Record<PortfolioValuationBasis, string> = {
  "latest-print": "the latest print, extended hours included",
  "regular-close": "the regular close",
};

/** The basis as a book holding futures states it: at the close, they are priced at their settlement. */
export function valuationBasisLabel(basis: PortfolioValuationBasis, { futures = false }: { futures?: boolean } = {}): string {
  return basis === "regular-close" && futures ? `${VALUATION_BASIS_LABELS[basis]}, futures at the settle` : VALUATION_BASIS_LABELS[basis];
}

/** Whether the regular close values this position: an option keeps its mark on either basis. */
function valuesAtClose(metrics: Pick<PortfolioPositionMetrics, "valuesAtMark"> | null, basis: PortfolioValuationBasis): boolean {
  return basis === "regular-close" && !metrics?.valuesAtMark;
}

/** Whether a position is valued at its exchange settlement on `basis`: a future at the close. */
export function valuesAtSettlement(metrics: Pick<PortfolioPositionMetrics, "isFuture"> | null, basis: PortfolioValuationBasis): boolean {
  return basis === "regular-close" && !!metrics?.isFuture;
}

/**
 * The price a position is valued at on `basis`. The latest print is
 * getPortfolioQuoteDisplay's. The regular close is the completed regular
 * session's close and its move (getCompletedRegularSessionDisplay), the
 * headline Last and Chg show, and the live price while that session trades.
 * A future at the close is its settlement and the move from the one before;
 * without a confirmed settlement it has no price on that basis, never the
 * Globex print in its place.
 */
export function getPortfolioValuationDisplay(
  metrics: PortfolioPositionMetrics,
  quote: Quote | null | undefined,
  basis: PortfolioValuationBasis = "latest-print",
  settlement?: FuturesSettlement | null,
): ActiveQuoteDisplay | null {
  if (valuesAtSettlement(metrics, basis)) {
    return settlement && (metrics.positionCount === 0 || metrics.pnlLots.some((lot) => Number.isFinite(lot.priceUnits)))
      ? futuresSettlementDisplay(settlement) : null;
  }
  const live = getPortfolioQuoteDisplay(metrics, quote);
  if (!live || !valuesAtClose(metrics, basis)) return live;
  return getCompletedRegularSessionDisplay(quote) ?? live;
}

/**
 * When the price a position is valued at on `basis` is from: the quote's time
 * for a print, the session's close for a regular close
 * (regularSessionValuationTime), and a future's settlement session at the
 * close. Null without a dated quote or settlement.
 */
export function getPortfolioValuationTime(
  quote: Quote | null | undefined,
  basis: PortfolioValuationBasis = "latest-print",
  metrics: Pick<PortfolioPositionMetrics, "valuesAtMark" | "isFuture"> | null = null,
  settlement?: Pick<FuturesSettlement, "date"> | null,
): ReportTime | null {
  if (valuesAtSettlement(metrics, basis)) {
    const day = settlement ? Date.parse(`${settlement.date}T00:00:00Z`) : Number.NaN;
    return Number.isFinite(day) ? { time: day, dateOnly: true } : null;
  }
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
