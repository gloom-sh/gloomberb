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
/** The day written day first with dots, as most of Europe writes it: 14.10.2026, 1.10.2026. */
const DOTTED = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;
/** The month named before the day: Oct 14 2026, October 14, 2026, Sept. 1st 2026. */
const MONTH_FIRST = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i;
/** The day before the named month: 14 Oct 2026, 1st October, 2026. */
const DAY_FIRST = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?,?\s+(\d{4})$/i;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** The formats a date option takes, as its error lists them. */
export const DATE_OPTION_FORMATS = "YYYY-MM-DD, DD.MM.YYYY, Oct 14 2026 or 14 October 2026";

/** 1 to 12 for a month's name or its first three letters (Sept too); null for any other word. */
function monthNumber(name: string): number | null {
  const word = name.toLowerCase();
  const index = MONTHS.findIndex((month) => month === word || (word.length === 3 && month.startsWith(word)) || (word === "sept" && month === "september"));
  return index < 0 ? null : index + 1;
}

/**
 * A date as people type it, as YYYY-MM-DD: YYYY-MM-DD itself, DD.MM.YYYY
 * (dots are written day first), and the month named on either side of the
 * day (Oct 14 2026, 14 October 2026). Null for anything else, and for a day
 * the calendar does not have. A slash is written both ways round (10/14 in
 * the US, 14/10 in Europe), so a slashed date is never read as one.
 */
export function readCalendarDate(value: string): string | null {
  const text = value.trim().replace(/\s+/g, " ");
  const iso = ISO_DATE.exec(text);
  if (iso) return calendarDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const dotted = DOTTED.exec(text);
  if (dotted) return calendarDay(Number(dotted[3]), Number(dotted[2]), Number(dotted[1]));
  const monthFirst = MONTH_FIRST.exec(text);
  if (monthFirst) {
    const month = monthNumber(monthFirst[1]!);
    return month ? calendarDay(Number(monthFirst[3]), month, Number(monthFirst[2])) : null;
  }
  const dayFirst = DAY_FIRST.exec(text);
  if (dayFirst) {
    const month = monthNumber(dayFirst[2]!);
    return month ? calendarDay(Number(dayFirst[3]), month, Number(dayFirst[1])) : null;
  }
  return null;
}

/**
 * The YYYY-MM-DD date that a date written another way plainly names, to
 * offer as the one to type: 14/10/2026 and 10/14/2026 are 2026-10-14, since a
 * part over 12 can only be the day, and 2026/10/14 is too. Null when both
 * parts could be the month (03/04/2026), and for text that is not a date of
 * the calendar.
 */
function isoDateReading(value: string): string | null {
  const text = value.trim();
  const yearFirst = YEAR_FIRST.exec(text);
  if (yearFirst) return calendarDay(Number(yearFirst[1]), Number(yearFirst[3]), Number(yearFirst[4]));
  const yearLast = YEAR_LAST.exec(text);
  if (!yearLast) return null;
  const [first, second, year] = [Number(yearLast[1]), Number(yearLast[3]), Number(yearLast[4])];
  if (first <= 12 && second <= 12 && first !== second) return null;
  return first <= 12 && second > 12 ? calendarDay(year, first, second) : calendarDay(year, second, first);
}

/**
 * Why a date option's value is no date, naming the formats it takes: with
 * the date to type for one written another way that plainly names it
 * (`--from 2026-10-14` for 14/10/2026), else an example. `subject` is what
 * the date is ("an as-of date"); `option` how it is typed (`--from`).
 */
export function dateOptionError(value: string, option: string, now = new Date(), subject = `a ${option} date`): string {
  const format = `Use ${subject} as ${DATE_OPTION_FORMATS}`;
  const reading = isoDateReading(value);
  return reading
    ? `${format}: type ${option} ${reading} for ${value.trim()}.`
    : `${format}, such as ${option} ${isoDateToday(now)}.`;
}

/**
 * A date option's value as YYYY-MM-DD, checked before any request is made:
 * any of the formats `readCalendarDate` reads, or an error that lists them.
 * An empty value is no date.
 */
export function isoDateOption(value: string, flag: string, now = new Date()): string {
  const text = value.trim();
  if (!text) return text;
  const date = readCalendarDate(text);
  if (date) return date;
  throw new Error(dateOptionError(text, `--${flag}`, now));
}
