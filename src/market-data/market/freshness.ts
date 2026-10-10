import type { MarketState } from "../../types/financials";
import { canonicalExchange, EXCHANGE_TIME_ZONES, isUsListingExchange } from "../../utils/exchanges";
import { hasPublishedApacCalendar, isPublishedApacClosure } from "../published-apac-sessions";
import { hasPublishedCnCalendar, isPublishedCnClosure } from "../published-cn-sessions";
import { hasPublishedJpxCalendar, isPublishedJpxClosure } from "../published-jpx-sessions";
import { hasPublishedNseCalendar, isPublishedNseClosure } from "../published-nse-sessions";
import { getPublishedUsEquityCalendarDay, getPublishedUsEquityCalendarYears, getPublishedUsEquitySession } from "../published-us-sessions";
import { quoteFutureToleranceMs } from "../quotes/clock";
import { zonedDateKey, zonedDateTimeParts, zonedWallClockToUtcMs } from "../../utils/zoned-date-time";

const ALWAYS_OPEN_EXCHANGES = new Set(["CCC"]);

/** Spot crypto venues have no equity open or close. */
export function isAlwaysOpenExchange(exchange: string | undefined): boolean {
  return ALWAYS_OPEN_EXCHANGES.has(canonicalExchange(exchange));
}
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const OVERNIGHT_CLOSE_MAX_AGE_MS = 20 * 60 * 60 * 1000;
const ALWAYS_OPEN_MAX_AGE_MS = 2 * 60 * 60 * 1000;
// Spring Festival can put the previous session twelve calendar days back
// (TWSE, February 2026).
const SESSION_LOOKBACK_DAYS = 14;
const REGULAR_OPEN_MINUTES: Record<string, number> = {
  NASDAQ: 9 * 60 + 30,
  NYSE: 9 * 60 + 30,
  ARCA: 9 * 60 + 30,
  AMEX: 9 * 60 + 30,
  BATS: 9 * 60 + 30,
  TSX: 9 * 60 + 30,
  TSXV: 9 * 60 + 30,
  CSE: 9 * 60 + 30,
  FWB2: 8 * 60,
  XETRA: 8 * 60,
  LSE: 8 * 60,
  EPA: 9 * 60,
  AMS: 9 * 60,
  BRU: 9 * 60,
  LIS: 8 * 60,
  BIT: 9 * 60,
  SFB: 9 * 60,
  HEL: 10 * 60,
  CPH: 9 * 60,
  JPX: 9 * 60,
  HKEX: 9 * 60 + 30,
  TWSE: 9 * 60,
  NSE: 9 * 60 + 15,
  // Continuous trading opens, as each venue publishes them, for the venues
  // whose closes are listed below.
  FWB: 8 * 60,
  SWX: 9 * 60,
  VIE: 9 * 60,
  OSL: 9 * 60,
  ICEX: 9 * 60 + 30,
  WSE: 9 * 60,
  PSE: 9 * 60,
  TPEX: 9 * 60,
  BSE: 9 * 60 + 15,
  ASX: 10 * 60,
  SGX: 9 * 60,
  KRX: 9 * 60,
  KOSDAQ: 9 * 60,
  NZX: 10 * 60,
  SSE: 9 * 60 + 30,
  SZSE: 9 * 60 + 30,
  BMV: 8 * 60 + 30,
  B3: 10 * 60,
  BYMA: 11 * 60,
  JSE: 9 * 60,
  // The opening auction ends at 10:00 and the feed stamps its first bar 09:59.
  TASE: 9 * 60 + 59,
  TADAWUL: 10 * 60,
  QE: 9 * 60 + 30,
  DFM: 10 * 60,
  KUWAIT: 9 * 60,
};
// Local regular close with the closing auction, rounded up. A close taken too
// early would let a copy fetched during the auction pass as final.
const REGULAR_CLOSE_MINUTES: Record<string, number> = {
  NASDAQ: 16 * 60, NYSE: 16 * 60, ARCA: 16 * 60, AMEX: 16 * 60, BATS: 16 * 60,
  TSX: 16 * 60, TSXV: 16 * 60, CSE: 16 * 60,
  FWB: 22 * 60, FWB2: 22 * 60, XETRA: 17 * 60 + 40, SWX: 17 * 60 + 40, VIE: 17 * 60 + 40,
  LSE: 16 * 60 + 40, EPA: 17 * 60 + 40, AMS: 17 * 60 + 40, BRU: 17 * 60 + 40, LIS: 17 * 60 + 40,
  BIT: 17 * 60 + 45, SFB: 17 * 60 + 40, HEL: 18 * 60 + 40, CPH: 17 * 60 + 10, OSL: 16 * 60 + 30,
  ICEX: 15 * 60 + 40, WSE: 17 * 60 + 10, PSE: 16 * 60 + 30,
  JPX: 15 * 60 + 30, HKEX: 16 * 60 + 10, TWSE: 14 * 60 + 30, TPEX: 14 * 60 + 30,
  NSE: 16 * 60, BSE: 16 * 60, ASX: 16 * 60 + 15, SGX: 17 * 60 + 20, KRX: 16 * 60, KOSDAQ: 16 * 60,
  NZX: 17 * 60, SSE: 15 * 60 + 30, SZSE: 15 * 60 + 30,
  BMV: 15 * 60 + 10, B3: 18 * 60 + 30, BYMA: 17 * 60 + 10, JSE: 17 * 60 + 15,
  // Monday to Thursday: trading at last ends 17:30, after the closing auction.
  // Not later: a complete 5-minute copy ends with its 17:09 bar, which must
  // reach the close less the half hour a history copy may lag.
  TASE: 17 * 60 + 30,
  // Continuous trading to 15:00, the closing auction to 15:10 and trading at
  // last to 15:20. A complete 5-minute copy ends with its 14:55 bar.
  TADAWUL: 15 * 60 + 20,
  // Continuous trading to 13:00, the closing auction to 13:10 and trading at
  // last to 13:15. A complete 5-minute copy ends with its 13:05 or 13:10 bar.
  QE: 13 * 60 + 15,
  // Continuous trading to 14:45, the closing auction to 14:55 and trading at
  // the close to 15:00. A complete 5-minute copy ends with its 14:55 bar.
  DFM: 15 * 60,
  // Boursa Kuwait: continuous trading to 13:00, the closing auction to 13:10
  // and trade at last to 13:15. Not later than the auction's end: a complete
  // 5-minute copy ends with its 12:40 bar (the source still closes its
  // period at 12:45), which must reach the close less the half hour a
  // history copy may lag.
  KUWAIT: 13 * 60 + 10,
};
// Venues whose week is not Monday to Friday, as their days off (0 is Sunday).
// Tadawul, Qatar and Boursa Kuwait trade Sunday to Thursday. Dubai's DFM has
// traded Monday to Friday since 2022, like the venues not listed here.
const WEEKEND_DAYS: Record<string, readonly number[]> = {
  TADAWUL: [5, 6],
  QE: [5, 6],
  KUWAIT: [5, 6],
};
const DEFAULT_WEEKEND_DAYS: readonly number[] = [0, 6];
// Venues whose regular session ends earlier on one weekday every week, as
// local minutes by weekday (0 is Sunday); the other days close as above. TASE
// has traded Monday to Friday since January 2026, and on Fridays trading at
// last ends 13:50 (closing auction 13:44 to 13:45). A complete 5-minute copy
// ends with its 13:29 bar. Holidays and the shortened days around Sukkot and
// Pesach are not weekly and are not listed.
const WEEKDAY_CLOSE_MINUTES: Record<string, Partial<Record<number, number>>> = {
  TASE: { 5: 13 * 60 + 50 },
};
// Venues that pause at midday, as local minutes [start, end), with a zone for
// those the session tables above do not cover. Jakarta pauses longer on Fridays.
const MIDDAY_BREAKS: Record<string, {
  timeZone?: string;
  weekdays: readonly [number, number];
  friday?: readonly [number, number];
}> = {
  HKEX: { weekdays: [12 * 60, 13 * 60] },
  SGX: { weekdays: [12 * 60, 13 * 60] },
  SSE: { weekdays: [11 * 60 + 30, 13 * 60] },
  SZSE: { weekdays: [11 * 60 + 30, 13 * 60] },
  JPX: { weekdays: [11 * 60 + 30, 12 * 60 + 30] },
  BURSAMY: { timeZone: "Asia/Kuala_Lumpur", weekdays: [12 * 60 + 30, 14 * 60 + 30] },
  JAKARTA: { timeZone: "Asia/Jakarta", weekdays: [12 * 60, 13 * 60 + 30], friday: [11 * 60 + 30, 14 * 60] },
};
// A morning print this close to the break is its last one, and afternoon
// prints are due this long after the feed's lag has passed the reopening.
const MIDDAY_BREAK_MARGIN_MS = 5 * 60_000;
// How far the delayed feed runs behind each venue's trades.
const DELAYED_FEED_LAG_MS = 15 * 60_000;
const SLOWER_DELAYED_FEED_LAG_MS = 20 * 60_000;
const SLOWER_DELAYED_FEEDS = new Set(["ASX", "KRX", "KOSDAQ", "TWSE", "TPEX", "SGX", "NZX"]);
const exchangeLocalTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const usSessionFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

