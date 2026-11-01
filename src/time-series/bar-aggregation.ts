import type { PricePoint } from "../types/financials";
import { isAlwaysOpenExchange, isVenueTradingDay } from "../market-data/market/freshness";
import { futuresSessionOpenMinute, latestSessionStart, listingTimeZone } from "../market-data/market/trading-sessions";
import { isRoundTheClockCoin } from "../utils/crypto-pair";
import { canonicalExchange } from "../utils/exchanges";
import { futuresListingVenue } from "../utils/futures-generic";
import { mergePriceHistoryIntegrity, pricePointIntegrity, type PriceHistoryIntegrity } from "../utils/price-history-integrity";
import { getPricePointTimestamp } from "../utils/price-history";
import { zonedDateTimeParts } from "../utils/zoned-date-time";
import { isFiniteNumber } from "../utils/guards";
import { chartBarSizeParts, chartBarSizeStepMs, type ChartBarSize } from "./resolution";
import type { CustomChartResolution } from "./range";
import type { ResolvedSeries } from "./types";

const DAY_MS = 86_400_000;
/** Sessions open at least 23 hours apart, so an open stays the latest one for this long after it. */
const SESSION_REUSE_MS = 22 * 3_600_000;

/** Which listing the source bars are of, which says when its sessions open and which days it trades. */
export interface BarAggregationListing {
  symbol?: string;
  exchange?: string;
  /** The bars include pre-market and after-hours trading: US sessions then start at 04:00 New York. */
  extendedHours?: boolean;
}

/** A built bar. It carries the integrity of a source bar whose prices contradict each other, so the bar is left blank as that one is. */
export type AggregatedPricePoint = PricePoint & { integrity?: PriceHistoryIntegrity };

interface Bucket {
  key: string;
  time: number;
  bars: PricePoint[];
  gaps: PricePoint[];
}

/** A daily or longer bar's date: a label at UTC midnight names that date, others read in the venue's zone. */
function barDate(time: number, timeZone: string): { year: number; month: number; day: number } {
  if (time % DAY_MS === 0) {
    const date = new Date(time);
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
  }
  const { year, month, day } = zonedDateTimeParts(time, timeZone);
  return { year, month, day };
}

/** The venue whose calendar a listing trades on: a future's exchange, else its own. */
function calendarVenue(listing: BarAggregationListing): string {
  return futuresListingVenue(listing.symbol ?? "", listing.exchange)?.venue ?? canonicalExchange(listing.exchange ?? "");
}

