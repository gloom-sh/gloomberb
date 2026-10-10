import type { HeadlessPaneFreshness } from "../../../types/headless";
import type { Quote } from "../../../types/financials";
import { isQuoteStaleForCurrentSession } from "../../../market-data/quotes/freshness";

/**
 * Freshness declarations shared by built-in reports. Each `fn` report ends
 * with the source, as-of and status line these feed; see
 * docs/usage.md#how-current-a-report-is.
 */

/** Analyses over end-of-day history: not a feed, but stale once the closes stop arriving. */
export const DAILY_CLOSES: HeadlessPaneFreshness = { status: "not-a-feed", basis: "daily closes", cadence: "daily" };

const DAY_MINUTES = 24 * 60;

/**
 * Price bars: a history, not a feed, stale once the bars stop arriving for
 * their size. Intraday and daily bars follow the US trading sessions; a
 * weekly or monthly bar is dated by the start of its period.
 */
export function barHistoryFreshness(resolution: string | null | undefined): HeadlessPaneFreshness {
  if (resolution === "1wk") return { status: "not-a-feed", basis: "weekly bars", maxAgeMinutes: 14 * DAY_MINUTES };
  if (resolution === "1mo") return { status: "not-a-feed", basis: "monthly bars", maxAgeMinutes: 45 * DAY_MINUTES };
  if (resolution === "1d") return DAILY_CLOSES;
  return { status: "not-a-feed", basis: "intraday bars", cadence: "daily" };
}

/** The bar size of a dated history, read from the gap between its last two bars. */
export function barResolutionFromDates(dates: readonly (string | number | Date)[]): "1d" | "1wk" | "1mo" {
  const times = dates.slice(-2).map((date) => new Date(date).getTime());
  const gapDays = times.length === 2 && times.every(Number.isFinite) ? (times[1]! - times[0]!) / 86_400_000 : 1;
  return gapDays >= 25 ? "1mo" : gapDays >= 6 ? "1wk" : "1d";
}

/** Company filings read from EDGAR. Old filings are not stale; there is no schedule to miss. */
export const SEC_FILINGS: HeadlessPaneFreshness = { source: "SEC EDGAR", status: "not-a-feed", basis: "filed data", oldest: null };

/** Places and listings that change only when someone edits them: venues, ports, pipelines. */
export const REFERENCE_DATA: HeadlessPaneFreshness = { status: "not-a-feed", basis: "reference data", oldest: null };

/** Company fundamentals, estimates and calendars: reported figures, not a feed. */
export const REPORTED_DATA: HeadlessPaneFreshness = { status: "not-a-feed", basis: "reported data" };

/**
 * The standard freshness fields of one quote, spread into a report row so the
 * report can say whether that row is live, delayed or stale for its session.
 */
export function quoteFreshnessFields(
  quote: Quote | null | undefined,
  now = Date.now(),
): { dataSource?: "live" | "delayed"; stale?: boolean } {
  if (!quote) return {};
  return {
    ...(quote.dataSource === "live" || quote.dataSource === "delayed" ? { dataSource: quote.dataSource } : {}),
    stale: isQuoteStaleForCurrentSession(quote, now),
  };
}