type UsSessionState = Exclude<MarketState, never>;

// Every streamed tick asks for local dates and session states, and each
// Intl.DateTimeFormat call costs microseconds. Their inputs only matter to the
// minute (sessions and dates change on whole minutes), so answers are reused
// per minute and zone; the caches stay small across a day of streaming.
const MINUTE_CACHE_LIMIT = 4096;
const localDateCache = new Map<string, string | null>();
const localMinuteCache = new Map<string, number | null>();
const usSessionCache = new Map<number, UsSessionState>();

function perMinute<K, V>(cache: Map<K, V>, key: K, compute: () => V): V {
  const cached = cache.get(key);
  if (cached !== undefined || cache.has(key)) return cached as V;
  const value = compute();
  if (cache.size >= MINUTE_CACHE_LIMIT) cache.clear();
  cache.set(key, value);
  return value;
}

function getExchangeLocalTimeFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = exchangeLocalTimeFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    exchangeLocalTimeFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function exchangeLocalDate(exchange: string, timestampMs: number): string | null {
  const timeZone = EXCHANGE_TIME_ZONES[canonicalExchange(exchange)];
  if (!timeZone) return null;
  const minute = Math.floor(timestampMs / 60_000);
  return perMinute(localDateCache, `${timeZone}:${minute}`, () => zonedDateKey(minute * 60_000, timeZone));
}

