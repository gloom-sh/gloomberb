/**
 * The months BLS never published a CPI index for: October 2025, which the
 * 2025 shutdown left uncollected. Every index of the release, all items and
 * core among them, has no level that month, so a change against it has none.
 */
const UNPUBLISHED_CPI_MONTHS: ReadonlySet<string> = new Set(["2025-10"]);

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November",
  "December"];

/** "October 2025" from 2025-10 (a `YYYY-MM-DD` date names its month too). */
const monthName = (period: string) => `${MONTH_NAMES[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;

/** The month before or after one, `YYYY-MM`. */
function shiftMonth(period: string, months: number): string {
  const at = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 1 + months, 1));
  return at.toISOString().slice(0, 7);
}

/**
 * Why a CPI month has no change over twelve months, when the month a year
 * before it has no index: "BLS published no October 2025 index, so no
 * October 2026 y/y". Null for any other month (`YYYY-MM`).
 */
export function cpiYearGapReason(period: string): string | null {
  const yearAgo = shiftMonth(period, -12);
  return UNPUBLISHED_CPI_MONTHS.has(yearAgo) ? `BLS published no ${monthName(yearAgo)} index, so no ${monthName(period)} y/y` : null;
}

/**
 * The line a CPI table with no year-over-year change for `period` closes on:
 * why, and the latest change it has, "BLS published no October 2025 index, so
 * no October 2026 y/y; All items 3.7% in September 2026." `latest` is the
 * latest month that has one and its change in percent, to one decimal as BLS
 * prints it. Null when the month has its change or none is missing for that reason.
 */
export function cpiYearGapNote(period: string, label: string, latest: { period: string; value: number } | null): string | null {
  const reason = cpiYearGapReason(period);
  if (!reason) return null;
  return latest ? `${reason}; ${label} ${latest.value.toFixed(1)}% in ${monthName(latest.period)}.` : `${reason}.`;
}

/**
 * For a CPI series whose latest change over twelve months is for `latest`
 * (`YYYY-MM`, or its first day), why the month after it has none, and the
 * latest month's name: ECST's CPI y/y reads September 2026 after October's
 * CPI is out, as October has no y/y. Null when the next month has its change.
 */
export function cpiNextYearGap(latest: string): { reason: string; latestMonth: string } | null {
  const month = latest.slice(0, 7);
  const reason = cpiYearGapReason(shiftMonth(month, 1));
  return reason ? { reason, latestMonth: monthName(month) } : null;
}

/** The US CPI changes over twelve months the economic calendar lists, all items and core, under the ids it gives them. */
const US_CPI_YOY_INDICATORS: ReadonlySet<string> = new Set(["us-inflation-rate-yoy", "us-core-inflation-rate-yoy"]);

/**
 * Why an economic calendar row of a US CPI change over twelve months has no
 * actual, when the month a year before the one it covers has no index: the
 * release of 10 November 2026 covers October 2026, and October 2025 was never
 * published. A US CPI release covers the month before it. Null for any other row.
 */
export function cpiCalendarYearGapReason(row: { country: string; indicatorId?: string | null; actual: string | null; date: Date }): string | null {
  if (row.country !== "US" || !row.indicatorId || !US_CPI_YOY_INDICATORS.has(row.indicatorId) || row.actual?.trim()) return null;
  return cpiYearGapReason(shiftMonth(row.date.toISOString().slice(0, 7), -1));
}
