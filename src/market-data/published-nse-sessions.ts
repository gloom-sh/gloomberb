// Published NSE equity closures (weekend dates omitted), not a holiday-rule engine.
// BSE closes on the same days. Source: https://www.nseindia.com/resources/exchange-communication-holidays
// (checked 2026-10-04; past dates match the days missing from NSE bhavcopy).
// The Diwali Muhurat session falls on a weekend and is not modelled.
const NSE_CLOSURES: Record<number, readonly string[]> = {
  2026: [
    "01-15", "01-26", "03-03", "03-26", "03-31", "04-03", "04-14", "05-01",
    "05-28", "06-26", "09-14", "10-02", "10-20", "11-10", "11-24", "12-25",
  ],
};

/** True only for a published full-day closure; unpublished years are unknown, not open. */
export function isPublishedNseClosure(date: string): boolean {
  return NSE_CLOSURES[Number(date.slice(0, 4))]?.includes(date.slice(5)) ?? false;
}

/** True when the closures of that year are published. */
export function hasPublishedNseCalendar(year: number): boolean {
  return NSE_CLOSURES[year] !== undefined;
}
