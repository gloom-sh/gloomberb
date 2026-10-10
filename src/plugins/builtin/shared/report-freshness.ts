import type { HeadlessPaneFreshness } from "../../../types/headless";
import type { Quote } from "../../../types/financials";
import { isQuoteStaleForCurrentSession } from "../../../market-data/quotes/freshness";
import { delayedFeedLagMs } from "../../../market-data/market/freshness";
import { apiClient } from "../../../api-client";
import { CLOUD_NEWS_DELAY_HOURS, hasProAccess } from "../../../api-client/plan-rules";

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

/** Gloom Cloud's delayed quotes run behind each venue by a lag the app knows (`delayedFeedLagMs`). */
const CLOUD_QUOTE_PROVIDER_ID = "gloomberb-cloud";

interface QuoteFreshnessFields {
  dataSource?: "live" | "delayed";
  stale?: boolean;
  /** How far a delayed Gloom Cloud quote runs behind its venue's trades. */
  delayMinutes?: number;
  /** The venue whose sessions the quote follows, so the report can say whether its market is open. */
  sessionExchange?: string;
  marketState?: Quote["marketState"];
}

/**
 * The standard freshness fields of one quote, spread into a report row so the
 * report can say whether that row is live, delayed (and by how much) or stale
 * for its session, and where its market stands.
 */
export function quoteFreshnessFields(
  quote: Quote | null | undefined,
  now = Date.now(),
): QuoteFreshnessFields {
  if (!quote) return {};
  const exchange = quote.listingExchangeName || quote.exchangeName;
  const delayed = quote.dataSource === "delayed" && quote.providerId === CLOUD_QUOTE_PROVIDER_ID;
  return {
    ...(quote.dataSource === "live" || quote.dataSource === "delayed" ? { dataSource: quote.dataSource } : {}),
    stale: isQuoteStaleForCurrentSession(quote, now),
    ...(delayed ? { delayMinutes: delayedFeedLagMs(exchange) / 60_000 } : {}),
    ...(exchange ? { sessionExchange: exchange } : {}),
    ...(quote.marketState ? { marketState: quote.marketState } : {}),
  };
}

/**
 * Whether the Gloom Cloud session a report reads with has real-time access:
 * no session reads as a free account; a session is asked for its plan. Null
 * when the plan cannot be read, so the report does not guess a delay.
 */
export async function cloudRealtimeAccess(): Promise<boolean | null> {
  if (!apiClient.isSignedIn()) return false;
  try {
    return hasProAccess(apiClient.getCurrentUser() ?? await apiClient.getSession());
  } catch {
    return null;
  }
}

/**
 * Gloom Cloud news stories, dated by the newest: held back
 * `CLOUD_NEWS_DELAY_HOURS` without real-time access, the live wire with it.
 * The list is a history, so its last story is not stale data.
 */
export function cloudNewsFreshness(realtime: boolean | null): HeadlessPaneFreshness {
  const stories: HeadlessPaneFreshness = { observedKey: "publishedAt", oldest: null };
  if (realtime === true) return { ...stories, status: "live" };
  if (realtime === false) return { ...stories, status: "delayed", delayMinutes: CLOUD_NEWS_DELAY_HOURS * 60 };
  return { ...stories, status: "not-a-feed", basis: "published stories" };
}