function exchangeLocalMinuteOfDay(exchange: string, timestampMs: number): number | null {
  const timeZone = EXCHANGE_TIME_ZONES[canonicalExchange(exchange)];
  if (!timeZone) return null;
  const minute = Math.floor(timestampMs / 60_000);
  return perMinute(localMinuteCache, `${timeZone}:${minute}`, () => formatExchangeLocalMinuteOfDay(timeZone, minute * 60_000));
}

function formatExchangeLocalMinuteOfDay(timeZone: string, timestampMs: number): number | null {
  const parts = getExchangeLocalTimeFormatter(timeZone).formatToParts(new Date(timestampMs));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
}

function isBeforeKnownRegularOpen(exchange: string, timestampMs: number): boolean {
  const canonical = canonicalExchange(exchange);
  const openMinute = REGULAR_OPEN_MINUTES[canonical];
  const localMinute = exchangeLocalMinuteOfDay(canonical, timestampMs);
  return openMinute != null && localMinute != null && localMinute < openMinute;
}

function isoLocalDateToUtcDay(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;

  return Math.floor(Date.UTC(year, month - 1, day) / MS_PER_DAY);
}

function isPublishedClosure(exchange: string, date: string): boolean {
  if (exchange === "JPX") return isPublishedJpxClosure(date);
  if (exchange === "NSE" || exchange === "BSE") return isPublishedNseClosure(date);
  if (exchange === "SSE" || exchange === "SZSE") return isPublishedCnClosure(date);
  if (isPublishedApacClosure(exchange, date)) return true;
  return getPublishedUsEquityCalendarDay(exchange, date) === "closed";
}

/** Whether `weekday` (0 is Sunday) is in the venue's trading week. */
function isTradingWeekday(exchange: string, weekday: number): boolean {
  return !(WEEKEND_DAYS[exchange] ?? DEFAULT_WEEKEND_DAYS).includes(weekday);
}

function isLocalTradingDay(exchange: string, date: string): boolean {
  const weekday = localWeekday(date);
  return weekday != null && isTradingWeekday(exchange, weekday) && !isPublishedClosure(exchange, date);
}

/** Days of the venue's trading week in (earlier, later], less published closures for venues with a calendar. */
function localTradingDaysBetween(exchange: string, earlierDate: string, laterDate: string): number {
  const earlierDay = isoLocalDateToUtcDay(earlierDate);
  const laterDay = isoLocalDateToUtcDay(laterDate);
  if (earlierDay == null || laterDay == null || laterDay <= earlierDay) return 0;

  let sessions = 0;
  for (let day = earlierDay + 1; day <= laterDay; day += 1) {
    if (isLocalTradingDay(exchange, new Date(day * MS_PER_DAY).toISOString().slice(0, 10))) sessions += 1;
  }
  return sessions;
}

