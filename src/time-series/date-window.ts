import { TIME_RANGES, type ChartDateWindow, type TimeRange } from "./range";

export interface DateWindowRange extends ChartDateWindow {}

export function subtractTimeRange(endDate: Date, range: TimeRange): Date {
  const startDate = new Date(endDate);
  switch (range) {
    case "1D":
      startDate.setDate(startDate.getDate() - 1);
      break;
    case "1W":
      startDate.setDate(startDate.getDate() - 7);
      break;
    case "1M":
      startDate.setMonth(startDate.getMonth() - 1);
      break;
    case "3M":
      startDate.setMonth(startDate.getMonth() - 3);
      break;
    case "6M":
      startDate.setMonth(startDate.getMonth() - 6);
      break;
    case "1Y":
      startDate.setFullYear(startDate.getFullYear() - 1);
      break;
    case "5Y":
      startDate.setFullYear(startDate.getFullYear() - 5);
      break;
    case "ALL":
      startDate.setFullYear(startDate.getFullYear() - 50);
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
