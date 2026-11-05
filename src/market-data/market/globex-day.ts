import { canonicalExchange } from "../../utils/exchanges";
import { zonedDateTimeParts } from "../../utils/zoned-date-time";
import { hasPublishedFuturesCalendar, isPublishedFuturesClosure } from "../published-futures-sessions";
import { getPublishedUsEquitySession } from "../published-us-sessions";
import { futuresWeekendClosure } from "./futures-week";

const MS_PER_DAY = 86_400_000;
const ZONE = "America/Chicago";
/** CME Globex's day runs from 17:00 Central to 16:00 the next day; the hour between is its daily break. */
const BREAK_START_MINUTES = 16 * 60;
const BREAK_END_MINUTES = 17 * 60;
const GLOBEX_VENUES = new Set(["CME", "CBT", "NYM", "CMX"]);

const isoDay = (day: number) => new Date(day * MS_PER_DAY).toISOString().slice(0, 10);

/** A weekday US equities close or close early on: Globex's hours around it vary by contract. */
function isUsHolidayOrEarlyClose(date: string): boolean | null {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const session = getPublishedUsEquitySession("NYSE", date);
  if (!session) return null;
  return session.kind === "closed" || zonedDateTimeParts(session.close, "America/New_York").hour < 16;
}

/**
 * Whether CME Globex is open at `time` for a contract that trades its whole
 * day, 17:00 Central to 16:00 the next day from Sunday evening to Friday
 * afternoon (equity index, rates, energy, metals and FX: cmegroup.com
 * /trading-hours), by the clock and not by the contract's latest print, which
 * a delayed feed only shows a quarter of an hour after the 17:00 reopen.
 * False in the daily break and over the weekend. Null for a venue that is not
 * Globex, and on a day the calendar cannot vouch for: a trade date CME Group
 * has not published or holds no session on, and a US holiday or early close,
 * whose Globex hours vary by contract; the quote's own state says those.
 */
export function globexDayOpen(exchange: string | undefined, time: number): boolean | null {
  const venue = canonicalExchange(exchange);
  if (!GLOBEX_VENUES.has(venue) || !Number.isFinite(time)) return null;
  if (futuresWeekendClosure(venue, time)) return false;
  const { year, month, day, hour, minute } = zonedDateTimeParts(time, ZONE);
  const minutes = hour * 60 + minute;
  if (minutes >= BREAK_START_MINUTES && minutes < BREAK_END_MINUTES) return false;
  const local = Date.UTC(year, month - 1, day) / MS_PER_DAY;
  // From 17:00 the trades are booked on the next trade date.
  const tradeDate = isoDay(minutes >= BREAK_END_MINUTES ? local + 1 : local);
  if (!hasPublishedFuturesCalendar(venue, tradeDate) || isPublishedFuturesClosure(venue, tradeDate)) return null;
  for (const date of new Set([isoDay(local), tradeDate])) {
    const unusual = isUsHolidayOrEarlyClose(date);
    if (unusual !== false) return null;
  }
  return true;
}

/** Central time the day session opens (08:30): until then the night that opened the trade date is still trading. */
const DAY_SESSION_MINUTES = 8 * 60 + 30;

/**
 * The CME Globex trade date a print at `time` is booked on, and whether it
 * came in the overnight hours that opened that date: from 17:00 Central the
 * day before (Sunday's for Monday's) to the 08:30 day open, before the
 * previous session's settlement is confirmed. Null off Globex or without a
 * time. Weekends roll forward; holidays are the caller's calendar to apply.
 */
export function globexPrintSession(exchange: string | null | undefined, time: number | null | undefined): { tradeDate: string; overnight: boolean } | null {
  const venue = canonicalExchange(exchange ?? undefined);
  if (!GLOBEX_VENUES.has(venue) || time == null || !Number.isFinite(time) || time <= 0) return null;
  const { year, month, day, hour, minute } = zonedDateTimeParts(time, ZONE);
  const local = Date.UTC(year, month - 1, day) / MS_PER_DAY;
  const minutes = hour * 60 + minute;
  let trade = minutes >= BREAK_END_MINUTES ? local + 1 : local;
  while (new Date(trade * MS_PER_DAY).getUTCDay() % 6 === 0) trade += 1;
  return { tradeDate: isoDay(trade), overnight: trade > local || minutes < DAY_SESSION_MINUTES };
}