function localWeekday(date: string): number | null {
  const day = isoLocalDateToUtcDay(date);
  return day == null ? null : new Date(day * MS_PER_DAY).getUTCDay();
}

/** The local close of the venue's regular session on `date`, in minutes of the day. */
function regularCloseMinutes(exchange: string, date: string): number | undefined {
  const weekday = localWeekday(date);
  return (weekday == null ? undefined : WEEKDAY_CLOSE_MINUTES[exchange]?.[weekday]) ?? REGULAR_CLOSE_MINUTES[exchange];
}

/** The zone a venue's session dates are read in, or null when unknown. */
export function sessionCalendarTimeZone(exchange: string | undefined): string | null {
  const canonical = canonicalExchange(exchange);
  return EXCHANGE_TIME_ZONES[canonical]
    ?? (getPublishedUsEquityCalendarYears(canonical) ? "America/New_York" : null);
}

/**
 * The latest regular session that closed at or before `time`: the published
 * calendar for US venues, otherwise the days of the venue's trading week less
 * published closures. A venue without a known close hour is taken to close at
 * local midnight. Null for round-the-clock and unknown venues.
 */
export function latestRegularSessionClose(
  exchange: string | undefined,
  time: number,
): { date: string; close: number; timeZone: string } | null {
  const canonical = canonicalExchange(exchange);
  const timeZone = sessionCalendarTimeZone(canonical);
  if (!timeZone || ALWAYS_OPEN_EXCHANGES.has(canonical) || !Number.isFinite(time)) return null;
  const { year, month, day } = zonedDateTimeParts(time, timeZone);
  const today = Date.UTC(year, month - 1, day) / MS_PER_DAY;
  for (let offset = 0; offset <= SESSION_LOOKBACK_DAYS; offset++) {
    const date = new Date((today - offset) * MS_PER_DAY).toISOString().slice(0, 10);
    const published = getPublishedUsEquitySession(canonical, date);
    let close: number | null = null;
    if (published) {
      if (published.kind === "session") close = published.close;
    } else if (isLocalTradingDay(canonical, date)) {
      const minutes = regularCloseMinutes(canonical, date) ?? 24 * 60;
      close = zonedWallClockToUtcMs(timeZone, Number(date.slice(0, 4)), Number(date.slice(5, 7)),
        Number(date.slice(8, 10)), Math.floor(minutes / 60), minutes % 60, 0);
    }
    if (close != null && close <= time) return { date, close, timeZone };
  }
  return null;
}

/**
 * The UTC minute of the day the venue's regular session closed, for the latest
 * session at or before `time` (20:00 UTC is 1200 while New York is on daylight
 * time). Null for round-the-clock venues and for venues whose close hour is
 * not listed, which `latestRegularSessionClose` would take to close at local
 * midnight.
 */
export function regularSessionCloseUtcMinute(exchange: string | undefined, time: number): number | null {
  const canonical = canonicalExchange(exchange);
  if (REGULAR_CLOSE_MINUTES[canonical] === undefined) return null;
  const close = latestRegularSessionClose(canonical, time);
  return close ? Math.floor(close.close / 60_000) % 1440 : null;
}

/**
 * The open of the regular session `time` falls in, or of the latest one
 * before it: the published calendar for US venues, otherwise the venue's
 * local open on a day of its trading week that is not a published closure.
 * Null for round-the-clock venues and venues without a known open hour.
 */
export function latestRegularSessionOpen(exchange: string | undefined, time: number): number | null {
  const canonical = canonicalExchange(exchange);
  const timeZone = sessionCalendarTimeZone(canonical);
  if (!timeZone || ALWAYS_OPEN_EXCHANGES.has(canonical) || !Number.isFinite(time)) return null;
  const minutes = REGULAR_OPEN_MINUTES[canonical];
  const { year, month, day } = zonedDateTimeParts(time, timeZone);
  const today = Date.UTC(year, month - 1, day) / MS_PER_DAY;
  for (let offset = 0; offset <= SESSION_LOOKBACK_DAYS; offset++) {
    const date = new Date((today - offset) * MS_PER_DAY).toISOString().slice(0, 10);
    const published = getPublishedUsEquitySession(canonical, date);
    let open: number | null = null;
    if (published) {
      if (published.kind === "session") open = published.open;
    } else if (minutes === undefined) {
      return null;
    } else if (isLocalTradingDay(canonical, date)) {
      open = zonedWallClockToUtcMs(timeZone, Number(date.slice(0, 4)), Number(date.slice(5, 7)),
        Number(date.slice(8, 10)), Math.floor(minutes / 60), minutes % 60, 0);
    }
    if (open != null && open <= time) return open;
  }
  return null;
}

