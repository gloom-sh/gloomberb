import { canonicalExchange, parsePublicTickerKey } from "./exchanges";
import { zonedDateKey, zonedDateTimeParts, zonedWallClockToUtcMs } from "./zoned-date-time";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const NEW_YORK = "America/New_York";

/** A spot currency pair: `=X` listing syntax (EURUSD=X, JPY=X) or the CCY venue. */
export function isCurrencyPairListing(symbol: string | undefined, exchange: string | undefined): boolean {
  return canonicalExchange(exchange) === "CCY" || (!!symbol && parsePublicTickerKey(symbol).symbol.endsWith("=X"));
}

const newYorkClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  hourCycle: "h23",
});

/** The spot FX week: Sunday 17:00 until Friday 17:00 New York time. */
export function isFxMarketOpen(time: number): boolean {
  if (!Number.isFinite(time)) return false;
  const parts = newYorkClock.formatToParts(new Date(time));
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  if (weekday === "Sat") return false;
  if (weekday === "Sun") return hour >= 17;
  if (weekday === "Fri") return hour < 17;
  return true;
}

/**
 * The FX trading day a print made at `time` belongs to, as "YYYY-MM-DD": the
 * day rolls at 17:00 New York time, so Wednesday 18:00 New York is
 * Thursday's. A print stamped exactly 17:00:00 is that day's close, so it is
 * still that day's.
 */
export function fxTradingDay(time: number): string {
  // The roll is 17:00, seven hours before New York's midnight, daylight saving or not.
  return zonedDateKey(time - 1 + 7 * HOUR_MS, NEW_YORK);
}

/**
 * The FX trading day of a print made at `time` (fxTradingDay), or null for a
 * print made while the market is shut: from just after Friday's 17:00 New
 * York close, whose own print still counts, through Sunday's 17:00 open. A
 * tick over the weekend belongs to no trading day.
 */
export function fxPrintTradingDay(time: number): string | null {
  return Number.isFinite(time) && isFxMarketOpen(time - 1) ? fxTradingDay(time) : null;
}

/**
 * The FX trading day the market is on at `time`: the day in progress while it
 * trades, or the Friday that closed it while it is shut.
 */
export function fxTradingDayAt(time: number): string | null {
  const day = fxPrintTradingDay(time);
  if (day != null || !Number.isFinite(time)) return day;
  const shut = currentFxClosureStart(time - 1);
  return shut != null ? fxTradingDay(shut) : null;
}

/** The latest 17:00 New York on `weekday` (0 is Sunday) at or before `time`. */
function latestNewYorkFivePm(time: number, weekday: number): number | null {
  if (!Number.isFinite(time)) return null;
  const { year, month, day } = zonedDateTimeParts(time, NEW_YORK);
  const today = Date.UTC(year, month - 1, day);
  for (let offset = 0; offset <= 7; offset += 1) {
    const date = new Date(today - offset * DAY_MS);
    if (date.getUTCDay() !== weekday) continue;
    const at = zonedWallClockToUtcMs(NEW_YORK, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), 17, 0, 0);
    if (at <= time) return at;
  }
  return null;
}

/** The latest close of the FX week, Friday 17:00 New York, at or before `time`. */
export function latestFxWeekClose(time: number): number | null {
  return latestNewYorkFivePm(time, 5);
}

/** The latest open of the FX week, Sunday 17:00 New York, at or before `time`. */
export function latestFxWeekOpen(time: number): number | null {
  return latestNewYorkFivePm(time, 0);
}

/**
 * How close to the FX week's close a print is its close: Gloom Cloud dates the
 * week's close by its last minute (20:59Z, or 21:59Z in winter).
 */
const FX_CLOSE_PRINT_MS = 60_000;

/** Whether a print made at `time` is the close of the FX week that closed at `weekClose`. */
export function isFxWeekClosePrint(time: number, weekClose: number): boolean {
  return time <= weekClose && time >= weekClose - FX_CLOSE_PRINT_MS;
}

/**
 * When a rate fetched at `fetchedAt` must be read again because it may stand
 * in for a close it is not: once the close of its FX week is out (the
 * week's close, `delayMs` later for a delayed feed). A rate fetched at 20:39Z
 * on a Friday is no close, yet the hours the market is shut do not age it
 * (fxFreshUntil), so until Sunday's open it stood in for Friday's close. The
 * week is the one `fetchedAt` falls in, not the one it is now, so the time is
 * the same whether it is asked on Friday or on Sunday. Infinity for a rate
 * that is that close (isFxWeekClosePrint).
 */
export function fxPreCloseRefetchAt(fetchedAt: number | undefined, observedAt: number | undefined, delayMs: number): number {
  if (fetchedAt == null || !Number.isFinite(fetchedAt)) return Infinity;
  const close = fxWeekCloseOf(fetchedAt, delayMs);
  if (close == null || (observedAt != null && isFxWeekClosePrint(observedAt, close))) return Infinity;
  return close + delayMs;
}

/**
 * The close of the FX week a rate fetched at `time` belongs to: the latest
 * one while its print may still be on its way (`delayMs`), else the next one.
 * The next close is a week on, give or take the hour a clock change moves it.
 */
function fxWeekCloseOf(time: number, delayMs: number): number | null {
  const latest = latestFxWeekClose(time);
  if (latest != null && time < latest + delayMs) return latest;
  for (const ahead of [7 * DAY_MS, 7 * DAY_MS + 2 * HOUR_MS]) {
    const close = latestFxWeekClose(time + ahead);
    if (close != null && close > time) return close;
  }
  return null;
}

/**
 * When the closure the market is in began (Friday 17:00 New York time); null
 * while it trades. That is `latestFxWeekClose` for every moment the week is
 * shut, since a closure never lasts to the next Friday, daylight saving weeks
 * included.
 */
export function currentFxClosureStart(time: number): number | null {
  return isFxMarketOpen(time) ? null : latestFxWeekClose(time);
}

/**
 * When an FX observation has aged `windowMs`, counting only time the market
 * is open. Friday's last print stays current over the weekend, while a rate
 * that stopped updating during the week still goes stale on schedule.
 */
export function fxFreshUntil(observedAt: number, windowMs: number): number {
  if (!Number.isFinite(observedAt)) return observedAt + windowMs;
  // New York offsets are whole hours and the week turns at 17:00, so the
  // market only opens or closes on a UTC hour.
  let time = observedAt;
  let remaining = windowMs;
  for (let step = 0; step < 24 * 14; step += 1) {
    const boundary = Math.floor(time / HOUR_MS) * HOUR_MS + HOUR_MS;
    if (isFxMarketOpen(time)) {
      if (time + remaining <= boundary) return time + remaining;
      remaining -= boundary - time;
    }
    time = boundary;
  }
  return time + remaining;
}
