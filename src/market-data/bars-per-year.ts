/** Daily bars in a year for an exchange: one per trading session. */
const SESSION_BARS_PER_YEAR = 252;
/** Daily bars in a year for an asset that trades every day, such as crypto. */
const CALENDAR_BARS_PER_YEAR = 365;
/**
 * Share of observation days a weekday has to carry, for Saturday and Sunday
 * alike, before the series counts as trading every day. A lone stray weekend
 * print in an exchange history is under it; a 24/7 series sits near 14%.
 */
const MIN_WEEKEND_DAY_SHARE = 0.05;
const DAY_MS = 86_400_000;

export type BarsPerYear = typeof SESSION_BARS_PER_YEAR | typeof CALENDAR_BARS_PER_YEAR;

/**
 * Daily bars the series holds in a year, read from its own dates: 365 when it
 * has both Saturday and Sunday observations (24/7 assets), 252 otherwise
 * (exchange sessions). Both days are required so a venue that trades Sunday
 * to Thursday, or whose bars start late on the previous evening in UTC, is not
 * read as trading every day. Annualised volatility and Sharpe scale with the
 * square root of this, and a one-year window is this many bars.
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
  return saturdays >= minimum && sundays >= minimum ? CALENDAR_BARS_PER_YEAR : SESSION_BARS_PER_YEAR;
}

/** The one line every report that annualises states its convention in. */
export function barsPerYearLabel(bars: number): string {
  return `${bars} bars/yr`;
}
