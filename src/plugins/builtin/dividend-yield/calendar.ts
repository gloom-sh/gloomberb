/** Preserve the UTC month and clamp February 29 to February 28 in non-leap years. */
export function calendarYearsBefore(date: Date, years: number): Date {
  const result = new Date(date);
  const year = date.getUTCFullYear() - years;
  const month = date.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  result.setUTCFullYear(year, month, Math.min(date.getUTCDate(), lastDay));
  return result;
}
