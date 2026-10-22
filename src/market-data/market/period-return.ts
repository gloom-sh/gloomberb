import { calendarMonthsBefore } from "../../utils/calendar-date";
import { isAlwaysOpenExchange, latestRegularSessionClose, sessionCalendarTimeZone } from "./freshness";

/**
 * One convention for every period return (CMP, RETURN, the futures board,
 * sector and short-interest boards, the volatility curve's look-backs): a
 * period runs from the close on or before the same calendar date one period
 * before its end, and says so, `from Mon 21 Sep close`. A month before Wed 21
 * Oct is Mon 21 Sep, so 1M is measured from Mon 21 Sep's close; a month
 * before Tue 20 Oct is Sun 20 Sep, so from Fri 18 Sep's close.
 */
export type ReturnPeriod = "1W" | "1M" | "3M" | "6M" | "1Y" | "3Y" | "5Y" | "YTD";

const PERIOD_MONTHS: Readonly<Record<Exclude<ReturnPeriod, "1W" | "YTD">, number>> = { "1M": 1, "3M": 3, "6M": 6, "1Y": 12, "3Y": 36, "5Y": 60 };
const PERIODS: ReadonlySet<string> = new Set<ReturnPeriod>(["1W", "1M", "3M", "6M", "1Y", "3Y", "5Y", "YTD"]);
const DAY_MS = 86_400_000;

/**
 * How far before its base day a base close may be: a weekend with the longest
 * closures markets take (Spring Festival put TWSE's previous session twelve
 * days back in February 2026). A close further back is a gap in the history (a
 * halt, a listing that started later), so the period has no base.
 */
export const PERIOD_BASE_MAX_GAP_DAYS = 14;

/** What a period whose newest point is the session still trading says of that point. */
export const LATEST_INTRADAY_TEXT = "latest, intraday";

export function isReturnPeriod(value: unknown): value is ReturnPeriod {
  return typeof value === "string" && PERIODS.has(value);
}

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The calendar date a period ending on `endDay` (`YYYY-MM-DD`) is measured
 * from: seven days before for a week, the same day of the month before for a
 * month (31 Mar's is 28 or 29 Feb), and 31 Dec of the year before for YTD.
 */
export function periodBaseDay(endDay: string, period: ReturnPeriod): string {
  const day = endDay.slice(0, 10);
  if (period === "YTD") return `${Number(day.slice(0, 4)) - 1}-12-31`;
  if (period === "1W") return shiftDay(day, -7);
  return calendarMonthsBefore(new Date(`${day}T00:00:00Z`), PERIOD_MONTHS[period]).toISOString().slice(0, 10);
}

/**
 * The day a bar's close is from, to compare with a base day: a daily bar's own
 * date, a weekly bar's (dated by the Monday its week starts) Friday, or Sunday
 * at a venue that trades every day, a monthly bar's last day of the month.
 * `YYYY-MM-DD`.
 */
export function barCloseDay(day: string, interval?: string | null, venue?: string): string {
  const date = day.slice(0, 10);
  if (interval === "1wk") return shiftDay(date, venue && isAlwaysOpenExchange(venue) ? 6 : 4);
  if (interval === "1mo") {
    const start = new Date(`${date}T00:00:00Z`);
    return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  }
  return date;
}

/**
 * The index of the close a period is measured from among chronological
 * `days` (each close's day, barCloseDay): the last on or before `baseDay`,
 * at most `maxGapDays` before it. -1 when there is none, because the history
 * starts after the base day or has a gap there.
 */
export function periodBaseIndex(days: readonly string[], baseDay: string, maxGapDays = PERIOD_BASE_MAX_GAP_DAYS): number {
  const earliest = Number.isFinite(maxGapDays) ? shiftDay(baseDay, -maxGapDays) : "";
  for (let index = days.length - 1; index >= 0; index -= 1) {
    const day = days[index]!;
    if (day > baseDay) continue;
    return day >= earliest ? index : -1;
  }
  return -1;
}

export interface PeriodClose {
  /** The close's day, `YYYY-MM-DD`. */
  day: string;
  close: number;
}

export interface PeriodReturn {
  /** The calendar date the period is measured back to (periodBaseDay). */
  baseDay: string;
  /** The close it is measured from: the last on or before `baseDay`. */
  base: PeriodClose;
  /** The price it runs to: the newest close, or the live price given. */
  end: PeriodClose;
  /** The return in percent. */
  percent: number;
}

/**
 * A period return over chronological closes, from the close on or before
 * the base day (periodBaseIndex) to the newest close, or to `latest` when a
 * live price is given, dated by its session day. Null without a base, an end,
 * or a positive base close.
 */
export function periodReturn(
  closes: readonly PeriodClose[],
  period: ReturnPeriod,
  latest?: PeriodClose | null,
  maxGapDays = PERIOD_BASE_MAX_GAP_DAYS,
): PeriodReturn | null {
  const end = latest && Number.isFinite(latest.close) ? latest : closes.at(-1);
  if (!end) return null;
  const baseDay = periodBaseDay(end.day, period);
  const index = periodBaseIndex(closes.map((close) => close.day), baseDay, maxGapDays);
  const base = index < 0 ? null : closes[index]!;
  if (!base || !(base.close > 0) || !Number.isFinite(end.close)) return null;
  const percent = (end.close / base.close - 1) * 100;
  return Number.isFinite(percent) ? { baseDay, base, end, percent } : null;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** `Mon 21 Sep`, with the year when it is not `currentYear`'s: `Tue 21 Oct 2025`. */
export function periodDayText(day: string, currentYear: number): string {
  const date = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return day;
  const year = date.getUTCFullYear() === currentYear ? "" : ` ${date.getUTCFullYear()}`;
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}${year}`;
}

/** `from Mon 21 Sep close`: the close a period is measured from, as its output names it. */
export function periodBaseText(day: string, now = Date.now()): string {
  return `from ${periodDayText(day, new Date(now).getUTCFullYear())} close`;
}

/**
 * Whether a daily bar dated `day` is the session still trading at `venue`
 * at `now`: dated after the venue's latest closed session, or today's UTC
 * date for a venue that never closes. False where the venue's sessions are
 * unknown, which cannot tell.
 */
export function isIntradayDailyBar(day: string, venue: string | undefined, now: number): boolean {
  if (!venue || !Number.isFinite(now)) return false;
  if (isAlwaysOpenExchange(venue)) return day.slice(0, 10) === new Date(now).toISOString().slice(0, 10);
  if (!sessionCalendarTimeZone(venue)) return false;
  const last = latestRegularSessionClose(venue, now);
  return !!last && day.slice(0, 10) > last.date;
}
