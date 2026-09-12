import type { MarketState } from "../../types/financials";
import { canonicalExchange, EXCHANGE_TIME_ZONES } from "../../utils/exchanges";

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

function localWeekdaysBetween(earlierDate: string, laterDate: string): number {
  const earlierDay = isoLocalDateToUtcDay(earlierDate);
  const laterDay = isoLocalDateToUtcDay(laterDate);
  if (earlierDay == null || laterDay == null || laterDay <= earlierDay) return 0;

  let weekdays = 0;
  for (let day = earlierDay + 1; day <= laterDay; day += 1) {
    const weekday = new Date(day * MS_PER_DAY).getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      weekdays += 1;
    }
  }
  return weekdays;
}

function localWeekday(date: string): number | null {
  const day = isoLocalDateToUtcDay(date);
  return day == null ? null : new Date(day * MS_PER_DAY).getUTCDay();
}

function usSessionState(timestampMs: number): UsSessionState {
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

  if (isUsExtendedHoursExchange(canonical)) {
    const session = usSessionState(now);
    if (session === "PRE" || session === "REGULAR" || session === "POST" || session === "POSTPOST") {
      return true;
    }
  }

  const weekdaysBehind = localWeekdaysBetween(timestampDate, currentDate);
  if (weekdaysBehind > 1) return true;
  if (weekdaysBehind === 1 && now - timestampMs > OVERNIGHT_CLOSE_MAX_AGE_MS) {
    return localWeekday(currentDate) !== 1;
  }
  return false;
}
