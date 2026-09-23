import type { PricePoint, Quote } from "../types/financials";
import { pricePointIntegrity } from "../utils/price-history-integrity";
import { isQuoteStaleForCurrentSession } from "../market-data/quotes/freshness";
import { quoteFutureToleranceMs } from "../market-data/quotes/clock";
import { hasLikelyQuoteUnitMismatch } from "../utils/currency-units";
import { resolveExchangeTimeZone } from "../utils/exchanges";
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
    new Intl.DateTimeFormat("en-CA", {
      timeZone: resolveExchangeTimeZone(exchange) ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(timestamp));
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

function mergeQuoteIntoLatestBar(latest: PricePoint, quotePrice: number): PricePoint {
  // A later quote cannot establish which reported OHLC field was wrong.
  if (pricePointIntegrity(latest)) return latest;
  const open = finiteOrFallback(latest.open, latest.close);
  const high = finiteOrFallback(latest.high, Math.max(open, latest.close));
  const low = finiteOrFallback(latest.low, Math.min(open, latest.close));
  return {
    ...latest,
    open,
    high: Math.max(high, open, latest.close, quotePrice),
    low: Math.min(low, open, latest.close, quotePrice),
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

/** A current, well-formed quote price that may extend a price history, or null. */
export function liveQuoteObservation(
  quote: Quote | null | undefined,
  now: number,
  assetCategory?: string,
): LiveQuoteObservation | null {
  if (!quote || isQuoteStaleForCurrentSession(quote, quoteObservationNow(quote, now))) return null;
  if (hasUnknownBondHistoryBasis(quote, assetCategory)) return null;
  const quoteTime = quote.lastUpdated;
  const quotePrice = getActiveQuotePrice(quote);
  if (
    !Number.isFinite(quoteTime)
    || !Number.isFinite(quotePrice)
    || quotePrice <= 0
    || quoteTime > now + Math.max(MAX_LIVE_QUOTE_CLOCK_SKEW_MS, quoteFutureToleranceMs())
    || now - quoteTime > MAX_LIVE_QUOTE_TAIL_AGE_MS
  ) {
    return null;
  }
  return { time: quoteTime, price: quotePrice };
}

export function appendLiveQuotePoint(
  points: PricePoint[],
  quote: Quote | null | undefined,
  options: AppendLiveQuotePointOptions = {},
): PricePoint[] {
  const now = options.now ?? Date.now();
  const observation = liveQuoteObservation(quote, now, options.assetCategory);
  if (!quote || !observation) return points;
  const { time: quoteTime, price: quotePrice } = observation;

  const latest = points.at(-1);
  if (!latest) return points;

  const latestTime = getPointTime(latest);
  if (!Number.isFinite(latestTime)) return points;
  // A calendar bar labelled with its own zone's date at UTC midnight starts
  // after `now` while that zone is ahead of UTC: London FX opens its day at
  // 23:00 UTC in summer. A quote shortly before such a bar is its live price.
  const beforeDatedBar = quoteTime < latestTime;
  if (beforeDatedBar && !(latestTime > now && latestTime - quoteTime < DAY_MS)) return points;

  const previous = points.at(-2);
  const latestInterval = previous ? latestTime - getPointTime(previous) : Number.NaN;
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
    const calendarBars = options.mode === "ohlc"
      ? CHART_RESOLUTION_STEP_MS[options.resolution] >= DAY_MS
      : latestInterval >= MIN_CALENDAR_BAR_INTERVAL_MS;
    if (!calendarBars) return points;
    const merged = options.mode === "ohlc" || latest.high != null || latest.low != null
      ? mergeQuoteIntoLatestBar(latest, quotePrice)
      : { ...latest, close: quotePrice };
    return [...points.slice(0, -1), merged];
  }

  if (options.mode === "ohlc") {
    if (quoteBelongsToLatestBar(latestTime, quoteTime, options.resolution, options.exchange || quote.listingExchangeName || quote.exchangeName)) {
      const merged = mergeQuoteIntoLatestBar(latest, quotePrice);
      return [...points.slice(0, -1), merged];
    }
    return [
      ...points,
      {
        date: new Date(quoteTime),
        open: quotePrice,
        high: quotePrice,
        low: quotePrice,
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
