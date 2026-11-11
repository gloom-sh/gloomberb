import { TIME_RANGES, type ChartDateWindow, type TimeRange } from "./range";
import { calendarMonthsBefore } from "../utils/calendar-date";

export interface DateWindowRange extends ChartDateWindow {}

/**
 * How far back ALL reaches: 125 years, past the first bar any source keeps
 * (the S&P 500's daily closes start in 1927), so ALL is the whole stored
 * history and never a window cut short of it.
 */
export const ALL_RANGE_MONTHS = 1_500;

export function subtractTimeRange(endDate: Date, range: TimeRange): Date {
  // Research bounds follow source instants and UTC date keys, independently
  // of the viewing computer's timezone and daylight-saving transitions.
  const startDate = new Date(endDate);
  switch (range) {
    case "1D":
      startDate.setUTCDate(startDate.getUTCDate() - 1);
      break;
    case "1W":
      startDate.setUTCDate(startDate.getUTCDate() - 7);
      break;
    case "1M":
      return calendarMonthsBefore(endDate, 1);
    case "3M":
      return calendarMonthsBefore(endDate, 3);
    case "6M":
      return calendarMonthsBefore(endDate, 6);
    case "1Y":
      return calendarMonthsBefore(endDate, 12);
    case "5Y":
      return calendarMonthsBefore(endDate, 60);
    case "ALL":
      return calendarMonthsBefore(endDate, ALL_RANGE_MONTHS);
  }
  return startDate;
}

export function isDateWindowWithinTimeRange(startDate: Date, endDate: Date, maxRange: TimeRange): boolean {
  if (maxRange === "ALL") return true;
  return startDate.getTime() >= subtractTimeRange(endDate, maxRange).getTime();
}

export function getTimeRangeForDateWindow(window: DateWindowRange | null): TimeRange {
  if (!window?.start || !window.end) return "ALL";
  return TIME_RANGES.find((candidate) => isDateWindowWithinTimeRange(window.start!, window.end!, candidate)) ?? "ALL";
}
