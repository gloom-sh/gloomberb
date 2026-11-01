import { hasRegularCloseHour, isAlwaysOpenExchange, regularSessionCloseOn, sessionCalendarTimeZone } from "../market-data/market/freshness";
import { fetchHistoryResult } from "../sources/history-result";
import type { DataProvider } from "../types/data-provider";
import { isRoundTheClockCoin } from "../utils/crypto-pair";
import { canonicalExchange, isUsListingExchange } from "../utils/exchanges";
import { logFailure } from "../utils/log-failure";
import { zonedDateTimeParts, zonedWallClockToUtcMs } from "../utils/zoned-date-time";
import type { PriceComparison } from "./price-comparison";
import type { ResolvedSeries } from "./types";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** How far back hourly bars are read for a comparison: Gloom Cloud keeps a coin's for a year. A longer span keeps UTC closes. */
const HOURLY_REACH_MS = 370 * DAY_MS;

/** The venue a compared leg trades on, as its sessions are read. */
function legVenue(series: ResolvedSeries | undefined): string | undefined {
  return series?.timeBasis?.exchange || series?.listing?.exchange || undefined;
}

/** A coin that trades round the clock, its daily bar the UTC day: BTC-USD on the crypto venue. */
function isRoundTheClockLeg(series: ResolvedSeries | undefined): boolean {
  if (!series) return false;
  const venue = legVenue(series);
  return (!!venue && isAlwaysOpenExchange(venue)) || isRoundTheClockCoin(series.listing?.symbol, series.listing?.exchange);
}

/**
 * A leg whose venue closes each day at a known hour: a US fund, a London share. A venue whose close hour is not
 * known has no close to measure a coin at: the coin keeps its UTC closes, and the notice names no close.
 */
function sessionVenueOf(series: ResolvedSeries | undefined): string | null {
  const venue = legVenue(series);
  return venue && !isRoundTheClockLeg(series) && !isAlwaysOpenExchange(venue) && sessionCalendarTimeZone(venue) && hasRegularCloseHour(venue)
    ? venue : null;
}

/** `US` for a US listing's venue, else the venue's code, as the close a coin is measured against is named. */
function sessionMarketName(venue: string): string {
  return isUsListingExchange(venue) ? "US" : canonicalExchange(venue);
}

type HourlyRead = Awaited<ReturnType<typeof fetchHistoryResult>>;
type HourlyProvider = Pick<DataProvider, "getDetailedPriceHistory" | "getDetailedPriceHistoryWithMetadata">;
interface HourlyReads {
  /** Recent reads by listing and span: a chart resolves again on every live quote, and asks for the same hours. */
  spans: Map<string, { at: number; read: Promise<HourlyRead> }>;
  /** Listings whose read failed, until when they are not asked again. */
  failedUntil: Map<string, number>;
}
const hourlyReadsBySource = new WeakMap<HourlyProvider, HourlyReads>();
const HOURLY_READ_LIMIT = 64;
/** A span reaching the last hour is read again after this long; an older one is kept until it falls out. */
const RECENT_READ_TTL_MS = 60_000;
/** A listing whose hourly bars failed to load is not asked again for this long, so the failure is logged once in it. */
const FAILED_READ_TTL_MS = 2 * 60_000;
const logHourlyFailure = logFailure("time-series.coin-session-close", "Read a coin's hourly bars for a comparison failed", null);

