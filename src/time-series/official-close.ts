import type { PricePoint, Quote } from "../types/financials";
import { latestRegularSessionClose, regularSessionCloseOn, sessionCalendarTimeZone } from "../market-data/market/freshness";
import { quoteTradingDay } from "../market-data/quotes/day-range";
import { hasLikelyQuoteUnitMismatch } from "../utils/currency-units";
import { canonicalExchange, isUsListingExchange } from "../utils/exchanges";
import { zonedDateKey } from "../utils/zoned-date-time";

/** What the footer of an intraday total says while a session has closed but its closing print is not in yet. */
export const CLOSING_PRINT_PENDING_TEXT = "closing print not in yet";

/** A close this far from the session's last trade is another listing's or another unit's, never its auction print. */
const MAX_CLOSE_MOVE = 0.25;

function barTime(point: Pick<PricePoint, "date">): number {
  return new Date(point.date as Date | string | number).getTime();
}

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** Whether `close` can be the close of a session whose last trade was `lastTrade`. */
function nearLastTrade(close: number, lastTrade: number | null): boolean {
  return lastTrade === null || !positive(lastTrade) || Math.abs(close / lastTrade - 1) <= MAX_CLOSE_MOVE;
}

/** The newest regular session that has closed, when the bars hold it, and its last trade there. */
export interface ClosedSession {
  /** The session's local date. */
  date: string;
  /** The close of its last regular bar: the last trade before the closing auction. */
  lastTrade: number;
}

/** When each local date's session closed, read once per date. */
function sessionCloses(venue: string | undefined) {
  const closes = new Map<string, number | null>();
  return (date: string) => {
    if (!closes.has(date)) closes.set(date, regularSessionCloseOn(venue, date));
    return closes.get(date)!;
  };
}

/** Each closed session's last regular bar, by the session's local date (a later bar is after-hours). */
function lastRegularBars(points: readonly PricePoint[], venue: string | undefined, now: number): Map<string, number> {
  const zone = sessionCalendarTimeZone(venue);
  const latest = latestRegularSessionClose(venue, now);
  const last = new Map<string, number>();
  if (!zone || !latest) return last;
  const closeOn = sessionCloses(venue);
  points.forEach((point, index) => {
    const time = barTime(point);
    if (!Number.isFinite(time)) return;
    const date = zonedDateKey(time, zone);
    if (date > latest.date) return;
    const close = closeOn(date);
    if (close === null || time >= close) return;
    last.set(date, index);
  });
  return last;
}

/**
 * The newest regular session that has closed by `now` (the venue's calendar),
 * when the bars hold a regular bar of it: the session whose official close a
 * quote is read for. Null while the venue trades past its last session's
 * bars, for venues without sessions, and when the bars end earlier.
 */
export function newestClosedSession(points: readonly PricePoint[], options: { venue: string | undefined; now: number }): ClosedSession | null {
  const latest = latestRegularSessionClose(options.venue, options.now);
  if (!latest) return null;
  const index = lastRegularBars(points, options.venue, options.now).get(latest.date);
  return index === undefined ? null : { date: latest.date, lastTrade: points[index]!.close };
}

/** What the newest closed session's last bar ends on: a close, the note that its print is to come, or nothing to change. */
export type NewestSessionClose = { close: number } | { pending: true } | null;

/**
 * The close the newest closed session ends on, for its last regular bar
 * (`session`, from newestClosedSession). In order:
 *
 * 1. The quote's official close of that session (`regularClose`, dated by
 *    `regularCloseSessionDate` or the quote's trading day).
 * 2. Right after a US close (POST) without it, the note that the print is to
 *    come: the quote's price then is the last trade before the auction.
 * 3. Otherwise (the venue closed, the next pre-market, a listing that
 *    publishes no closing print) the session's finished daily bar, then the
 *    quote's own close: its price once closed, its previous close in the
 *    next pre-market.
 *
 * Every figure from the quote must be the bars' listing (same venue, same
 * currency where both are known), in the bars' units, and within 25% of the
 * session's last trade; one that is not is not used. A quote of the session
 * still trading, or none, leaves the daily bar's close or nothing.
 */
export function newestSessionClose(
  quote: Quote | null | undefined,
  session: ClosedSession & {
    venue: string | undefined;
    /** The listing's currency, where known. */
    currency?: string | null;
    /** The session's finished daily bar's close, where one was read. */
    dailyClose?: number | null;
  },
): NewestSessionClose {
  const daily = positive(session.dailyClose) && nearLastTrade(session.dailyClose, session.lastTrade) ? { close: session.dailyClose } : null;
  if (!quote || quote.marketState === "REGULAR") return daily;
  const quoteVenue = quote.listingExchangeName || quote.exchangeName;
  if (quoteVenue && session.venue && canonicalExchange(quoteVenue) !== canonicalExchange(session.venue)) return daily;
  if (session.currency && quote.currency && session.currency !== quote.currency) return daily;
  const usable = (value: number | undefined): value is number => positive(value)
    && !hasLikelyQuoteUnitMismatch({ currency: quote.currency, price: session.lastTrade }, { currency: quote.currency, price: value })
    && nearLastTrade(value, session.lastTrade);
  const official = positive(quote.regularClose) && (quote.regularCloseSessionDate ?? quoteTradingDay(quote)) === session.date
    ? quote.regularClose : undefined;
  if (official !== undefined) return usable(official) ? { close: official } : daily;
  if (quote.marketState === "POST" && isUsListingExchange(canonicalExchange(session.venue))) return { pending: true };
  if (daily) return daily;
  if (quote.marketState === "PRE" || quote.marketState === "PREPRE") {
    const previous = quote.previousClose;
    return (!quote.previousCloseDate || quote.previousCloseDate === session.date) && usable(previous) ? { close: previous } : null;
  }
  return quoteTradingDay(quote) === session.date && usable(quote.price) ? { close: quote.price } : null;
}

/**
 * Intraday bars of a listing that trades in sessions, each closed session's
 * last regular bar closing on that session's official close (`closes`, by
 * the venue's local date) instead of the last trade before the closing
 * auction: an hourly 19:30 UTC bar of a thin ETF ends on a 19:38 trade at
 * 12.31 while the 20:00 closing print is 12.19, which every total measured
 * from the bars then misses. The bar's high and low widen to take the close.
 * A close more than 25% off the bar's own is another unit's, and not taken.
 *
 * A session still trading, bars after its close (after-hours) and venues
 * without sessions are left as served; the points array is the same one when
 * nothing changed.
 */
export function withOfficialCloses(
  points: PricePoint[],
  closes: ReadonlyMap<string, number>,
  options: { venue: string | undefined; now: number },
): PricePoint[] {
  if (points.length === 0 || closes.size === 0) return points;
  let changed = false;
  const next = points.slice();
  for (const [date, index] of lastRegularBars(points, options.venue, options.now)) {
    const close = closes.get(date);
    const bar = next[index]!;
    if (!positive(close) || bar.close === close || !nearLastTrade(close, bar.close)) continue;
    next[index] = {
      ...bar,
      close,
      ...(positive(bar.high) ? { high: Math.max(bar.high, close) } : {}),
      ...(positive(bar.low) ? { low: Math.min(bar.low, close) } : {}),
    };
    changed = true;
  }
  return changed ? next : points;
}
