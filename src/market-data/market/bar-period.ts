import { zonedDateKey } from "../../utils/zoned-date-time";
import {
  isAlwaysOpenExchange,
  isRegularSessionTime,
  latestRegularSessionClose,
  nextRegularSessionOpen,
  sessionCalendarTimeZone,
} from "./freshness";

/** The calendar period a weekly or monthly bar covers. */
export type BarPeriod = "week" | "month";

/** A bar whose period had not ended when it was served, and how far into it the bar runs. */
export interface BarPeriodToDate {
  period: BarPeriod;
  /**
   * The last day the bar covers so far, `YYYY-MM-DD` at its venue: the latest
   * session that closed in the period, or today while a session trades (every
   * day for a coin). Null when the venue's sessions are unknown.
   */
  through: string | null;
}

const DAY_MS = 24 * 60 * 60_000;

function utcDate(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * The first day after the calendar period a bar dated `date` falls in: the
 * next month's 1st, or the Monday after its week. Weekly bars are dated by
 * the Monday their week starts, a holiday Monday included (Labor Day week's
 * is 7 Sep 2026), and on every venue, Sunday-to-Thursday ones too; a bar
 * dated by its week's first session (Tue 8 Sep) is read in the same week.
 */
function periodEnd(date: string, period: BarPeriod): string | null {
  const start = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(start)) return null;
  const day = new Date(start);
  if (period === "week") return utcDate(start + (7 - (day.getUTCDay() + 6) % 7) * DAY_MS);
  return utcDate(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 1));
}

/**
 * Whether the weekly or monthly bar dated `date` (in its period, periodEnd)
 * was still forming at `now`, and through which day: October's monthly bar
 * on Fri 16 Oct before the open runs through Thu 15 Oct. It forms while its
 * venue trades a regular session in the period or has one still to come in
 * it, so October's bar is complete once the last session of October closes,
 * though the month runs on. A coin trades every day, so its bar forms until
 * the period's last UTC day ends. A venue whose sessions are unknown is read
 * by the calendar alone, with no day to name. Null for a complete bar.
 */
export function barPeriodToDate(date: string, period: BarPeriod, venue: string | undefined, now: number): BarPeriodToDate | null {
  const start = date.slice(0, 10);
  const end = periodEnd(start, period);
  if (!end || !Number.isFinite(now)) return null;
  const timeZone = venue && !isAlwaysOpenExchange(venue) && latestRegularSessionClose(venue, now) ? sessionCalendarTimeZone(venue) : null;
  if (!timeZone) {
    const today = utcDate(now);
    if (today >= end) return null;
    return { period, through: venue && isAlwaysOpenExchange(venue) && today >= start ? today : null };
  }
  const today = zonedDateKey(now, timeZone);
  if (isRegularSessionTime(venue, now) && today >= start && today < end) return { period, through: today };
  const next = nextRegularSessionOpen(venue, now);
  if (!next || next.date >= end) return null;
  const close = latestRegularSessionClose(venue, now);
  return { period, through: close && close.date >= start && close.date < end ? close.date : null };
}
