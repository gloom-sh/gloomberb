// Published JPX cash-market closures (weekend dates omitted), not a holiday-rule engine.
// Source: https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html (checked 2026-09-23).
const JPX_CLOSURES: Record<number, readonly string[]> = {
  2026: [
    "01-01", "01-02", "01-12", "02-11", "02-23", "03-20", "04-29", "05-04", "05-05", "05-06",
    "07-20", "08-11", "09-21", "09-22", "09-23", "10-12", "11-03", "11-23", "12-31",
  ],
  2027: [
    "01-01", "01-11", "02-11", "02-23", "03-22", "04-29", "05-03", "05-04", "05-05",
    "07-19", "08-11", "09-20", "09-23", "10-11", "11-03", "11-23", "12-31",
  ],
};

/** True only for a published full-day closure; unpublished years are unknown, not open. */
export function isPublishedJpxClosure(date: string): boolean {
  return JPX_CLOSURES[Number(date.slice(0, 4))]?.includes(date.slice(5)) ?? false;
}