/** Counts the trading days of each year before each of its days, from 1 January. */
function tradingDayCounter(listing: BarAggregationListing): (year: number, month: number, day: number) => number {
  const everyDay = isRoundTheClockCoin(listing.symbol, listing.exchange) || isAlwaysOpenExchange(listing.exchange);
  const venue = calendarVenue(listing);
  const years = new Map<number, Int16Array>();
  return (year, month, day) => {
    let before = years.get(year);
    if (!before) {
      const start = Date.UTC(year, 0, 1);
      const length = Math.round((Date.UTC(year + 1, 0, 1) - start) / DAY_MS);
      before = new Int16Array(length + 1);
      for (let index = 0; index < length; index += 1) {
        const date = new Date(start + index * DAY_MS).toISOString().slice(0, 10);
        before[index + 1] = before[index]! + (everyDay || isVenueTradingDay(venue, date) ? 1 : 0);
      }
      years.set(year, before);
    }
    return before[Math.round((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / DAY_MS)] ?? 0;
  };
}

/** The first Monday of a year: its first full week starts there. */
function firstMonday(year: number): number {
  const start = Date.UTC(year, 0, 1);
  return start + ((8 - new Date(start).getUTCDay()) % 7) * DAY_MS;
}

/** The period of `count` days, weeks or months a daily or longer bar falls in, counted from the start of its year. */
function calendarBucketKey(
  time: number,
  unit: "d" | "wk" | "mo",
  count: number,
  timeZone: string,
  tradingDaysBefore: ((year: number, month: number, day: number) => number) | null,
): string {
  const { year, month, day } = barDate(time, timeZone);
  if (unit === "mo") return `${year}:${Math.floor((month - 1) / count)}`;
  if (unit === "d") return `${year}:${Math.floor(tradingDaysBefore!(year, month, day) / count)}`;
  // A week is named by its Monday; the days before a year's first full week end the previous year's last bar.
  const date = Date.UTC(year, month - 1, day);
  const monday = date - ((new Date(date).getUTCDay() + 6) % 7) * DAY_MS;
  let weekYear = new Date(monday).getUTCFullYear();
  if (monday < firstMonday(weekYear)) weekYear -= 1;
  return `${weekYear}:${Math.floor((monday - firstMonday(weekYear)) / (7 * DAY_MS) / count)}`;
}

/** The shortest step between source bars, which says how long one of them is. */
function sourceStepMs(times: readonly number[]): number {
  let step = Number.POSITIVE_INFINITY;
  for (let index = 1; index < times.length; index += 1) {
    const gap = times[index]! - times[index - 1]!;
    if (gap > 0 && gap < step) step = gap;
  }
  return Number.isFinite(step) ? Math.max(step, 60_000) : 60_000;
}

/**
 * The bars of `size` built from shorter source bars, oldest first: the first
 * open, the highest high, the lowest low, the last close and the summed volume
 * of the source bars in each. Minute and hour bars start at the session's
 * open and every `size` after it, so a 4h bar on a US stock runs 09:30 to
 * 13:30 and the session's last one is shorter; a future's sessions open at its
 * venue's published time (17:00 Chicago on CME Globex), and a market without
 * known hours starts its days at midnight UTC. Day bars count the venue's
 * trading days from 1 January (every day for a coin), week bars the weeks from
 * the year's first Monday and month bars from January, starting again each
 * year, so a bar never moves when older history loads. A period without source
 * bars has no bar; one whose source bars are all reported gaps stays a gap.
 * A size the bars are already in returns them as they are.
 */
export function aggregatePriceBars(
  points: readonly PricePoint[],
  size: ChartBarSize,
  listing: BarAggregationListing = {},
): AggregatedPricePoint[] {
  const parts = chartBarSizeParts(size);
  const sorted = points
    .map((point) => ({ point, time: getPricePointTimestamp(point) }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((left, right) => left.time - right.time);
  if (!parts || sorted.length === 0) return sorted.map((entry) => entry.point);
  const intraday = parts.unit === "m" || parts.unit === "h";
  const sizeMs = parts.count * (parts.unit === "h" ? 3_600_000 : 60_000);
  const times = sorted.map((entry) => entry.time);
  const step = intraday ? sourceStepMs(times) : 0;
  if (intraday && step >= sizeMs) return sorted.map((entry) => entry.point);
  const timeZone = listingTimeZone(listing.symbol, listing.exchange) ?? "UTC";
  const tradingDaysBefore = parts.unit === "d" ? tradingDayCounter(listing) : null;

  // The open of the session a bar trades in, looked up once per session: the
  // latest open by the bar's last minute, so a bar that straddles an open
  // (clock-aligned source bars) starts that session.
  const lookupOpen = (time: number) => latestSessionStart(listing.symbol, listing.exchange, time, { extendedHours: listing.extendedHours === true });
  const hasHours = intraday && lookupOpen(times.at(-1)! + step - 1) !== null;
  let cachedOpen: number | null = null;
  const sessionOpen = (time: number): number => {
    if (!hasHours) return Math.floor(time / DAY_MS) * DAY_MS;
    if (cachedOpen !== null && time >= cachedOpen && time + step - 1 < cachedOpen + SESSION_REUSE_MS) return cachedOpen;
    cachedOpen = lookupOpen(time + step - 1) ?? Math.floor(time / DAY_MS) * DAY_MS;
    return cachedOpen;
  };

  const buckets: Bucket[] = [];
  let current: Bucket | undefined;
  for (const { point, time } of sorted) {
    let key: string;
    let start = time;
    if (intraday) {
      const open = sessionOpen(time);
      start = open + Math.max(0, Math.floor((time - open) / sizeMs)) * sizeMs;
      key = String(start);
    } else {
      key = calendarBucketKey(time, parts.unit as "d" | "wk" | "mo", parts.count, timeZone, tradingDaysBefore);
    }
    if (!current || current.key !== key) {
      current = { key, time: start, bars: [], gaps: [] };
      buckets.push(current);
    }
    (isFiniteNumber(point.close) ? current.bars : current.gaps).push(point);
  }
  return buckets.map((bucket) => buildBar(bucket, intraday));
}

function buildBar(bucket: Bucket, intraday: boolean): AggregatedPricePoint {
  const first = bucket.bars[0];
  // Day and longer bars keep the first source bar's own label: sources date a session at midnight or at its open.
  const date = new Date(intraday || !first ? bucket.time : getPricePointTimestamp(first));
  if (!first) return { ...bucket.gaps[0]!, date };
  const last = bucket.bars.at(-1)!;
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  let volume: number | undefined;
  let venueVolume: PricePoint["venueVolume"] | null | undefined;
  // What the volume counts carries over while every bar counts the same way.
  let volumeBasis: string | null | undefined;
  let partial = false;
  let filled = false;
  const integrity: PriceHistoryIntegrity[] = [];
  for (const bar of bucket.bars) {
    const close = bar.close;
    high = Math.max(high, isFiniteNumber(bar.high) ? bar.high : close);
    low = Math.min(low, isFiniteNumber(bar.low) ? bar.low : close);
    if (isFiniteNumber(bar.volume)) {
      volume = (volume ?? 0) + bar.volume;
      volumeBasis = volumeBasis === undefined || volumeBasis === bar.volumeBasis ? bar.volumeBasis ?? null : null;
    }
    // One venue's trades add up only while every bar counts the same venue.
    if (bar.venueVolume && venueVolume !== null) {
      venueVolume = venueVolume === undefined || venueVolume.venue === bar.venueVolume.venue
        ? { venue: bar.venueVolume.venue, volume: (venueVolume?.volume ?? 0) + bar.venueVolume.volume } : null;
    }
    partial ||= bar.partial === true;
    filled ||= bar.filled === true;
    const flagged = (bar as AggregatedPricePoint).integrity ?? pricePointIntegrity(bar);
    if (flagged) integrity.push(flagged);
  }
  return {
    date,
    open: isFiniteNumber(first.open) ? first.open : first.close,
    high,
    low,
    close: last.close,
    ...(volume !== undefined ? { volume } : {}),
    ...(volume !== undefined && volumeBasis ? { volumeBasis } : {}),
    ...(volume === undefined && venueVolume ? { venueVolume } : {}),
    ...(partial ? { partial: true } : {}),
    ...(filled ? { filled: true } : {}),
    ...(last.unsettled ? { unsettled: true } : {}),
    ...(integrity.length ? { integrity: mergePriceHistoryIntegrity(...integrity) } : {}),
  };
}

function greatestCommonDivisor(left: number, right: number): number {
  return right === 0 ? left : greatestCommonDivisor(right, left % right);
}

/**
 * When the sessions of the futures among `listings` open, in minutes after
 * local midnight, which the source bars of a built bar size must divide
 * (`chartBarSizeSource`); null when none of them is a future.
 */
export function futuresOpenMinuteOf(listings: Iterable<{ symbol: string; exchange?: string }>): number | null {
  let shared: number | null = null;
  for (const listing of listings) {
    const minute = futuresSessionOpenMinute(listing.symbol, listing.exchange);
    if (minute !== null) shared = shared === null ? minute : greatestCommonDivisor(shared, minute);
  }
  return shared;
}

/** A market series whose points were built in `size`: it says so, and its bars are that far apart. */
export function withBuiltBarSize(series: ResolvedSeries, size: CustomChartResolution): ResolvedSeries {
  return {
    ...series,
    barSize: size,
    ...(series.timeBasis?.kind === "market" ? { timeBasis: { ...series.timeBasis, cadenceMs: chartBarSizeStepMs(size) } } : {}),
  };
}
