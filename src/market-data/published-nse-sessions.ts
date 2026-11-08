// Published NSE equity closures (weekend dates omitted), not a holiday-rule engine.
// BSE closes on the same days. Source: https://www.nseindia.com/resources/exchange-communication-holidays
// (checked 2026-10-04; past dates match the days missing from NSE bhavcopy).
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

/**
 * Published special sessions on days NSE and BSE are otherwise shut (the
 * Diwali Muhurat session), as local minutes: the normal market's open, and
 * its close with the closing auction and post-close, as a regular day's 09:15
 * and 16:00 are. 2026: Sun 8 Nov, normal market from 14:20, closing auction
 * to 15:30 (NSE circular NSE/CMTR/76941 of 19 Oct 2026; BSE trades the same session).
 */
const NSE_SPECIAL_SESSIONS: Record<string, { open: number; close: number }> = {
  "2026-11-08": { open: 14 * 60 + 20, close: 16 * 60 },
};

/** A published special session on `date` (YYYY-MM-DD), with its local hours; undefined on every other day. */
export function publishedNseSpecialSession(date: string): { open: number; close: number } | undefined {
  return NSE_SPECIAL_SESSIONS[date];
}