function hourlyBars(
  provider: HourlyProvider,
  symbol: string,
  exchange: string,
  start: number,
  end: number,
  now: number,
): Promise<HourlyRead> {
  let reads = hourlyReadsBySource.get(provider);
  if (!reads) hourlyReadsBySource.set(provider, reads = { spans: new Map(), failedUntil: new Map() });
  const listing = `${symbol}:${exchange}`;
  if ((reads.failedUntil.get(listing) ?? 0) > now) return Promise.resolve(null);
  // A span ending now is keyed by its minute, so a chart redrawn within it reads it once.
  end = Math.ceil(end / 60_000) * 60_000;
  const key = `${listing}:${start}:${end}`;
  const cached = reads.spans.get(key);
  if (cached && (end < now - HOUR_MS || now - cached.at < RECENT_READ_TTL_MS)) return cached.read;
  const read = fetchHistoryResult(provider as DataProvider, symbol, exchange, { kind: "detail", start: new Date(start), end: new Date(end), interval: "1h" })
    .then((result) => result ?? Promise.reject(new Error("no hourly bars")))
    .catch((error: unknown) => {
      // A failed read is asked again only after FAILED_READ_TTL_MS, and logged once for it.
      reads!.failedUntil.set(listing, now + FAILED_READ_TTL_MS);
      if (reads!.spans.get(key)?.read === read) reads!.spans.delete(key);
      return logHourlyFailure(error);
    });
  reads.spans.delete(key);
  reads.spans.set(key, { at: now, read });
  if (reads.spans.size > HOURLY_READ_LIMIT) reads.spans.delete(reads.spans.keys().next().value!);
  return read;
}

export interface SessionCloseTiming {
  /** The venue whose close the coins are compared against: the first compared leg that trades in sessions. */
  venue: string;
  /** Coin legs measured at that venue's close on each of their days, from hourly bars. */
  atSessionClose: ReadonlySet<string>;
  /** Of those, the legs whose newest day's session has closed: their end is that close, not a price still moving. */
  closedEnds: ReadonlySet<string>;
}

/** The venue's wall clock of `time` in its zone, to measure a day without a session at its usual close. */
function wallClock(time: number, zone: string): { hour: number; minute: number } {
  const { hour, minute } = zonedDateTimeParts(time, zone);
  return { hour, minute };
}

/**
 * A daily comparison of a coin with a listing that trades in sessions (IBIT
 * against BTC-USD) compares the fund's close at 20:00 UTC with the coin's at
 * 00:00 UTC, four hours later, which on a falling night is most of the gap.
 * When the coin's hourly bars cover its whole span, every one of its daily
 * points from the base to its end is replaced by its price at the session
 * venue's close (the close of the hourly bar ending then; a day the venue
 * does not trade, at the clock time of its last close), so both legs and
 * the line between are measured at the same instants. A coin whose hourly
 * bars miss any of those hours (they go back a year) keeps its UTC closes
 * throughout, and the comparison names each close time instead
 * (priceComparisonCloseTimes): the line and its total never mix the two.
 *
 * Null when the comparison has no such pair of legs; otherwise the venue and
 * the series, with the coin legs that could be measured at its close.
 */
