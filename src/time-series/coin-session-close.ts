import { latestRegularSessionClose, isAlwaysOpenExchange, sessionCalendarTimeZone } from "../market-data/market/freshness";
import { fetchHistoryResult } from "../sources/history-result";
import type { DataProvider } from "../types/data-provider";
import { isRoundTheClockCoin } from "../utils/crypto-pair";
import { canonicalExchange, isUsListingExchange } from "../utils/exchanges";
import { logFailure } from "../utils/log-failure";
import { zonedWallClockToUtcMs } from "../utils/zoned-date-time";
import type { PriceComparison } from "./price-comparison";
import type { ResolvedSeries } from "./types";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** Up to this span between its ends, a coin's hourly bars are read whole (a few hundred bars); past it, around each end. */
const SPAN_READ_MS = 16 * DAY_MS;

/** The venue a compared leg trades on, as its sessions are read. */
function legVenue(series: ResolvedSeries | undefined): string | undefined {
  return series?.timeBasis?.exchange || series?.listing?.exchange || undefined;
}

/** A coin that trades round the clock, its daily bar the UTC day: BTC-USD on the crypto venue. */
export function isRoundTheClockLeg(series: ResolvedSeries | undefined): boolean {
  if (!series) return false;
  const venue = legVenue(series);
  return (!!venue && isAlwaysOpenExchange(venue)) || isRoundTheClockCoin(series.listing?.symbol, series.listing?.exchange);
}

/** A leg whose venue closes each day at a known time: a US fund, a London share. */
function sessionVenueOf(series: ResolvedSeries | undefined): string | null {
  const venue = legVenue(series);
  return venue && !isRoundTheClockLeg(series) && !isAlwaysOpenExchange(venue) && sessionCalendarTimeZone(venue) ? venue : null;
}

/** When the venue's regular session on its local `date` closed, or null when it had none that day. */
export function sessionCloseOn(venue: string, date: string): number | null {
  const zone = sessionCalendarTimeZone(venue);
  if (!zone) return null;
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const close = latestRegularSessionClose(venue, zonedWallClockToUtcMs(zone, year, month, day, 23, 59, 59));
  return close?.date === date ? close.close : null;
}

/** `US` for a US listing's venue, else the venue's code, as the close a coin is measured against is named. */
export function sessionMarketName(venue: string): string {
  return isUsListingExchange(venue) ? "US" : canonicalExchange(venue);
}

type HourlyRead = Awaited<ReturnType<typeof fetchHistoryResult>>;
type HourlyProvider = Pick<DataProvider, "getDetailedPriceHistory" | "getDetailedPriceHistoryWithMetadata">;
/** Recent reads by source, listing and span: a chart resolves again on every live quote, and asks for the same hours. */
const hourlyReadsBySource = new WeakMap<HourlyProvider, Map<string, { at: number; read: Promise<HourlyRead> }>>();
const HOURLY_READ_LIMIT = 64;
/** A span reaching the last hour is read again after this long; an older one is kept until it falls out. */
const RECENT_READ_TTL_MS = 60_000;

