import type { ChartRequest, InstrumentRef } from "../market-data/request-types";
import type { QueryEntry } from "../market-data/result-types";
import { sessionCalendarTimeZone } from "../market-data/market/freshness";
import type { PricePoint } from "../types/financials";
import { zonedDateTimeParts } from "../utils/zoned-date-time";

const DAY_MS = 86_400_000;

/** The month now on the venue's calendar: a coin's, and a venue without a known zone's, in UTC. */
export function venueMonth(now: number, exchange: string): { year: number; month: number } {
  const { year, month } = zonedDateTimeParts(now, sessionCalendarTimeZone(exchange) ?? "UTC");
  return { year, month };
}

/**
 * The trailing range of daily closes over `years` (one year or five), read
 * when a source answers no dated history (`calendarMonthReturnsRequest` failed
 * or came back empty). It starts days into the month before the window, so
 * five years of month-end closes give 59 returns, not 60.
 */
export function trailingDailyClosesRequest(instrument: InstrumentRef, years: number): ChartRequest {
  return { instrument, bufferRange: years <= 1 ? "1Y" : "5Y", granularity: "resolution", resolution: "1d" };
}

/**
 * The daily closes `years` × 12 calendar-month returns are read from: from the
 * first day of the month before the window's first month, so every month has
 * the close it is measured from, to the end of the UTC day, so a day keeps one
 * request. The window ends with the last month finished on the venue's
 * calendar. KELLY's History tab, its report and its screenshots ask for it alike.
 */
export function calendarMonthReturnsRequest(instrument: InstrumentRef, years: number, now = Date.now()): ChartRequest {
  const { year, month } = venueMonth(now, instrument.exchange ?? "");
  return {
    ...trailingDailyClosesRequest(instrument, years),
    granularity: "detail",
    barSize: "1d",
    startDate: new Date(Date.UTC(year, month - 1 - (years * 12 + 1), 1)),
    endDate: new Date(Math.floor(now / DAY_MS) * DAY_MS + DAY_MS),
  };
}

/** Whether a dated history read is over and gave no closes, so the trailing range is read instead. */
export function historyReadUnanswered(entry: Pick<QueryEntry<PricePoint[]>, "phase" | "data" | "lastGoodData"> | null | undefined): boolean {
  if (!entry || (entry.phase !== "ready" && entry.phase !== "error")) return false;
  return !(entry.data ?? entry.lastGoodData)?.length;
}
