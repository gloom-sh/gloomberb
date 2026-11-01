import type { PricePoint, Quote } from "../types/financials";
import { pricePointIntegrity } from "../utils/price-history-integrity";
import { isQuoteStaleForCurrentSession } from "../market-data/quotes/freshness";
import { getRegularSessionBarClose } from "../market-data/market/status";
import { latestRegularSessionClose, sessionCalendarTimeZone } from "../market-data/market/freshness";
import { quoteTradingDay } from "../market-data/quotes/day-range";
import { quoteFutureToleranceMs } from "../market-data/quotes/clock";
import { hasLikelyQuoteUnitMismatch } from "../utils/currency-units";
import { resolveExchangeTimeZone } from "../utils/exchanges";
import { zonedDateKey, zonedWallClockToUtcMs } from "../utils/zoned-date-time";
import {
  CHART_RESOLUTION_STEP_MS,
  type ManualChartResolution,
} from "./resolution";

const MAX_LIVE_QUOTE_TAIL_AGE_MS = 7 * 24 * 60 * 60_000;
const MAX_LIVE_QUOTE_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_INTRADAY_BAR_INTERVAL_MS = 6 * 60 * 60_000;
export const MIN_LIVE_QUOTE_TAIL_GAP_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
// Closer daily points than this are intraday data, not calendar bars.
const MIN_CALENDAR_BAR_INTERVAL_MS = 20 * 60 * 60_000;

export type AppendLiveQuotePointOptions = { assetCategory?: string } & (
  | {
    now?: number;
    mode?: "scalar";
  }
  | {
    now?: number;
    mode: "ohlc";
    resolution: ManualChartResolution;
    exchange?: string;
  });

/** PricePoint history has no declared bond price convention. A quote cannot
 * prove whether those separate observations are money or percent of par. */
export function hasUnknownBondHistoryBasis(quote?: Quote | null, ...assetCategories: Array<string | undefined>): boolean {
  return quote?.priceBasis === "percent-of-par"
    || quote?.instrumentType?.trim().toUpperCase() === "BOND"
    || assetCategories.some((category) => category?.trim().toUpperCase() === "BOND");
}

function coerceDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

function getPointTime(point: Pick<PricePoint, "date">): number {
  return coerceDate(point.date as Date | string | number).getTime();
}

function getActiveQuotePrice(quote: Quote): number {
  if ((quote.marketState === "PRE" || quote.marketState === "PREPRE") && quote.preMarketPrice != null) {
    return quote.preMarketPrice;
  }
  if ((quote.marketState === "POST" || quote.marketState === "POSTPOST") && quote.postMarketPrice != null) {
    return quote.postMarketPrice;
  }
  return quote.price;
}

export function isCalendarResolution(resolution: ManualChartResolution): resolution is "1d" | "1wk" | "1mo" {
  return resolution === "1d" || resolution === "1wk" || resolution === "1mo";
}

/**
 * The calendar period a timestamp falls in, as the UTC date of its first day.
 * Vendors use both UTC date labels and actual session-opening timestamps. A
 * daily bar belongs to a calendar session, not the next rolling 24 hours.
 */
export function calendarBarStart(
  timestamp: number,
  resolution: "1d" | "1wk" | "1mo",
  exchange?: string,
  dateLabel = timestamp % DAY_MS === 0,
): string {
  const day = dateLabel ? new Date(timestamp).toISOString().slice(0, 10) :
    zonedDateKey(timestamp, resolveExchangeTimeZone(exchange) ?? "UTC");
  if (resolution === "1mo") return `${day.slice(0, 7)}-01`;
  if (resolution === "1wk") {
    const monday = new Date(`${day}T00:00:00Z`);
    monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
    return monday.toISOString().slice(0, 10);
  }
  return day;
}

export function quoteBelongsToLatestBar(
  latestTime: number,
  quoteTime: number,
  resolution: ManualChartResolution,
  exchange?: string,
): boolean {
  if (quoteTime < latestTime) return false;
  if (isCalendarResolution(resolution)) {
    return calendarBarStart(latestTime, resolution, exchange) === calendarBarStart(quoteTime, resolution, exchange, false);
  }
  return quoteTime - latestTime < CHART_RESOLUTION_STEP_MS[resolution];
}

