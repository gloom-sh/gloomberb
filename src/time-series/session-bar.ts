import type { PricePoint, Quote } from "../types/financials";
import { classifyInstrumentType, kindFromListingSyntax } from "../tickers/instrument-kind";
import { isAlwaysOpenExchange, isRegularSessionTime, latestRegularSessionClose, sessionCalendarTimeZone } from "../market-data/market/freshness";
import { DAILY_BAR_CLOSE_VENUES } from "../market-data/market/dated-previous-close";
import { quoteTradingDay } from "../market-data/quotes/day-range";
import { canonicalExchange } from "../utils/exchanges";
import { hasLikelyQuoteUnitMismatch } from "../utils/currency-units";
import { pricePointIntegrity } from "../utils/price-history-integrity";
import { zonedDateKey } from "../utils/zoned-date-time";
import { barSizeFromGap, medianBarGap, requestedBarSize } from "./bar-spacing";
import { calendarBarStart, liveQuoteObservation } from "./chart-data";

const DAY_MS = 24 * 60 * 60_000;
/** Bars spaced closer than this are intraday, whatever else their dates look like. */
const DAILY_BAR_MIN_GAP_MS = 20 * 60 * 60_000;

/** What the newest daily bar is while its session trades: the day so far. */
export const DAY_SO_FAR_TEXT = "today so far";

export interface SessionBarOptions {
  now: number;
  /** The listing's venue, when the caller knows it; otherwise the quote's. */
  venue?: string;
  assetCategory?: string;
  /**
   * The bar size the history was asked for or served in, when the caller
   * knows it. Without it the size is read from the bars' spacing, which a
   * thinly traded listing (a trade every week or two) makes look weekly.
   */
  barSize?: "1d" | "1wk" | "1mo";
}

/** The `barSize` option for a history asked for in `resolution` bars: daily or longer ones only. */
export function dailyOrLongerBarSize(resolution: string | null | undefined): Pick<SessionBarOptions, "barSize"> {
  return resolution === "1d" || resolution === "1wk" || resolution === "1mo" ? { barSize: resolution } : {};
}

/**
 * The bar size withSessionBar is told for bars asked as `requested`: the
 * request, unless the source stated another (`stated`) or the bars' spacing
 * shows them finer, or coarser and starting their periods (requestedBarSize).
 * A 5Y range asks for weekly bars; served daily, Thursday's bar is a day, and
 * Friday's live price is a bar of its own, not Thursday's close.
 */
export function requestedSessionBarSize(
  points: readonly Pick<PricePoint, "date">[],
  requested: string | null | undefined,
  stated?: string | null,
): Pick<SessionBarOptions, "barSize"> {
  const asked = dailyOrLongerBarSize(requested).barSize;
  return asked ? { barSize: requestedBarSize(points.map((point) => new Date(point.date).getTime()), asked, stated) } : {};
}

/**
 * How long after its session closes a day's bar is final: a delayed quote
 * runs up to twenty minutes behind, and a closing auction prints at the bell.
 */
const SESSION_SETTLE_MS = 30 * 60_000;

function barTime(point: Pick<PricePoint, "date">): number {
  const date = point.date as Date | string | number;
  return (date instanceof Date ? date : new Date(date)).getTime();
}