/**
 * The open of the first regular session after `time`, with its local date and
 * the venue's zone: the published calendar for US venues, otherwise the
 * venue's local open on the next day of its trading week that is not a
 * published closure. Null for round-the-clock venues and venues without a
 * known open hour.
 */
export function nextRegularSessionOpen(
  exchange: string | undefined,
  time: number,
): { date: string; open: number; timeZone: string } | null {
  const canonical = canonicalExchange(exchange);
  const timeZone = sessionCalendarTimeZone(canonical);
  if (!timeZone || ALWAYS_OPEN_EXCHANGES.has(canonical) || !Number.isFinite(time)) return null;
  const minutes = REGULAR_OPEN_MINUTES[canonical];
  const { year, month, day } = zonedDateTimeParts(time, timeZone);
  const today = Date.UTC(year, month - 1, day) / MS_PER_DAY;
  for (let offset = 0; offset <= SESSION_LOOKBACK_DAYS; offset++) {
    const date = new Date((today + offset) * MS_PER_DAY).toISOString().slice(0, 10);
    const published = getPublishedUsEquitySession(canonical, date);
    let open: number | null = null;
    if (published) {
      if (published.kind === "session") open = published.open;
    } else if (minutes === undefined) {
      return null;
    } else if (isLocalTradingDay(canonical, date)) {
      open = zonedWallClockToUtcMs(timeZone, Number(date.slice(0, 4)), Number(date.slice(5, 7)),
        Number(date.slice(8, 10)), Math.floor(minutes / 60), minutes % 60, 0);
    }
    if (open != null && open > time) return { date, open, timeZone };
  }
  return null;
}

/**
 * Whether `time` is inside a regular session: at or after its open and
 * before its close. Null for venues without known hours.
 */
export function isRegularSessionTime(exchange: string | undefined, time: number): boolean | null {
  const open = latestRegularSessionOpen(exchange, time);
  if (open === null) return null;
  // Before this session's close, the latest close is still the one before it opened.
  const close = latestRegularSessionClose(exchange, time);
  return !close || close.close < open;
}

/**
 * True when the venue's full-day closures for the year of `date` are
 * published: US venues, JPX, NSE, BSE, SSE, SZSE, KRX, KOSDAQ, TWSE, TPEX,
 * HKEX, SGX and ASX. Elsewhere a local holiday reads as a trading day.
 */
export function hasPublishedSessionCalendar(exchange: string | undefined, date: string): boolean {
  const canonical = canonicalExchange(exchange);
  const year = Number(date.slice(0, 4));
  if (canonical === "JPX") return hasPublishedJpxCalendar(year);
  if (canonical === "NSE" || canonical === "BSE") return hasPublishedNseCalendar(year);
  if (canonical === "SSE" || canonical === "SZSE") return hasPublishedCnCalendar(year);
  if (hasPublishedApacCalendar(canonical, year)) return true;
  return !!getPublishedUsEquityCalendarYears(canonical)?.includes(year);
}

/** How far the delayed feed runs behind the venue's trades. */
export function delayedFeedLagMs(exchange: string | undefined): number {
  return SLOWER_DELAYED_FEEDS.has(canonicalExchange(exchange)) ? SLOWER_DELAYED_FEED_LAG_MS : DELAYED_FEED_LAG_MS;
}

/**
 * Whether a print is still the current price because the venue is paused at
 * midday: `now` falls in the break, or within the feed's lag plus five
 * minutes after it, and the print is the morning's last, no earlier than five
 * minutes before the break started. An earlier morning print means the feed
 * stopped before the break.
 */
