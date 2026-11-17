import type { EarningsFiscalAnchor } from "../../../api-client/earnings";
import { addDays } from "./board-model";
import { quarterLabel } from "../shared/earnings-report";

/** A quarter as the company names it: NVIDIA's October 2026 quarter is Q3 of fiscal 2027. */
export interface FiscalQuarter {
  fiscalYear: number;
  fiscalQuarter: number;
}

const MONTH = /^(\d{4})-(\d{2})$/;

function monthIndex(period: string | null | undefined): number | null {
  const found = period ? MONTH.exec(period) : null;
  if (!found) return null;
  const month = Number(found[2]);
  return month >= 1 && month <= 12 ? Number(found[1]) * 12 + month - 1 : null;
}

const monthOf = (index: number) => `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
const monthEnd = (index: number) => addDays(`${monthOf(index + 1)}-01`, -1);

/** The quarter ending in `period` (YYYY-MM), stepped from the one the company's calls name. */
export function fiscalQuarterOf(period: string | null | undefined, anchor: EarningsFiscalAnchor | null | undefined): FiscalQuarter | null {
  const month = monthIndex(period);
  const from = monthIndex(anchor?.fiscalPeriod);
  if (month == null || from == null || !anchor) return null;
  const index = anchor.fiscalYear * 4 + anchor.fiscalQuarter - 1 + Math.round((month - from) / 3);
  return { fiscalYear: Math.floor(index / 4), fiscalQuarter: (index % 4) + 1 };
}

/**
 * The month a period ends in, from a YYYY-MM month or a YYYY-MM-DD end. A
 * 52/53-week period that ends in a month's first week (Feb 1, 2026) closes
 * the month before, as its filer counts it.
 */
function closingMonth(period: string | null | undefined): number | null {
  const day = period ? /^(\d{4}-\d{2})-(\d{2})/.exec(period) : null;
  const month = monthIndex(day ? day[1] : period);
  return month != null && day && Number(day[2]) <= 7 ? month - 1 : month;
}

/**
 * The quarter ending in `period` on a fiscal year that ends in `yearEndMonth`
 * (1 to 12, from the company's annual statements), where no calls name the
 * company's quarters: Visa's December 2026 quarter is Q1 FY2027, its year
 * ending in September. A fiscal year is named by the calendar year it ends
 * in. Null off that year's quarters, or without a year end.
 */
export function fiscalQuarterInYear(period: string | null | undefined, yearEndMonth: number | null | undefined): FiscalQuarter | null {
  const month = closingMonth(period);
  if (month == null || yearEndMonth == null || yearEndMonth < 1 || yearEndMonth > 12) return null;
  const calendarMonth = (month % 12) + 1;
  const offset = (calendarMonth - yearEndMonth + 12) % 12;
  if (offset % 3 !== 0) return null;
  const year = Math.floor(month / 12);
  return { fiscalYear: calendarMonth <= yearEndMonth ? year : year + 1, fiscalQuarter: offset === 0 ? 4 : offset / 3 };
}

/** "FY2027" for a period that ends a fiscal year ending in `yearEndMonth`; null for any other. */
export function fiscalYearText(period: string | null | undefined, yearEndMonth: number | null | undefined): string | null {
  const quarter = fiscalQuarterInYear(period, yearEndMonth);
  return quarter?.fiscalQuarter === 4 ? `FY${quarter.fiscalYear}` : null;
}

/**
 * The quarter-end month a report with none on record announces: the last on
 * the company's cycle that ended 5 to 100 days before it, as Gloom Cloud
 * places its own such reports. Null without the company's calendar.
 */
export function placedPeriod(date: string, anchor: EarningsFiscalAnchor | null | undefined): string | null {
  const cycle = monthIndex(anchor?.fiscalPeriod);
  const day = monthIndex(date.slice(0, 7));
  if (cycle == null || day == null) return null;
  const latest = addDays(date, -5);
  const earliest = addDays(date, -100);
  for (let month = day; month > day - 5; month -= 1) {
    if ((month - cycle) % 3 !== 0) continue;
    const end = monthEnd(month);
    if (end <= latest && end >= earliest) return monthOf(month);
  }
  return null;
}

/** "Q3 FY2027", or "Q3 FY27" where a column is narrow. */
export function fiscalQuarterText(quarter: FiscalQuarter | null | undefined, short = false): string | null {
  if (!quarter) return null;
  return `Q${quarter.fiscalQuarter} FY${short ? String(quarter.fiscalYear).slice(-2) : quarter.fiscalYear}`;
}

export function fiscalPeriodText(period: string | null | undefined, quarter?: FiscalQuarter | null, short = false): string {
  return fiscalQuarterText(quarter, short) ?? quarterLabel(period ?? undefined);
}
