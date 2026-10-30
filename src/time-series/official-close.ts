import type { PricePoint, Quote } from "../types/financials";
import { latestRegularSessionClose, sessionCalendarTimeZone } from "../market-data/market/freshness";
import { getRegularSessionBarClose } from "../market-data/market/status";
import { quoteTradingDay } from "../market-data/quotes/day-range";
import { zonedDateKey, zonedWallClockToUtcMs } from "../utils/zoned-date-time";

/** What the footer of an intraday total says while a session has closed but its closing print is not in yet. */
export const CLOSING_PRINT_PENDING_TEXT = "closing print not in yet";

function barTime(point: Pick<PricePoint, "date">): number {
  return new Date(point.date as Date | string | number).getTime();
}

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * The official close of the regular session a quote last completed, by the
 * venue's local date: what the closing auction printed, once the quote has it.
 * Null while that session still trades, or when the quote cannot say which
 * session its close is from.
 */
export function quoteOfficialClose(quote: Quote | null | undefined): { date: string; close: number } | null {
  if (!quote || quote.marketState == null || quote.marketState === "REGULAR") return null;
  const session = getRegularSessionBarClose(quote);
  const date = session?.sessionDate ?? (quote.marketState === "POST" ? quoteTradingDay(quote) : null);
  return session && date && positive(session.price) ? { date, close: session.price } : null;
}

export interface OfficialCloseResult {
  points: PricePoint[];
  /**
   * The local date of the newest session, when it has closed but no official
   * close was given for it: its last bar still ends on the last trade before
   * the closing auction.
   */
  pending: string | null;
}

/**
 * Intraday bars of a listing that trades in sessions, each closed session's
 * last regular bar closing on that session's official close (`closes`, by
 * the venue's local date) instead of the last trade before the closing
 * auction: an hourly 19:30 UTC bar of a thin ETF ends on a 19:38 trade at
 * 12.31 while the 20:00 closing print is 12.19, which every total measured
 * from the bars then misses. The bar's high and low widen to take the close.
 *
 * A session still trading, bars after its close (after-hours) and venues
 * without sessions are left as served; the points array is the same one when
 * nothing changed.
 */
export function withOfficialCloses(
  points: PricePoint[],
  closes: ReadonlyMap<string, number>,
  options: { venue: string | undefined; now: number },
): OfficialCloseResult {
  const zone = sessionCalendarTimeZone(options.venue);
  const latest = latestRegularSessionClose(options.venue, options.now);
  if (!zone || !latest || points.length === 0) return { points, pending: null };
  // When each local date's session closed: the latest close by the end of that date, when it is that date's.
  const sessionCloses = new Map<string, number | null>();
  const sessionClose = (date: string) => {
    if (!sessionCloses.has(date)) {
      const [year, month, day] = date.split("-").map(Number) as [number, number, number];
      const close = latestRegularSessionClose(options.venue, zonedWallClockToUtcMs(zone, year, month, day, 23, 59, 59));
      sessionCloses.set(date, close?.date === date ? close.close : null);
    }
    return sessionCloses.get(date)!;
  };
  // The last bar each closed session opened before its close; a later one is after-hours.
  const lastOfSession = new Map<string, number>();
  points.forEach((point, index) => {
    const time = barTime(point);
    if (!Number.isFinite(time)) return;
    const date = zonedDateKey(time, zone);
    if (date > latest.date) return;
    const close = sessionClose(date);
    if (close === null || time >= close) return;
    lastOfSession.set(date, index);
  });
  let changed = false;
  const next = points.slice();
  for (const [date, index] of lastOfSession) {
    const close = closes.get(date);
    if (!positive(close)) continue;
    const bar = next[index]!;
    if (bar.close === close) continue;
    next[index] = {
      ...bar,
      close,
      ...(positive(bar.high) ? { high: Math.max(bar.high, close) } : {}),
      ...(positive(bar.low) ? { low: Math.min(bar.low, close) } : {}),
    };
    changed = true;
  }
  const newest = points.at(-1);
  const newestDate = newest && Number.isFinite(barTime(newest)) ? zonedDateKey(barTime(newest), zone) : null;
  const pending = newestDate === latest.date && lastOfSession.has(newestDate) && !positive(closes.get(newestDate)) ? newestDate : null;
  return { points: changed ? next : points, pending };
}