function finiteOrFallback(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function mergeQuoteIntoLatestBar(latest: PricePoint, quotePrice: number, range?: QuoteSessionRange | null): PricePoint {
  if (pricePointIntegrity(latest)) {
    // A later quote cannot establish which reported OHLC field was wrong, unless it names the bar's whole session: its
    // open, range and price are the bar (GOGL's 2026-10-30 daily bar, served with a high under its open).
    return range?.open === undefined ? latest : { ...latest, open: range.open, high: range.high, low: range.low, close: quotePrice };
  }
  const open = finiteOrFallback(latest.open, latest.close);
  const high = finiteOrFallback(latest.high, Math.max(open, latest.close));
  const low = finiteOrFallback(latest.low, Math.min(open, latest.close));
  // The bar keeps its own open: a weekly or monthly bar opened on an earlier day than the quote's session.
  return {
    ...latest,
    open,
    high: Math.max(high, open, latest.close, quotePrice, range?.high ?? quotePrice),
    low: Math.min(low, open, latest.close, quotePrice, range?.low ?? quotePrice),
    close: quotePrice,
  };
}

/**
 * The clock a quote is judged against. A quote stamped slightly after the
 * local clock is a clock difference, not a malformed observation: dropping it
 * froze the tail on machines running behind the server.
 */
function quoteObservationNow(quote: Pick<Quote, "lastUpdated">, now: number): number {
  const quoteTime = quote.lastUpdated;
  return Number.isFinite(quoteTime) && quoteTime > now && quoteTime - now <= quoteFutureToleranceMs()
    ? quoteTime
    : now;
}

interface LiveQuoteObservation {
  time: number;
  price: number;
}

/**
 * Which of a quote's prices a history takes: `latest` the live print,
 * pre-market and after hours included, as intraday bars do; `regular` the
 * regular session's (getRegularSessionBarClose), as daily and longer bars do,
 * so a closed market's last bar is its regular close.
 */
export type LiveQuoteBasis = "latest" | "regular";

/**
 * The regular-session observation of a quote: its price while the session
 * trades, else the completed session's close. A close from before the quote's
 * own day (the pre-market's) is none: that session's bar is the history's, and
 * a day that has not traded has no bar yet.
 */
function regularSessionObservation(quote: Quote, quoteTime: number): LiveQuoteObservation | null {
  const bar = getRegularSessionBarClose(quote);
  if (!bar || !Number.isFinite(bar.price) || bar.price <= 0) return null;
  if (bar.sessionDate != null && bar.sessionDate !== quoteTradingDay(quote)) return null;
  return { time: quoteTime, price: bar.price };
}

/**
 * What a quote reports of the session a daily or longer bar takes it from:
 * the open when the bar opens with that session, and the session's high and
 * low, each taken with the observed price. The bar's own prints only widen it
 * from there.
 */
export interface QuoteSessionRange {
  open?: number;
  high: number;
  low: number;
}

function positiveWithin(quote: Quote, price: number, value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    && !hasLikelyQuoteUnitMismatch({ currency: quote.currency, price }, { currency: quote.currency, price: value })
    ? value : undefined;
}

/** True when the session on `day` (venue-local date) is the first of its week or month at the venue. */
function startsCalendarPeriod(day: string, resolution: "1wk" | "1mo", venue: string | undefined): boolean {
  const zone = sessionCalendarTimeZone(venue);
  if (!zone) return false;
  const before = latestRegularSessionClose(venue,
    zonedWallClockToUtcMs(zone, Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10)), 0, 0, 0));
  const label = (date: string) => calendarBarStart(Date.parse(`${date}T00:00:00Z`), resolution, venue);
  return !!before && label(before.date) !== label(day);
}

/**
 * The session values of a quote for the daily, weekly or monthly bar that
 * `observation` (its regular-session price, from liveQuoteObservation) lands
 * in, or null when the quote has none that describe it: no open, high or low,
 * a session other than the one observed, or values in other units than its
 * price. A quote's own range is already held to its regular session
 * (reconcileQuoteDayRange), so after the close it is that session's. The
 * open is the bar's only when the bar starts with that session: always for a
 * daily bar, for a weekly or monthly one when the session is the first of its
 * period (otherwise the period opened on a day the quote cannot name).
 */
export function quoteSessionRange(
  quote: Quote,
  observation: { time: number; price: number },
  resolution: ManualChartResolution,
  exchange?: string,
): QuoteSessionRange | null {
  if (!isCalendarResolution(resolution)) return null;
  const venue = exchange || quote.listingExchangeName || quote.exchangeName;
  const zone = resolveExchangeTimeZone(venue);
  const day = quoteTradingDay(quote);
  // Its range is of the session it declares; the bar the quote lands in is dated by when it was observed.
  if (!zone || !day || zonedDateKey(observation.time, zone) !== day) return null;
  const { price } = observation;
  let high = positiveWithin(quote, price, quote.high);
  let low = positiveWithin(quote, price, quote.low);
  if (high !== undefined && low !== undefined && high < low) { high = undefined; low = undefined; }
  const reported = positiveWithin(quote, price, quote.open);
  const open = reported !== undefined && (resolution === "1d" || startsCalendarPeriod(day, resolution, venue))
    ? reported : undefined;
  if (open === undefined && high === undefined && low === undefined) return null;
  return {
    ...(open === undefined ? {} : { open }),
    high: Math.max(price, open ?? price, high ?? price),
    low: Math.min(price, open ?? price, low ?? price),
  };
}

