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