export function isMiddayBreakPrint(
  timestampMs: number,
  exchange: string | undefined,
  now: number,
  feedLagMs: number,
): boolean {
  const canonical = canonicalExchange(exchange);
  const pause = MIDDAY_BREAKS[canonical];
  const timeZone = pause?.timeZone ?? EXCHANGE_TIME_ZONES[canonical];
  if (!pause || !timeZone || !Number.isFinite(timestampMs) || !Number.isFinite(now) || timestampMs > now) return false;
  const { year, month, day } = zonedDateTimeParts(now, timeZone);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  if (!isTradingWeekday(canonical, weekday)) return false;
  const [start, end] = weekday === 5 && pause.friday ? pause.friday : pause.weekdays;
  const at = (minutes: number) => zonedWallClockToUtcMs(timeZone, year, month, day, Math.floor(minutes / 60), minutes % 60, 0);
  const breakStart = at(start);
  return now >= breakStart && now <= at(end) + feedLagMs + MIDDAY_BREAK_MARGIN_MS
    && timestampMs >= breakStart - MIDDAY_BREAK_MARGIN_MS;
}

function usSessionState(timestampMs: number): UsSessionState {
  const minute = Math.floor(timestampMs / 60_000);
  return perMinute(usSessionCache, minute, () => formatUsSessionState(minute * 60_000));
}

function formatUsSessionState(timestampMs: number): UsSessionState {
  const parts = usSessionFormatter.formatToParts(new Date(timestampMs));

  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
  if (weekday === "Sat" || weekday === "Sun") return "CLOSED";

  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  const totalMinutes = hour * 60 + minute;

  if (totalMinutes < 4 * 60) return "PREPRE";
  if (totalMinutes < 9 * 60 + 30) return "PRE";
  if (totalMinutes < 16 * 60) return "REGULAR";
  if (totalMinutes < 20 * 60) return "POST";
  return "POSTPOST";
}

/** Provider session labels may outlive the active session they described. */
export function activeUsMarketSession(now: number): "PRE" | "REGULAR" | "POST" | null {
  if (!Number.isFinite(new Date(now).getTime())) return null;
  const session = usSessionState(now);
  return session === "PRE" || session === "REGULAR" || session === "POST" ? session : null;
}

export function activeUsExtendedHoursSession(now: number): "PRE" | "POST" | null {
  const session = activeUsMarketSession(now);
  return session === "PRE" || session === "POST" ? session : null;
}

/**
 * Before any pre-market trade, a US quote's last print is the previous
 * session's close, and that close is the current price (a source may also stamp a
 * pre-market quote with that regular-session time). The provider must have
 * observed this pre-market session and the print must be from the session
 * immediately before today, at or after its regular open. An earlier print that
 * day is that session's own pre-market, not a close.
 */
export function isUsPriorSessionPremarketQuote(
  timestampMs: number,
  exchange: string | undefined,
  marketState: MarketState | undefined,
  now = Date.now(),
): boolean {
  const canonical = canonicalExchange(exchange);
  if (marketState !== "PRE" || !isUsListingExchange(canonical)) return false;
  if (!Number.isFinite(timestampMs) || !Number.isFinite(now) || timestampMs > now + quoteFutureToleranceMs()) return false;
  if (!Number.isFinite(new Date(now).getTime()) || usSessionState(now) !== "PRE") return false;
  const timestampDate = exchangeLocalDate(canonical, timestampMs);
  const currentDate = exchangeLocalDate(canonical, now);
  if (!timestampDate || !currentDate || timestampDate >= currentDate) return false;
  if (!isLocalTradingDay(canonical, timestampDate)) return false;
  const printSession = usSessionState(timestampMs);
  if (printSession !== "REGULAR" && printSession !== "POST" && printSession !== "POSTPOST") return false;
  return localTradingDaysBetween(canonical, timestampDate, currentDate) === 1;
}

/**
 * After the regular close and before any after-hours trade, a US quote's last
 * print is today's regular session, and that close is the current price: a thin
 * listing may not trade again tonight, and for fifteen minutes after the close
 * the delayed feed still shows the session's last minutes. The source labels
 * the quote POST (or CLOSED) and has no after-hours price to show. The print
 * must be from today's New York trading day, from the regular open through the
 * regular close (the published early close included). An earlier day's print
 * or this morning's pre-market is not today's close.
 */