/** A current, well-formed quote price that may extend a price history, or null. */
export function liveQuoteObservation(
  quote: Quote | null | undefined,
  now: number,
  assetCategory?: string,
  basis: LiveQuoteBasis = "latest",
): LiveQuoteObservation | null {
  if (!quote || isQuoteStaleForCurrentSession(quote, quoteObservationNow(quote, now))) return null;
  if (hasUnknownBondHistoryBasis(quote, assetCategory)) return null;
  // No history covers the overnight session: its prices form or move no bar.
  if (quote.overnightPrice != null) return null;
  const quoteTime = quote.lastUpdated;
  if (
    !Number.isFinite(quoteTime)
    || quoteTime > now + Math.max(MAX_LIVE_QUOTE_CLOCK_SKEW_MS, quoteFutureToleranceMs())
    || now - quoteTime > MAX_LIVE_QUOTE_TAIL_AGE_MS
  ) {
    return null;
  }
  if (basis === "regular") return regularSessionObservation(quote, quoteTime);
  const quotePrice = getActiveQuotePrice(quote);
  if (!Number.isFinite(quotePrice) || quotePrice <= 0) return null;
  return { time: quoteTime, price: quotePrice };
}

export function appendLiveQuotePoint(
  points: PricePoint[],
  quote: Quote | null | undefined,
  options: AppendLiveQuotePointOptions = {},
): PricePoint[] {
  const now = options.now ?? Date.now();
  const latest = points.at(-1);
  if (!quote || !latest) return points;

  const latestTime = getPointTime(latest);
  if (!Number.isFinite(latestTime)) return points;
  const previous = points.at(-2);
  const latestInterval = previous ? latestTime - getPointTime(previous) : Number.NaN;
  // Daily and longer bars are regular-session bars; intraday ones follow the live print.
  const calendarBars = options.mode === "ohlc"
    ? CHART_RESOLUTION_STEP_MS[options.resolution] >= DAY_MS
    : latestInterval >= MIN_CALENDAR_BAR_INTERVAL_MS;
  const observation = liveQuoteObservation(quote, now, options.assetCategory, calendarBars ? "regular" : "latest");
  if (!observation) return points;
  const { time: quoteTime, price: quotePrice } = observation;
  const range = calendarBars && options.mode === "ohlc"
    ? quoteSessionRange(quote, observation, options.resolution, options.exchange || quote.listingExchangeName || quote.exchangeName)
    : null;
  // A calendar bar labelled with its own zone's date at UTC midnight starts
  // after `now` while that zone is ahead of UTC: London FX opens its day at
  // 23:00 UTC in summer. A quote shortly before such a bar is its live price.
  const beforeDatedBar = quoteTime < latestTime;
  if (beforeDatedBar && !(latestTime > now && latestTime - quoteTime < DAY_MS)) return points;

  if (
    latestInterval > 0
    && latestInterval <= MAX_INTRADAY_BAR_INTERVAL_MS
    && quoteTime - latestTime > Math.max(MIN_LIVE_QUOTE_TAIL_GAP_MS, latestInterval * 3)
  ) {
    return points;
  }

  const latestClose = latest.close;
  if (hasLikelyQuoteUnitMismatch(
    { currency: quote.currency, price: latestClose },
    { currency: quote.currency, price: quotePrice },
  )) {
    return points;
  }

  if (beforeDatedBar) {
    if (!calendarBars) return points;
    const merged = options.mode === "ohlc" || latest.high != null || latest.low != null
      ? mergeQuoteIntoLatestBar(latest, quotePrice)
      : { ...latest, close: quotePrice };
    return [...points.slice(0, -1), merged];
  }

  if (options.mode === "ohlc") {
    if (quoteBelongsToLatestBar(latestTime, quoteTime, options.resolution, options.exchange || quote.listingExchangeName || quote.exchangeName)) {
      const merged = mergeQuoteIntoLatestBar(latest, quotePrice, range);
      return [...points.slice(0, -1), merged];
    }
    return [
      ...points,
      {
        date: new Date(quoteTime),
        open: range?.open ?? quotePrice,
        high: range?.high ?? quotePrice,
        low: range?.low ?? quotePrice,
        close: quotePrice,
      },
    ];
  }

  if (quoteTime === latestTime) return points;

  return [
    ...points,
    {
      date: new Date(quoteTime),
      close: quotePrice,
    },
  ];
}
