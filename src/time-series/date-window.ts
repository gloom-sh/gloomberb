import { TIME_RANGES, type ChartDateWindow, type TimeRange } from "./range";

export interface DateWindowRange extends ChartDateWindow {}

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
      startDate.setUTCMonth(startDate.getUTCMonth() - 1);
      break;
    case "3M":
      startDate.setUTCMonth(startDate.getUTCMonth() - 3);
      break;
    case "6M":
      startDate.setUTCMonth(startDate.getUTCMonth() - 6);
      break;
    case "1Y":
      startDate.setUTCFullYear(startDate.getUTCFullYear() - 1);
      break;
    case "5Y":
      startDate.setUTCFullYear(startDate.getUTCFullYear() - 5);
      break;
    case "ALL":
      startDate.setUTCFullYear(startDate.getUTCFullYear() - 50);
      break;
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
