/** Subtract calendar months in UTC, clamping an unavailable day to the target month's last day. */
export function calendarMonthsBefore(date: Date, months: number): Date {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() - months);
  const last = new Date(result);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  result.setUTCDate(Math.min(day, last.getUTCDate()));
  return result;
}

/** The UTC calendar date `years` and `days` before `now`, as YYYY-MM-DD; a day that does not exist rolls forward. */
function isoDateBefore(now: Date, years: number, days: number): string {
  return new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate() - days))
    .toISOString()
    .slice(0, 10);
}

/** Today's UTC calendar date as YYYY-MM-DD. */
export function isoDateToday(now = new Date()): string {
  return isoDateBefore(now, 0, 0);
}

export function isoDateDaysAgo(days: number, now = new Date()): string {
  return isoDateBefore(now, 0, days);
}

export function isoDateYearsAgo(years: number, now = new Date()): string {
  return isoDateBefore(now, years, 0);
}

/** YYYY-MM-DD for a day the calendar has; null for a month or day out of range. */
function calendarDay(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date.toISOString().slice(0, 10)
    : null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A day and a month in either order, then a four-digit year, with one separator throughout: 14/10/2026, 14.10.2026, 14-10-2026. */
const YEAR_LAST = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})$/;
/** A four-digit year first, written another way than YYYY-MM-DD: 2026/10/14, 2026.10.14, 2026-10-4. */
const YEAR_FIRST = /^(\d{4})([/.-])(\d{1,2})\2(\d{1,2})$/;

/**
 * The YYYY-MM-DD date that a date written another way names: 14/10/2026 and
 * 10/14/2026 are 2026-10-14, since a part over 12 can only be the day. When
 * both parts could be the month (03/04/2026), only dots are read, day first,
 * as dotted dates are written (`assumedDayFirst`); a slash or a dash is
 * written both ways round, so that is null. Null as well for text that is not
 * a date of the calendar.
 */
function isoDateReading(value: string): { date: string; assumedDayFirst: boolean } | null {
  const text = value.trim();
  const yearFirst = YEAR_FIRST.exec(text);
  if (yearFirst) {
    const date = calendarDay(Number(yearFirst[1]), Number(yearFirst[3]), Number(yearFirst[4]));
    return date && date !== text ? { date, assumedDayFirst: false } : null;
  }
  const yearLast = YEAR_LAST.exec(text);
  if (!yearLast) return null;
  const [first, second, year] = [Number(yearLast[1]), Number(yearLast[3]), Number(yearLast[4])];
  const monthFirst = first <= 12 && second > 12;
  const either = first <= 12 && second <= 12 && first !== second;
  if (either && yearLast[2] !== ".") return null;
  const date = monthFirst ? calendarDay(year, first, second) : calendarDay(year, second, first);
  return date ? { date, assumedDayFirst: either } : null;
}

/**
 * A date option's value, checked before any request is made: YYYY-MM-DD as
 * typed, or an error that names the format. A date written another way gets
 * the option to type instead (`--from 2026-10-14` for 14/10/2026); one whose
 * day and month could be either way round gets an example of the format. An
 * empty value is no date.
 */
export function isoDateOption(value: string, flag: string, now = new Date()): string {
  const text = value.trim();
  const iso = ISO_DATE.exec(text);
  if (!text || (iso && calendarDay(Number(iso[1]), Number(iso[2]), Number(iso[3])))) return text;
  const format = `Use a --${flag} date in YYYY-MM-DD format`;
  const reading = isoDateReading(text);
  if (reading) throw new Error(`${format}: type --${flag} ${reading.date} for ${text}${reading.assumedDayFirst ? " (day first)" : ""}.`);
  throw new Error(`${format}, such as --${flag} ${isoDateToday(now)}.`);
}