export function isUsRegularCloseQuoteInPostSession(
  timestampMs: number,
  exchange: string | undefined,
  marketState: MarketState | undefined,
  now = Date.now(),
): boolean {
  const canonical = canonicalExchange(exchange);
  if ((marketState !== "POST" && marketState !== "CLOSED") || !isUsListingExchange(canonical)) return false;
  if (!Number.isFinite(timestampMs) || !Number.isFinite(now) || timestampMs > now + quoteFutureToleranceMs()) return false;
  if (!Number.isFinite(new Date(now).getTime()) || usSessionState(now) !== "POST") return false;
  const currentDate = exchangeLocalDate(canonical, now);
  if (!currentDate || exchangeLocalDate(canonical, timestampMs) !== currentDate) return false;
  if (!isLocalTradingDay(canonical, currentDate)) return false;
  const published = getPublishedUsEquitySession(canonical, currentDate);
  if (published) return published.kind === "session" && timestampMs >= published.open && timestampMs <= published.close;
  return usSessionState(timestampMs) === "REGULAR";
}

/**
 * Whether a US print belongs to the extended-hours session the source labels,
 * or to the regular session it extends. POST, after today's regular close (a
 * published early close included) and before 20:00: a print from today's
 * regular session or its after-hours. PRE, before today's open: a print from
 * the previous regular session or since, so its after-hours or this morning's
 * pre-market. An earlier print is not, and neither is any print on a day
 * without a session.
 */
export function isUsExtendedHoursSessionPrint(
  timestampMs: number,
  exchange: string | undefined,
  marketState: MarketState | undefined,
  now = Date.now(),
): boolean {
  const canonical = canonicalExchange(exchange);
  if ((marketState !== "PRE" && marketState !== "POST") || !isUsListingExchange(canonical)) return false;
  if (!Number.isFinite(timestampMs) || !Number.isFinite(now) || timestampMs > now + quoteFutureToleranceMs()) return false;
  if (!Number.isFinite(new Date(now).getTime())) return false;
  const today = exchangeLocalDate(canonical, now);
  const close = latestRegularSessionClose(canonical, now);
  if (!today || !close || !isLocalTradingDay(canonical, today)) return false;
  const session = usSessionState(now);
  const closedToday = close.date === today;
  if (marketState === "POST" ? !closedToday || (session !== "REGULAR" && session !== "POST") : closedToday || session !== "PRE") {
    return false;
  }
  // The open of the session that closed last: today's after the close, the previous one before the open.
  const open = latestRegularSessionOpen(canonical, close.close);
  return open != null && timestampMs >= open;
}

export function isTimestampStaleForExchangeSession(
  timestampMs: number,
  exchange?: string,
  now = Date.now(),
  marketState?: MarketState,
): boolean {
  try {
    return isTimestampStaleForExchangeSessionUnsafe(timestampMs, exchange, now, marketState);
  } catch {
    return true;
  }
}

function isTimestampStaleForExchangeSessionUnsafe(
  timestampMs: number,
  exchange?: string,
  now = Date.now(),
  marketState?: MarketState,
): boolean {
  const canonical = canonicalExchange(exchange);
  if (!canonical || !Number.isFinite(timestampMs) || !Number.isFinite(now)) return false;

  if (ALWAYS_OPEN_EXCHANGES.has(canonical)) {
    return now - timestampMs > ALWAYS_OPEN_MAX_AGE_MS;
  }

  const timestampDate = exchangeLocalDate(canonical, timestampMs);
  const currentDate = exchangeLocalDate(canonical, now);
  if (!timestampDate || !currentDate || timestampDate === currentDate) return false;
  if (marketState === "REGULAR" && !isBeforeKnownRegularOpen(canonical, now)) return true;

  if (isUsPriorSessionPremarketQuote(timestampMs, canonical, marketState, now)) return false;
  if (isUsListingExchange(canonical)) {
    const session = usSessionState(now);
    if (session === "PRE" || session === "REGULAR" || session === "POST" || session === "POSTPOST") {
      return true;
    }
  }

  const sessionsBehind = localTradingDaysBetween(canonical, timestampDate, currentDate);
  if (sessionsBehind > 1) return true;
  if (sessionsBehind === 1 && now - timestampMs > OVERNIGHT_CLOSE_MAX_AGE_MS) {
    // When today is the first session after a weekend or exchange holiday,
    // the last close stays current until the provider reports the new session.
    const calendarDaysBehind = isoLocalDateToUtcDay(currentDate)! - isoLocalDateToUtcDay(timestampDate)!;
    return !(isLocalTradingDay(canonical, currentDate) && (calendarDaysBehind > 1 || localWeekday(currentDate) === 1));
  }
  return false;
}
