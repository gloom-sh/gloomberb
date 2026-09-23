import type { MarketState } from "../../types/financials";
import { canonicalExchange, EXCHANGE_TIME_ZONES } from "../../utils/exchanges";
import { isPublishedJpxClosure } from "../published-jpx-sessions";
import { getPublishedUsEquityCalendarDay, getPublishedUsEquityCalendarYears, getPublishedUsEquitySession } from "../published-us-sessions";
import { quoteFutureToleranceMs } from "../quotes/clock";
import { zonedDateTimeParts, zonedWallClockToUtcMs } from "../../utils/zoned-date-time";

const US_EXTENDED_HOURS_EXCHANGES = new Set(["NASDAQ", "NYSE", "AMEX", "ARCA", "BATS"]);
const ALWAYS_OPEN_EXCHANGES = new Set(["CCC"]);
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const OVERNIGHT_CLOSE_MAX_AGE_MS = 20 * 60 * 60 * 1000;
const ALWAYS_OPEN_MAX_AGE_MS = 2 * 60 * 60 * 1000;
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
  BMV: 15 * 60 + 10, B3: 18 * 60 + 30, BYMA: 17 * 60 + 10, JSE: 17 * 60 + 15, TASE: 17 * 60 + 40,
};
const exchangeLocalDateFormatters = new Map<string, Intl.DateTimeFormat>();
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

function isUsExtendedHoursExchange(exchange?: string): boolean {
  return US_EXTENDED_HOURS_EXCHANGES.has(canonicalExchange(exchange));
}

function getExchangeLocalDateFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = exchangeLocalDateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    exchangeLocalDateFormatters.set(timeZone, formatter);
  }
  return formatter;
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
  return perMinute(localDateCache, `${timeZone}:${minute}`, () => formatExchangeLocalDate(timeZone, minute * 60_000));
}

function formatExchangeLocalDate(timeZone: string, timestampMs: number): string | null {
  const parts = getExchangeLocalDateFormatter(timeZone).formatToParts(new Date(timestampMs));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
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
  return exchange === "JPX" ? isPublishedJpxClosure(date) : getPublishedUsEquityCalendarDay(exchange, date) === "closed";
}

function isLocalTradingDay(exchange: string, date: string): boolean {
  const weekday = localWeekday(date);
  return weekday != null && weekday !== 0 && weekday !== 6 && !isPublishedClosure(exchange, date);
}

/** Weekdays in (earlier, later], less published closures for venues with a calendar. */
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

/**
 * The latest regular session that closed at or before `time`: the published
 * calendar for US venues, otherwise local weekdays less published closures. A
 * venue without a known close hour is taken to close at local midnight. Null
 * for round-the-clock and unknown venues.
 */
export function latestRegularSessionClose(
  exchange: string | undefined,
  time: number,
): { date: string; close: number; timeZone: string } | null {
  const canonical = canonicalExchange(exchange);
  const timeZone = EXCHANGE_TIME_ZONES[canonical]
    ?? (getPublishedUsEquityCalendarYears(canonical) ? "America/New_York" : undefined);
  if (!timeZone || ALWAYS_OPEN_EXCHANGES.has(canonical) || !Number.isFinite(time)) return null;
  const { year, month, day } = zonedDateTimeParts(time, timeZone);
  const today = Date.UTC(year, month - 1, day) / MS_PER_DAY;
  for (let offset = 0; offset <= 10; offset++) {
    const date = new Date((today - offset) * MS_PER_DAY).toISOString().slice(0, 10);
    const published = getPublishedUsEquitySession(canonical, date);
    let close: number | null = null;
    if (published) {
      if (published.kind === "session") close = published.close;
    } else if (isLocalTradingDay(canonical, date)) {
      const minutes = REGULAR_CLOSE_MINUTES[canonical] ?? 24 * 60;
      close = zonedWallClockToUtcMs(timeZone, Number(date.slice(0, 4)), Number(date.slice(5, 7)),
        Number(date.slice(8, 10)), Math.floor(minutes / 60), minutes % 60, 0);
    }
    if (close != null && close <= time) return { date, close, timeZone };
  }
  return null;
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
 * session's close, and that close is the current price (Yahoo also stamps a
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
  if (marketState !== "PRE" || !isUsExtendedHoursExchange(canonical)) return false;
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
  if (isUsExtendedHoursExchange(canonical)) {
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
