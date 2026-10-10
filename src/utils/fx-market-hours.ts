import { canonicalExchange, parsePublicTickerKey } from "./exchanges";
import { zonedDateTimeParts, zonedWallClockToUtcMs } from "./zoned-date-time";

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

/** The latest close of the FX week, Friday 17:00 New York, at or before `time`. */
export function latestFxWeekClose(time: number): number | null {
  if (!Number.isFinite(time)) return null;
  const { year, month, day } = zonedDateTimeParts(time, NEW_YORK);
  const today = Date.UTC(year, month - 1, day);
  for (let offset = 0; offset <= 7; offset += 1) {
    const date = new Date(today - offset * DAY_MS);
    if (date.getUTCDay() !== 5) continue;
    const close = zonedWallClockToUtcMs(NEW_YORK, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), 17, 0, 0);
    if (close <= time) return close;
  }
  return null;
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