export async function coinLegsAtSessionClose(
  comparison: PriceComparison | null,
  series: readonly ResolvedSeries[],
  provider: HourlyProvider,
  now: number,
): Promise<{ timing: SessionCloseTiming; series: ResolvedSeries[] } | null> {
  if (comparison?.alignment !== "session-date" || !comparison.legs) return null;
  const byId = new Map(series.map((entry) => [entry.id, entry]));
  const compared = Object.keys(comparison.legs);
  const venue = compared.map((id) => sessionVenueOf(byId.get(id))).find((entry): entry is string => !!entry);
  const coins = compared.filter((id) => isRoundTheClockLeg(byId.get(id)) && byId.get(id)!.historyResolution === "1d");
  const zone = venue ? sessionCalendarTimeZone(venue) : null;
  if (!venue || !zone || coins.length === 0) return null;
  const atSessionClose = new Set<string>();
  const closedEnds = new Set<string>();
  const next = [...series];
  await Promise.all(coins.map(async (id) => {
    const entry = byId.get(id)!;
    const leg = comparison.legs![id]!;
    const symbol = entry.listing?.symbol;
    const baseClose = regularSessionCloseOn(venue, leg.baseDay);
    // A coin's newest day still running is its latest price; measured at the close only once the venue has closed.
    const endClose = regularSessionCloseOn(venue, leg.endDay);
    const endTime = endClose !== null && endClose <= now ? endClose : leg.intraday ? null : endClose;
    if (!symbol || baseClose === null || (endTime === null && !leg.intraday)) return;
    // The instant each of the coin's days is measured at: the venue's close that day, or on a day it does not trade,
    // the clock time of its last close before.
    const instants = new Map<number, number>();
    let clock = wallClock(baseClose, zone);
    entry.points.forEach((point, index) => {
      const day = point.date.toISOString().slice(0, 10);
      if (day < leg.baseDay || day > leg.endDay) return;
      if (day === leg.endDay && endTime === null) return;
      const close = regularSessionCloseOn(venue, day);
      if (close !== null) clock = wallClock(close, zone);
      instants.set(index, close ?? zonedWallClockToUtcMs(zone, Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10)),
        clock.hour, clock.minute, 0));
    });
    const times = [...instants.values()];
    const last = Math.max(baseClose, ...times);
    if (last > now || last - baseClose > HOURLY_REACH_MS) return;
    const read = await hourlyBars(provider, symbol, entry.listing?.exchange ?? "", baseClose - 2 * HOUR_MS, Math.min(now, last + HOUR_MS), now);
    if (!read || read.resolution !== "1h") return;
    // Each finished hourly bar's close by the time it closed; a bar still forming has no close yet.
    const closes = new Map<number, number>();
    for (const bar of read.points) {
      const open = new Date(bar.date).getTime();
      if (!bar.partial && Number.isFinite(open) && Number.isFinite(bar.close) && bar.close > 0) closes.set(open + HOUR_MS, bar.close);
    }
    // Every day or none: a line of closes at the venue's close with a few UTC closes between would be neither.
    if (!closes.has(baseClose) || times.some((time) => !closes.has(time))) return;
    const points = entry.points.map((point, index) => {
      const price = instants.has(index) ? closes.get(instants.get(index)!)! : undefined;
      return price === undefined ? point : { ...point, value: price, close: price, rawValue: price };
    });
    next[next.indexOf(entry)] = { ...entry, points };
    atSessionClose.add(id);
    if (endTime !== null) closedEnds.add(id);
  }));
  return { timing: { venue, atSessionClose, closedEnds }, series: next };
}

/**
 * What a daily comparison of coins with listings that trade in sessions says
 * of when each is measured: `BTC-USD at the US close` when its hourly bars
 * put it there, else `BTC-USD to 00:00 UTC, 4 h after the US close`. Null
 * when no coin is compared with such a listing.
 */
export function priceComparisonCloseTimes(
  comparison: Pick<PriceComparison, "legs">,
  series: readonly ResolvedSeries[],
  labels: ReadonlyMap<string, string>,
  atSessionClose: ReadonlySet<string> = new Set(),
): string | null {
  const byId = new Map(series.map((entry) => [entry.id, entry]));
  const compared = Object.keys(comparison.legs ?? {});
  const venue = compared.map((id) => sessionVenueOf(byId.get(id))).find((entry): entry is string => !!entry);
  const coins = compared.filter((id) => isRoundTheClockLeg(byId.get(id)));
  if (!venue || coins.length === 0) return null;
  const market = sessionMarketName(venue);
  const parts = coins.map((id) => {
    const label = labels.get(id) ?? id;
    if (atSessionClose.has(id)) return `${label} at the ${market} close`;
    const leg = comparison.legs![id]!;
    const sessionClose = leg.intraday ? null : regularSessionCloseOn(venue, leg.endDay);
    const coinClose = Date.parse(`${leg.endDay}T00:00:00Z`) + DAY_MS;
    const hours = sessionClose === null ? null : Math.round((coinClose - sessionClose) / HOUR_MS);
    return hours !== null && hours > 0 ? `${label} to 00:00 UTC, ${hours} h after the ${market} close` : `${label} to 00:00 UTC`;
  });
  return parts.join("; ");
}
