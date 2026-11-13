import { MISSING_VALUE } from "../../utils/format";
import type { Quote } from "../../types/financials";
import { getLanguage, tf } from "../../i18n";
import { isPerpetualExchange } from "../../tickers/perpetual-listing";
import { formatUtcDayTime, formatUtcWeekdayTime } from "../../utils/utc-time";
import { formatShortDate } from "../../utils/datetime-format";
import { delayedFeedLagMs } from "../market/freshness";
import { quoteHeadlineTime, quoteSessionStateLabel } from "../market/status";
import { dailyNavDate, isQuoteStaleForCurrentSession } from "./freshness";

/** The published NAV session date, independent of local time and receipt time. */
export function formatQuoteNavAsOf(quote: Quote | null | undefined, now = Date.now()): string | null {
  const date = quote && dailyNavDate(quote, now);
  if (!date) return null;
  const sourceDate = new Date(`${date}T00:00:00Z`);
  const otherYear = sourceDate.getUTCFullYear() !== new Date(now).getUTCFullYear();
  // English reads the day first, as every other date does; another language writes the day its own way.
  const language = getLanguage();
  const dateText = language === "en"
    ? formatShortDate(sourceDate, { utc: true, year: otherYear ? "numeric" : false })
    : new Intl.DateTimeFormat(language, {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      ...(otherYear ? { year: "numeric" as const } : {}),
    }).format(sourceDate);
  return tf("NAV · as of {date}", { date: dateText });
}

const CLOUD_PROVIDER_ID = "gloomberb-cloud";
const WEEK_MS = 7 * 86_400_000;

/** How current a quote's feed is: `15 min delayed` (Gloom Cloud knows each venue's lag), `delayed`, `real-time`. */
function quoteFeedWord(quote: Quote): string | null {
  if (quote.dataSource === "live") return "real-time";
  if (quote.dataSource !== "delayed") return null;
  const exchange = quote.listingExchangeName || quote.exchangeName;
  // A perpetual's venue is read about once a minute, not held back by a feed lag.
  if (quote.providerId !== CLOUD_PROVIDER_ID || isPerpetualExchange(exchange)) return "delayed";
  return `${Math.round(delayedFeedLagMs(exchange) / 60_000)} min delayed`;
}

/** `08:09 UTC` on today's UTC date, `Thu 08:09 UTC` within the week, `Thu 29 Oct 08:09 UTC` before it. */
function asOfClock(time: number, now: number): string {
  const iso = new Date(time).toISOString();
  if (iso.slice(0, 10) === new Date(now).toISOString().slice(0, 10)) return `${iso.slice(11, 16)} UTC`;
  return `${now - time < WEEK_MS ? formatUtcWeekdayTime(time) : formatUtcDayTime({ time, dateOnly: false }, now)} UTC`;
}

/**
 * What a quote card's price is as of: CLOSED while its market is, else how
 * current its feed is, and when the price was observed (quoteHeadlineTime,
 * as an export's as_of dates it): `CLOSED · 08:09 UTC` for Hong Kong's close
 * beside `15 min delayed · 21:20 UTC` for New York's after hours. Null for a
 * fund priced by its NAV (formatQuoteNavAsOf dates it), a listing that no
 * longer trades and a quote stale for its session, whose own status says so.
 */
export function formatQuoteSessionAsOf(quote: Quote | null | undefined, now = Date.now()): string | null {
  if (!quote || quote.delisting || !(quote.lastUpdated > 0) || dailyNavDate(quote, now)) return null;
  if (isQuoteStaleForCurrentSession(quote, now)) return null;
  const session = quoteSessionStateLabel(quote, now);
  const state = session === "CLOSED" ? session : quoteFeedWord(quote) ?? session;
  const clock = asOfClock(Math.min(quoteHeadlineTime(quote), now), now);
  return state ? `${state} · ${clock}` : clock;
}

function clampQuoteTimestamp(lastUpdated: number | undefined, now = Date.now()): number | null {
  if (typeof lastUpdated !== "number" || !Number.isFinite(lastUpdated) || lastUpdated <= 0) {
    return null;
  }
  return Math.min(lastUpdated, now);
}

export interface QuoteAgeFormatOptions {
  /** Whole seconds only, for a surface whose clock ticks once a second:
   * milliseconds from that clock would be up to a second out. */
  seconds?: boolean;
}

export function formatQuoteAge(lastUpdated: number | undefined, now = Date.now(), options: QuoteAgeFormatOptions = {}): string {
  const clamped = clampQuoteTimestamp(lastUpdated, now);
  if (clamped == null) return MISSING_VALUE;

  // A receipt or source time ahead of the clock is fresh, never negative.
  const ageMs = Math.max(0, now - clamped);
  if (ageMs < 1000) return options.seconds ? "0s" : `${Math.floor(ageMs)}ms`;

  const ageSeconds = ageMs / 1000;
  if (ageSeconds < 60) return `${Math.floor(ageSeconds)}s`;
  if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m`;
  if (ageSeconds < 86400) return `${Math.floor(ageSeconds / 3600)}h`;
  return `${Math.floor(ageSeconds / 86400)}d`;
}

export function resolveQuoteAgeTimestamp(
  quote: Pick<Quote, "lastUpdated" | "receivedAt"> | null | undefined,
  now = Date.now(),
): number | null {
  if (!quote) return null;
  const receivedAt = clampQuoteTimestamp(quote.receivedAt, now);
  return receivedAt ?? clampQuoteTimestamp(quote.lastUpdated, now);
}

export function formatQuoteAgeWithSource(
  quote: Pick<Quote, "lastUpdated" | "receivedAt" | "dataSource"> | null | undefined,
  now = Date.now(),
  options: QuoteAgeFormatOptions = {},
): string {
  if (!quote) return MISSING_VALUE;

  const timestamp = resolveQuoteAgeTimestamp(quote, now);
  const age = timestamp == null ? MISSING_VALUE : formatQuoteAge(timestamp, now, options);
  if (age === MISSING_VALUE) return age;

  const prefix = quote.dataSource === "delayed" ? "◷" : "";
  return prefix ? `${prefix}${age}` : age;
}