function positive(value: number | undefined | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Listings whose daily bar is one regular session of shares: not a coin, pair, future, index or bond. */
function tradesInSessions(quote: Quote, venue: string | undefined): boolean {
  const kind = classifyInstrumentType(quote.instrumentType) ?? kindFromListingSyntax(quote.symbol, venue);
  return kind === null || kind === "equity" || kind === "fund";
}

/** A quote's day extreme, or nothing when it is in other units than its price. */
function consistentWith(quote: Quote, price: number, extreme: number | undefined): number | undefined {
  return positive(extreme) && !hasLikelyQuoteUnitMismatch({ currency: quote.currency, price }, { currency: quote.currency, price: extreme })
    ? extreme : undefined;
}

/**
 * The bar of the session in progress, from the quote: its open, the day's high
 * and low so far, the last price as close, and the volume traded so far. What
 * the history already holds of the bar can only be older, so each extreme
 * and the volume only grow from it.
 */
function sessionBar(prior: PricePoint | undefined, date: Date, quote: Quote, price: number): PricePoint {
  // A later quote cannot establish which reported OHLC field was wrong.
  const base = prior && !pricePointIntegrity(prior) ? prior : undefined;
  const priorOpen = base?.open;
  const open = positive(priorOpen) ? priorOpen : consistentWith(quote, price, quote.open) ?? price;
  const highs = [base?.high, consistentWith(quote, price, quote.high), price, open].filter(positive);
  const lows = [base?.low, consistentWith(quote, price, quote.low), price, open].filter(positive);
  const volumes = [base?.volume, quote.volume].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
  return {
    date,
    open,
    high: Math.max(...highs),
    low: Math.min(...lows),
    close: price,
    ...(volumes.length > 0 ? { volume: Math.max(...volumes) } : {}),
    partial: true,
  };
}

/**
 * Daily history that reaches into the session now trading, with the quote as
 * the truth about that session.
 *
 * Gloom Cloud keeps a copy of each range's daily bars through the session, so
 * the newest bar can be a snapshot of the opening minutes: AAPL at 19:13 UTC
 * with 1.1M of 39M shares, closing at the price of the first minutes. A
 * range cut before the session opened has no bar for the day at all. Charts
 * form the day's bar from the live quote (LiveBarAccumulator); a table that
 * reads the same history takes it the same way.
 *
 * While the session trades and the quote is current, the day's bar is rebuilt
 * from the quote (sessionBar), or added when the history lacks it, and marked
 * `partial` as a bar the day has not finished is. When the venue's calendar
 * says the session trades but no current quote confirms the bar, it is left
 * out: a snapshot of unknown age is not today's row. A weekly or monthly bar
 * covering today takes the quote's price and extremes, its volume as served.
 *
 * Daily bars of a listing that trades in sessions only; anything else, and a
 * session that is closed, is returned as served (the same array).
 */
export function withSessionBar(
  points: PricePoint[],
  quote: Quote | null | undefined,
  options: SessionBarOptions,
): PricePoint[] {
  const last = points.at(-1);
  if (!last || (points.length < 2 && !options.barSize)) return points;
  const times = points.map(barTime);
  const lastTime = times.at(-1)!;
  const gap = medianBarGap(times);
  if (!Number.isFinite(lastTime) || (!options.barSize && (gap === null || gap < DAILY_BAR_MIN_GAP_MS))) return points;
  // The size asked for, not the spacing: a listing that trades once a fortnight still has daily bars.
  const size = options.barSize ?? barSizeFromGap(gap!);
  const venue = options.venue || quote?.listingExchangeName || quote?.exchangeName || undefined;
  if (venue && isAlwaysOpenExchange(venue)) return points;
  if (quote && !tradesInSessions(quote, venue)) return points;
  const settled = quote ? settledSessionBar(points, last, lastTime, size, quote, venue, options.now) : null;
  if (settled) return settled;

  // A quote that does not say its session is read by the venue's calendar.
  const trading = quote?.marketState === "REGULAR" || (quote?.marketState == null && isRegularSessionTime(venue, options.now) === true);
  const observation = quote && trading ? liveQuoteObservation(quote, options.now, options.assetCategory, "regular") : null;
  const sessionDay = quote && observation ? quoteTradingDay(quote) : null;
  if (quote && observation && sessionDay) {
    const dayTime = Date.parse(`${sessionDay}T00:00:00Z`);
    if (!Number.isFinite(dayTime)) return points;
    if (hasLikelyQuoteUnitMismatch({ currency: quote.currency, price: last.close }, { currency: quote.currency, price: observation.price })) return points;
    if (size === "1d") {
      const lastDay = calendarBarStart(lastTime, "1d", venue);
      if (lastDay === sessionDay) return [...points.slice(0, -1), sessionBar(last, last.date, quote, observation.price)];
      // A history labelled by the days it covers (UTC midnight) gains the day; any other labelling is not ours to extend.
      if (lastDay < sessionDay && lastTime % DAY_MS === 0) return [...points, sessionBar(undefined, new Date(dayTime), quote, observation.price)];
      return points;
    }
    if (calendarBarStart(lastTime, size, venue) !== calendarBarStart(dayTime, size, venue) || pricePointIntegrity(last)) return points;
    const open = positive(last.open) ? last.open : last.close;
    const highs = [last.high, consistentWith(quote, observation.price, quote.high), open, last.close, observation.price].filter(positive);
    const lows = [last.low, consistentWith(quote, observation.price, quote.low), open, last.close, observation.price].filter(positive);
    return [...points.slice(0, -1), { ...last, open, high: Math.max(...highs), low: Math.min(...lows), close: observation.price }];
  }

  if (size !== "1d") return points;
  // No current quote, but the venue's session is trading and the newest bar is its day: a snapshot nothing can confirm.
  const zone = venue ? sessionCalendarTimeZone(venue) : null;
  if (zone && isRegularSessionTime(venue, options.now) === true
    && calendarBarStart(lastTime, "1d", venue) === zonedDateKey(options.now, zone)) {
    return points.slice(0, -1);
  }
  return points;
}

/**
 * A day's bar the source still marks partial once its session has closed:
 * the session's quote, read after the close, is that day's last price, so
 * the bar takes it (with the day's extremes and volume, which only grow) and
 * is final. A thin listing's Friday bar is no longer partial on Sunday.
 * Null when the bar is not such a bar, or the quote is not from its session,
 * and on a venue whose closed quote can end on a print after its closing call
 * (B3): its official close is the source's bar, which is waited for.
 */
function settledSessionBar(
  points: PricePoint[],
  last: PricePoint,
  lastTime: number,
  size: "1d" | "1wk" | "1mo",
  quote: Quote,
  venue: string | undefined,
  now: number,
): PricePoint[] | null {
  if (size !== "1d" || !last.partial || quote.marketState === "REGULAR" || !positive(quote.price)) return null;
  if (venue && DAILY_BAR_CLOSE_VENUES.has(canonicalExchange(venue))) return null;
  const day = calendarBarStart(lastTime, "1d", venue);
  const closed = latestRegularSessionClose(venue, now - SESSION_SETTLE_MS);
  if (!closed || closed.date < day || quoteTradingDay(quote) !== day) return null;
  if (hasLikelyQuoteUnitMismatch({ currency: quote.currency, price: last.close }, { currency: quote.currency, price: quote.price })) return null;
  const { partial: _partial, ...bar } = sessionBar(last, last.date, quote, quote.price);
  return [...points.slice(0, -1), bar];
}

/**
 * The daily bars `history` shows as final, which alerts on a daily close read
 * too: the bars as served, less the bar of a session still trading
 * (withSessionBar, which `history` rebuilds from the quote and marks partial)
 * and any bar still partial. A bar the source marks partial after its session
 * has settled takes that session's `quote` and is final, as `history` makes
 * it (settledSessionBar); with no quote from its session it stays partial.
 * A close `history` prints without `partial` is final here, and one it prints
 * with it is not.
 */
export function finalDailyBars(points: PricePoint[], options: SessionBarOptions, quote?: Quote | null): PricePoint[] {
  return withSessionBar(points, quote ?? null, options).filter((point) => !point.partial);
}
