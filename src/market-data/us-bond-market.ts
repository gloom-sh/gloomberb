/**
 * The US bond market's full holidays, as SIFMA recommends them: the federal
 * holidays (Columbus Day and Veterans Day among them, when stocks trade) and
 * Good Friday, except a Good Friday the March jobs report comes out on (the
 * first Friday of April: 2010-04-02, 2012-04-06, 2015-04-03, 2021-04-02,
 * 2023-04-07, 2026-04-03), when SIFMA recommends an early close instead and
 * the Treasury curve and FRED's daily rates have the day. A Treasury curve and
 * a FRED rate series have no observation on a full holiday. A holiday on a Sunday closes the Monday after it; one on a Saturday
 * closes the Friday before it, except New Year's Day and Veterans Day, which
 * close nothing then (the market traded Fri 31 Dec 2021 and Fri 10 Nov 2023).
 * Juneteenth is a holiday from 2022. Early closes are trading days.
 */

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);

/** The `nth` `weekday` (0 Sunday) of a month (0 January), or its last when `nth` is -1. */
function nthWeekday(year: number, month: number, weekday: number, nth: number): number {
  if (nth < 0) {
    const last = Date.UTC(year, month + 1, 0);
    return last - ((new Date(last).getUTCDay() - weekday + 7) % 7) * DAY_MS;
  }
  const first = Date.UTC(year, month, 1);
  return first + (((weekday - new Date(first).getUTCDay() + 7) % 7) + (nth - 1) * 7) * DAY_MS;
}

/** Good Friday: Easter Sunday (the Gregorian computus) less two days. */
function goodFriday(year: number): number {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(year, month - 1, day) - 2 * DAY_MS;
}

const holidaysByYear = new Map<number, ReadonlyMap<string, string>>();

/** Each closed day of a year with the holiday it is for. */
function holidays(year: number): ReadonlyMap<string, string> {
  const kept = holidaysByYear.get(year);
  if (kept) return kept;
  const days = new Map<string, string>();
  // A fixed date on a Sunday closes the Monday; on a Saturday the Friday, where the market moves it.
  const fixed = (month: number, day: number, name: string, saturdayCloses = true) => {
    const date = Date.UTC(year, month, day);
    const weekday = new Date(date).getUTCDay();
    if (weekday === 6 && !saturdayCloses) return;
    days.set(isoDay(date + (weekday === 0 ? DAY_MS : weekday === 6 ? -DAY_MS : 0)), name);
  };
  fixed(0, 1, "New Year's Day", false);
  days.set(isoDay(nthWeekday(year, 0, 1, 3)), "Martin Luther King Jr. Day");
  days.set(isoDay(nthWeekday(year, 1, 1, 3)), "Washington's Birthday");
  // A Good Friday in April's first week is the March jobs report's day: an early close, not a holiday.
  const friday = goodFriday(year);
  if (!(new Date(friday).getUTCMonth() === 3 && new Date(friday).getUTCDate() <= 7)) days.set(isoDay(friday), "Good Friday");
  days.set(isoDay(nthWeekday(year, 4, 1, -1)), "Memorial Day");
  if (year >= 2022) fixed(5, 19, "Juneteenth");
  fixed(6, 4, "Independence Day");
  days.set(isoDay(nthWeekday(year, 8, 1, 1)), "Labor Day");
  days.set(isoDay(nthWeekday(year, 9, 1, 2)), "Columbus Day");
  fixed(10, 11, "Veterans Day", false);
  days.set(isoDay(nthWeekday(year, 10, 4, 4)), "Thanksgiving Day");
  fixed(11, 25, "Christmas Day");
  holidaysByYear.set(year, days);
  return days;
}

/** The holiday a day (`YYYY-MM-DD`) closes the US bond market for, or null for a trading day or a weekend. */
export function usBondMarketHoliday(date: string): string | null {
  const year = Number(date.slice(0, 4));
  return Number.isInteger(year) ? holidays(year).get(date.slice(0, 10)) ?? null : null;
}

/** `Wed 11 Nov`: a day as the closure note names it. */
function dayText(date: string): string {
  const day = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  return `${WEEKDAYS[day.getUTCDay()]} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]}`;
}

/**
 * Why a day asked for shows an earlier one, for a series observed on US bond
 * market days (the Treasury curve, FRED's daily rates): "Wed 11 Nov: US bond
 * market closed (Veterans Day); showing Tue 10 Nov", or "Sat 7 Nov: weekend;
 * showing Fri 6 Nov" when every day between them is a weekend or a holiday.
 * Null when the day shown is the day asked for, or when a trading day between
 * them has no observation either, which a closure does not explain.
 */
export function usBondMarketClosedNote(asked: string, shown: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asked) || !/^\d{4}-\d{2}-\d{2}$/.test(shown) || shown >= asked) return null;
  const from = Date.parse(`${shown}T00:00:00Z`) + DAY_MS;
  for (let time = from; time <= Date.parse(`${asked}T00:00:00Z`); time += DAY_MS) {
    const day = isoDay(time);
    if (new Date(time).getUTCDay() % 6 !== 0 && !usBondMarketHoliday(day)) return null;
  }
  const holiday = usBondMarketHoliday(asked);
  const why = holiday ? `US bond market closed (${holiday})` : new Date(`${asked}T00:00:00Z`).getUTCDay() % 6 === 0 ? "weekend"
    : "US bond market closed";
  return `${dayText(asked)}: ${why}; showing ${dayText(shown)}`;
}

/**
 * Whether a FRED series is observed on US bond market days: the Treasury's
 * constant-maturity, bill and real yields and their spreads, SOFR, and the
 * corporate yields and spreads priced off them. A stock index or an oil price
 * trades on Veterans Day and is no such series.
 */
export function followsUsBondMarket(seriesId: string): boolean {
  return /^(?:DGS\d+(?:MO)?|DTB\d+(?:WK)?|DTB\d+YR|DFII\d+|T\d+Y(?:\d+[MY]|FF|IE)|T5YIFR|SOFR\w*|BAML\w+|DAAA|DBAA|AAA10Y|BAA10Y)$/i
    .test(seriesId.trim());
}
