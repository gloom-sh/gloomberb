import type { HeadlessPaneFreshness } from "../../../types/headless";
import type { Quote, QuoteIndexSession } from "../../../types/financials";
import { isQuoteBeforeLatestSession, isQuoteStaleForCurrentSession } from "../../../market-data/quotes/freshness";
import { delayedFeedLagMs, readIndexSession } from "../../../market-data/market/freshness";
import { quoteHeadlineTime } from "../../../market-data/market/status";
import { barSizeFromGap, medianBarGap } from "../../../time-series/bar-spacing";
import { apiClient } from "../../../api-client";
import { isPerpetualExchange } from "../../../tickers/perpetual-listing";
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
 * weekly or monthly bar is dated by the start of its period. Their
 * screenshot is dated by the listing's quote (`prices`).
 */
export function barHistoryFreshness(resolution: string | null | undefined): HeadlessPaneFreshness {
  if (resolution === "1wk") return { status: "not-a-feed", basis: "weekly bars", maxAgeMinutes: 14 * DAY_MINUTES, prices: true };
  if (resolution === "1mo") return { status: "not-a-feed", basis: "monthly bars", maxAgeMinutes: 45 * DAY_MINUTES, prices: true };
  if (resolution === "1d") return { ...DAILY_CLOSES, prices: true };
  return { status: "not-a-feed", basis: "intraday bars", cadence: "daily", prices: true };
}

/**
 * The bar size of a dated history, read from the typical gap between its bars
 * (medianBarGap), as `history` reads it, so a holiday's gap before the last
 * daily bar does not make them weekly. Daily when there is no gap to read.
 */
export function barResolutionFromDates(dates: readonly (string | number | Date)[]): "1d" | "1wk" | "1mo" {
  const gap = medianBarGap(dates.map((date) => new Date(date).getTime()));
  return gap == null ? "1d" : barSizeFromGap(gap);
}

/** Company filings read from EDGAR. Old filings are not stale; there is no schedule to miss. */
export const SEC_FILINGS: HeadlessPaneFreshness = { source: "SEC EDGAR", status: "not-a-feed", basis: "filed data", oldest: null };

/**
 * What a filings view opened inside a pane that hosts others (Issuer Debt in
 * Fixed Income) declares as its template's `reportFreshness`, so a capture
 * dates the filings rather than the issuer's stock quote.
 */
export const SEC_FILINGS_VIEW: Pick<HeadlessPaneFreshness, "source" | "status" | "basis"> = {
  source: "SEC EDGAR",
  status: "not-a-feed",
  basis: "filed data",
};

/** Places and listings that change only when someone edits them: venues, ports, pipelines. */
export const REFERENCE_DATA: HeadlessPaneFreshness = { status: "not-a-feed", basis: "reference data", oldest: null };

/** Company fundamentals, estimates and calendars: reported figures, not a feed. */
export const REPORTED_DATA: HeadlessPaneFreshness = { status: "not-a-feed", basis: "reported data" };

/** What a news list's as-of is: its newest story, not the time it was read. */
export const NEWEST_STORY = "newest story";

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
  /** An index's own regular sessions, for the open and the close its publisher's name does not place. */
  sessionCalendar?: QuoteIndexSession;
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
  // A perpetual's venue is read about once a minute, not held back by a feed lag.
  const delayed = quote.dataSource === "delayed" && quote.providerId === CLOUD_QUOTE_PROVIDER_ID && !isPerpetualExchange(exchange);
  const sessionCalendar = readIndexSession(quote.indexSession);
  // A print older than its venue's latest session says nothing of where that market stands now (no "markets open" beside it).
  const session = !isQuoteBeforeLatestSession(quote, now);
  return {
    ...(quote.dataSource === "live" || quote.dataSource === "delayed" ? { dataSource: quote.dataSource } : {}),
    stale: isQuoteStaleForCurrentSession(quote, now),
    ...(delayed ? { delayMinutes: delayedFeedLagMs(exchange) / 60_000 } : {}),
    ...(exchange && session ? { sessionExchange: exchange } : {}),
    ...(quote.marketState && session ? { marketState: quote.marketState } : {}),
    ...(sessionCalendar && session ? { sessionCalendar } : {}),
  };
}

/**
 * One quote as a report reads it among the observations behind a view: its
 * freshness fields and when the price it headlines was observed
 * (quoteHeadlineTime: in a pre-market nothing has traded in, the close it
 * stands at). A board publishes one per quote it shows, so `fn` and `shot`
 * date it as `quote` dates the same quotes.
 */
export function quoteObservation(quote: Quote, now = Date.now()): QuoteFreshnessFields & { updatedAt: number } {
  return { ...quoteFreshnessFields(quote, now), updatedAt: quoteHeadlineTime(quote) };
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
 * Gloom Cloud news stories, dated by the newest, which the line names
 * (`newest story Tue 29 Sep 2026 20:17 UTC`) so it is not read as the time
 * now: held back `CLOUD_NEWS_DELAY_HOURS` without real-time access, the live
 * wire with it. The list is a history, so its last story is not stale data.
 */
export function cloudNewsFreshness(realtime: boolean | null): HeadlessPaneFreshness {
  const stories: HeadlessPaneFreshness = { observedKey: "publishedAt", oldest: null, asOfLabel: NEWEST_STORY };
  if (realtime === true) return { ...stories, status: "live" };
  if (realtime === false) return { ...stories, status: "delayed", delayMinutes: CLOUD_NEWS_DELAY_HOURS * 60 };
  return { ...stories, status: "not-a-feed", basis: "published stories" };
}