function hourlyBars(
  provider: HourlyProvider,
  symbol: string,
  exchange: string,
  start: number,
  end: number,
  now: number,
): Promise<HourlyRead> {
  let hourlyReads = hourlyReadsBySource.get(provider);
  if (!hourlyReads) hourlyReadsBySource.set(provider, hourlyReads = new Map());
  // A span ending now is keyed by its minute, so a chart redrawn within it reads it once.
  end = Math.ceil(end / 60_000) * 60_000;
  const key = `${symbol}:${exchange}:${start}:${end}`;
  const cached = hourlyReads.get(key);
  if (cached && (end < now - HOUR_MS || now - cached.at < RECENT_READ_TTL_MS)) return cached.read;
  const read = fetchHistoryResult(provider as DataProvider, symbol, exchange, { kind: "detail", start: new Date(start), end: new Date(end), interval: "1h" })
    .catch(logFailure("time-series.coin-session-close", "Read a coin's hourly bars for a comparison failed", null))
    .then((result) => {
      // A failed read is asked again next time.
      if (!result && hourlyReads!.get(key)?.read === read) hourlyReads!.delete(key);
      return result;
    });
  hourlyReads.delete(key);
  hourlyReads.set(key, { at: now, read });
  if (hourlyReads.size > HOURLY_READ_LIMIT) hourlyReads.delete(hourlyReads.keys().next().value!);
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

/**
 * A daily comparison of a coin with a listing that trades in sessions (IBIT
 * against BTC-USD) compares the fund's close at 20:00 UTC with the coin's at
 * 00:00 UTC, four hours later, which on a falling night is most of the gap.
 * When the coin's hourly bars reach back to its base, each of its daily
 * closes from the base to its end is replaced by its price at the session
 * venue's close that day (the close of the hourly bar ending then), so both
 * legs are measured at the same instants. A coin whose hourly bars do not
 * reach its base (they go back about a week) keeps its UTC closes, and the
 * comparison names each close time instead (priceComparisonCloseTimes).
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
  if (!venue || coins.length === 0) return null;
  const atSessionClose = new Set<string>();
  const closedEnds = new Set<string>();
  const next = [...series];
  await Promise.all(coins.map(async (id) => {
    const entry = byId.get(id)!;
    const leg = comparison.legs![id]!;
    const baseClose = sessionCloseOn(venue, leg.baseDay);
    // A coin's newest day still running is its latest price; measured at the close only once the venue has closed.
    const endClose = sessionCloseOn(venue, leg.endDay);
    const endTime = endClose !== null && endClose <= now ? endClose : leg.intraday ? null : endClose;
    if (baseClose === null || (endTime === null && !leg.intraday)) return;
    const symbol = entry.listing?.symbol;
    if (!symbol) return;
    // A short window reads every hourly bar of its span, so each day in it is measured at the close; a long one only
    // the hours around its two ends, which are what its return is measured between.
    const last = endTime ?? now;
    const spans: Array<[number, number]> = last - baseClose <= SPAN_READ_MS
      ? [[baseClose - 2 * HOUR_MS, Math.min(now, last + HOUR_MS)]]
      : [[baseClose - 2 * HOUR_MS, baseClose + HOUR_MS], ...(endTime === null ? [] : [[endTime - 2 * HOUR_MS, Math.min(now, endTime + HOUR_MS)] as [number, number]])];
    const reads = await Promise.all(spans.map(([start, end]) => hourlyBars(provider, symbol, entry.listing?.exchange ?? "", start, end, now)));
    // Each hourly bar's close by the time it closed.
    const closes = new Map<number, number>();
    for (const read of reads) {
      if (!read || read.resolution !== "1h") return;
      for (const bar of read.points) {
        const open = new Date(bar.date).getTime();
        if (Number.isFinite(open) && Number.isFinite(bar.close) && bar.close > 0) closes.set(open + HOUR_MS, bar.close);
      }
    }
    if (!closes.has(baseClose) || (endTime !== null && !closes.has(endTime))) return;
    const points = entry.points.map((point) => {
      const day = point.date.toISOString().slice(0, 10);
      if (day < leg.baseDay || day > leg.endDay) return point;
      const close = sessionCloseOn(venue, day);
      const price = close === null ? undefined : closes.get(close);
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
    const sessionClose = leg.intraday ? null : sessionCloseOn(venue, leg.endDay);
    const coinClose = Date.parse(`${leg.endDay}T00:00:00Z`) + DAY_MS;
    const hours = sessionClose === null ? null : Math.round((coinClose - sessionClose) / HOUR_MS);
    return hours !== null && hours > 0 ? `${label} to 00:00 UTC, ${hours} h after the ${market} close` : `${label} to 00:00 UTC`;
  });
  return parts.join("; ");
}
