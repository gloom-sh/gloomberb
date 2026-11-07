/** Daily bars in a year for an exchange: one per trading session. */
const SESSION_BARS_PER_YEAR = 252;
/** Daily bars in a year for a market open every weekday, holidays included, such as an FX pair: 52 weeks of 5. */
const WEEKDAY_BARS_PER_YEAR = 260;
/** Daily bars in a year for an asset that trades every day, such as crypto. */
const CALENDAR_BARS_PER_YEAR = 365;
/**
 * Share of weekdays a weekday-only series has to carry to count as open every
 * weekday. An exchange closes on 6 to 17 weekdays a year (at most 98% of them);
 * an FX pair has a bar on every one, give or take a missing print.
 */
const MIN_WEEKDAY_SHARE = 0.985;
/** Weekdays the series has to span before its holidays, or their absence, are read: about a year. */
const MIN_WEEKDAY_SPAN = 250;
/**
 * Share of observation days a weekday has to carry, for Saturday and Sunday
 * alike, before the series counts as trading every day. A lone stray weekend
 * print in an exchange history is under it; a 24/7 series sits near 14%.
 */
const MIN_WEEKEND_DAY_SHARE = 0.05;
const DAY_MS = 86_400_000;

export type BarsPerYear = typeof SESSION_BARS_PER_YEAR | typeof WEEKDAY_BARS_PER_YEAR | typeof CALENDAR_BARS_PER_YEAR;

/**
 * Daily bars the series holds in a year, read from its own dates: 365 when it
 * has both Saturday and Sunday observations (24/7 assets), 260 when it has a
 * bar on nearly every weekday of a year or more, exchange holidays included
 * (an FX pair), and 252 otherwise (exchange sessions). Both weekend days are
 * required so a venue that trades Sunday to Thursday, or whose bars start late
 * on the previous evening in UTC, is not read as trading every day. Annualised
 * volatility and Sharpe scale with the square root of this, and a one-year
 * window is this many bars.
 */
export function barsPerYear(times: Iterable<Date | string | number>): BarsPerYear {
  const days = new Set<number>();
  for (const value of times) {
    const time = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
    if (Number.isFinite(time)) days.add(Math.floor(time / DAY_MS));
  }
  let saturdays = 0, sundays = 0;
  for (const day of days) {
    // Day 0 is Thursday 1 January 1970.
    const weekday = (((day + 4) % 7) + 7) % 7;
    if (weekday === 6) saturdays += 1;
    else if (weekday === 0) sundays += 1;
  }
  const minimum = Math.max(1, days.size * MIN_WEEKEND_DAY_SHARE);
  if (saturdays >= minimum && sundays >= minimum) return CALENDAR_BARS_PER_YEAR;
  const span = days.size ? weekdaysBetween(Math.min(...days), Math.max(...days)) : 0;
  return span >= MIN_WEEKDAY_SPAN && days.size - saturdays - sundays >= span * MIN_WEEKDAY_SHARE
    ? WEEKDAY_BARS_PER_YEAR : SESSION_BARS_PER_YEAR;
}

/** Monday to Friday days from the first day to the last, both included. */
function weekdaysBetween(first: number, last: number): number {
  let count = 0;
  for (let day = first; day <= last; day += 1) {
    const weekday = (((day + 4) % 7) + 7) % 7;
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
}

/** The one line every report that annualises states its convention in. */
export function barsPerYearLabel(bars: number): string {
  return `${bars} bars/yr`;
}
