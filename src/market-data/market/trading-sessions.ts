import { futuresListingVenue } from "../../utils/futures-generic";
import { canonicalExchange, isUsListingExchange } from "../../utils/exchanges";
import { zonedDateTimeParts, zonedWallClockToUtcMs } from "../../utils/zoned-date-time";
import { isRegularSessionTime, latestRegularSessionOpen, sessionCalendarTimeZone } from "./freshness";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface SessionOpen {
  timeZone: string;
  /** Minutes after local midnight. */
  open: number;
  /** The session for each weekday opens the evening before it, Sunday for Monday. */
  overnight: boolean;
  /** A different open on Sunday evening. */
  sundayOpen?: number;
}

/**
 * CME Group's Globex trading day opens at 17:00 Central the evening before
 * (cmegroup.com/trading-hours). Grains and oilseeds reopen at 19:00 and
 * livestock trade 08:30 to 13:05, but no contract trades across 17:00, so
 * every one of them starts its trading day there. Cboe Futures (VX) keeps
 * the same hours.
 */
const GLOBEX: SessionOpen = { timeZone: "America/Chicago", open: 17 * 60, overnight: true };
const VENUE_OPENS: Readonly<Record<string, SessionOpen>> = { CME: GLOBEX, CBT: GLOBEX, NYM: GLOBEX, CMX: GLOBEX, CFE: GLOBEX };

/** ICE Futures U.S. regular trading hours, New York time (ice.com, September 2026), by contract root. */
const NEW_YORK = "America/New_York";
const ICE_US_OPENS: Readonly<Record<string, SessionOpen>> = {
  KC: { timeZone: NEW_YORK, open: 4 * 60 + 15, overnight: false },
  CC: { timeZone: NEW_YORK, open: 4 * 60 + 45, overnight: false },
  SB: { timeZone: NEW_YORK, open: 3 * 60 + 30, overnight: false },
  OJ: { timeZone: NEW_YORK, open: 8 * 60, overnight: false },
  CT: { timeZone: NEW_YORK, open: 21 * 60, overnight: true },
  DX: { timeZone: NEW_YORK, open: 20 * 60, overnight: true, sundayOpen: 18 * 60 },
};
/** Another ICE U.S. contract: 18:00, after every listed contract closes and before any opens. */
const ICE_US_BOUNDARY: SessionOpen = { timeZone: NEW_YORK, open: 18 * 60, overnight: true };

function futuresSessionOpen(symbol: string, exchange: string | undefined): SessionOpen | null {
  const listing = futuresListingVenue(symbol, exchange);
  if (!listing) return null;
  if (listing.venue === "NYB") return (listing.root && ICE_US_OPENS[listing.root]) || ICE_US_BOUNDARY;
  return VENUE_OPENS[listing.venue] ?? null;
}

function latestOpen(session: SessionOpen, time: number): number | null {
  const { year, month, day } = zonedDateTimeParts(time, session.timeZone);
  const today = Date.UTC(year, month - 1, day) / MS_PER_DAY;
  for (let offset = 0; offset <= 7; offset += 1) {
    const date = new Date((today - offset) * MS_PER_DAY);
    const weekday = date.getUTCDay();
    // Overnight sessions open Sunday to Thursday evenings; day sessions Monday to Friday.
    if (session.overnight ? weekday === 5 || weekday === 6 : weekday === 0 || weekday === 6) continue;
    const minutes = weekday === 0 && session.sundayOpen !== undefined ? session.sundayOpen : session.open;
    const open = zonedWallClockToUtcMs(session.timeZone, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(),
      Math.floor(minutes / 60), minutes % 60, 0);
    if (open <= time) return open;
  }
  return null;
}

/**
 * When the trading session holding `time` opened: futures by their venue's
 * published hours, other listings by their regular session. Exchange holidays
 * on futures venues are not modelled; a holiday has no bars to place.
 */
export function latestTradingSessionOpen(symbol: string | undefined, exchange: string | undefined, time: number): number | null {
  if (!Number.isFinite(time)) return null;
  const futures = symbol || exchange ? futuresSessionOpen(symbol ?? "", exchange) : null;
  return futures ? latestOpen(futures, time) : latestRegularSessionOpen(exchange, time);
}

/**
 * The zone a listing's intraday times read in: a futures venue's own clock
 * (Chicago for CME Group, New York for ICE U.S.), otherwise the venue's. Null
 * for crypto, FX and venues without a known clock, which read in UTC.
 */
export function listingTimeZone(symbol: string | undefined, exchange: string | undefined): string | null {
  const futures = symbol || exchange ? futuresSessionOpen(symbol ?? "", exchange) : null;
  if (futures) return futures.timeZone;
  const zone = sessionCalendarTimeZone(exchange);
  return zone === "UTC" ? null : zone;
}

/** US pre-market trading opens at 04:00 New York time. */
const US_PRE_MARKET_OPEN_MINUTES = 4 * 60;

/**
 * Where a one-day chart of a listing starts: the open of the trading session
 * holding its latest bar, so a closed market, a weekend or a holiday shows
 * the last session. Futures follow their venue's published open (17:00
 * Central the evening before on CME Group), stocks their regular open. With
 * extended hours a US listing starts at 04:00 New York on the latest bar's
 * day, so a pre-market bar opens the new day. Null keeps a rolling day:
 * crypto, FX and venues without known hours.
 */
export function latestSessionStart(
  symbol: string | undefined,
  exchange: string | undefined,
  latest: number,
  options: { extendedHours?: boolean } = {},
): number | null {
  const open = latestTradingSessionOpen(symbol, exchange, latest);
  if (open === null || !options.extendedHours || !isUsListingExchange(exchange)
    || (symbol && futuresSessionOpen(symbol, exchange))) return open;
  const preMarket = (time: number) => {
    const { year, month, day } = zonedDateTimeParts(time, NEW_YORK);
    return zonedWallClockToUtcMs(NEW_YORK, year, month, day,
      Math.floor(US_PRE_MARKET_OPEN_MINUTES / 60), US_PRE_MARKET_OPEN_MINUTES % 60, 0);
  };
  const today = preMarket(latest);
  return today <= latest ? today : preMarket(open);
}

/**
 * The close a session is measured from: the last bar before `start` that
 * traded in the previous session, its regular hours on a stock venue with
 * known hours. Null when the loaded history does not reach back that far.
 */
export function priorSessionClose(
  bars: ReadonlyArray<{ time: number; close: number }>,
  start: number,
  symbol: string | undefined,
  exchange: string | undefined,
): number | null {
  const futures = !!(symbol || exchange) && futuresSessionOpen(symbol ?? "", exchange) !== null;
  const canonical = canonicalExchange(exchange);
  for (let index = bars.length - 1; index >= 0; index -= 1) {
    const bar = bars[index]!;
    if (!(bar.time < start) || !Number.isFinite(bar.close)) continue;
    if (futures || isRegularSessionTime(canonical, bar.time) !== false) return bar.close;
  }
  return null;
}
