// Published trade-date holidays of the futures venues quotes name (weekend
// dates omitted), not a holiday-rule engine: weekdays with no trade date, on
// which nothing settles. CME Globex trades an abbreviated session on most of
// them and books it on the next trade date; ICE Futures U.S. softs do not
// trade at all. A year a venue has not published is unknown, not open.
// Checked 2026-10-21:
// CME Group, one calendar for CME, CBOT, NYMEX and COMEX:
//   https://www.cmegroup.com/trading-hours.html (2026 and 2027 Globex holiday schedules and notes)
//   and its clearing advisories, such as
//   https://www.cmegroup.com/tools-information/holiday-calendar/files/2026/2026-memorial-day-clearing-advisory.pdf
//   ("Prices will be carried forward from Prior day").
// ICE Futures U.S. softs (cocoa, coffee, cotton, FCOJ, sugar):
//   https://www.ice.com/publicdocs/futures_us/exchange_notices/ICE_Futures_US_Exchange_Notice_2026_Holiday_Calendar_20260609.pdf
//   https://www.ice.com/publicdocs/futures_us/exchange_notices/ICE_Futures_US_Exchange_Notice-2027_Holiday_Calendar_20260604.pdf
//   Its canola closes on Canada's holidays and its financial contracts trade most US ones; Gloom
//   Cloud quotes neither (RS=F and DX=F are not tickers), so NYB is its softs.
// ICE Futures Europe has no listing Gloom Cloud quotes, so no calendar.
const CME_GROUP_CLOSURES: Record<number, readonly string[]> = {
  2026: ["01-01", "01-19", "02-16", "04-03", "05-25", "06-19", "07-03", "09-07", "11-26", "12-25"],
  2027: ["01-01", "01-18", "02-15", "03-26", "05-31", "06-18", "07-05", "09-06", "11-25", "12-24"],
};

const ICE_US_SOFTS_CLOSURES: Record<number, readonly string[]> = {
  2026: ["01-01", "01-19", "02-16", "04-03", "05-25", "06-19", "07-03", "09-07", "11-26", "12-25"],
  2027: ["01-01", "01-18", "02-15", "03-26", "05-31", "06-18", "07-05", "09-06", "11-25", "12-24"],
};

/** Closures by canonical venue code. */
export const PUBLISHED_FUTURES_CLOSURES: Readonly<Record<string, Record<number, readonly string[]>>> = {
  CME: CME_GROUP_CLOSURES,
  CBT: CME_GROUP_CLOSURES,
  NYM: CME_GROUP_CLOSURES,
  CMX: CME_GROUP_CLOSURES,
  NYB: ICE_US_SOFTS_CLOSURES,
};

/**
 * Closures some of a venue's contracts settled on and others did not, which
 * its calendar cannot say either way. Good Friday 2026 fell on a payrolls
 * release: CME and CBOT settled their FX, interest rate and crypto contracts
 * and rolled their equity index and agricultural ones forward from Thursday
 * (https://www.cmegroup.com/tools-information/holiday-calendar/files/2026/2026-good-friday-clearing-advisory.pdf).
 * NYMEX and COMEX settled nothing.
 */
const PARTIAL_CLOSURES: Readonly<Record<string, readonly string[]>> = {
  CME: ["2026-04-03"],
  CBT: ["2026-04-03"],
};

/** Whether `exchange` (a canonical venue code) is a futures venue with a published calendar. */
export function isPublishedFuturesVenue(exchange: string): boolean {
  return Object.hasOwn(PUBLISHED_FUTURES_CLOSURES, exchange);
}

/** True only for a published trade-date holiday; unpublished years are unknown, not open. */
export function isPublishedFuturesClosure(exchange: string, date: string): boolean {
  if (!isPublishedFuturesVenue(exchange)) return false;
  return PUBLISHED_FUTURES_CLOSURES[exchange]![Number(date.slice(0, 4))]?.includes(date.slice(5)) ?? false;
}

/**
 * True when the venue's calendar says whether `date` had a trade date: its
 * year is published and the day is not one some of its contracts settled and
 * others did not.
 */
export function hasPublishedFuturesCalendar(exchange: string, date: string): boolean {
  return isPublishedFuturesVenue(exchange) && PUBLISHED_FUTURES_CLOSURES[exchange]![Number(date.slice(0, 4))] !== undefined
    && !PARTIAL_CLOSURES[exchange]?.includes(date);
}
