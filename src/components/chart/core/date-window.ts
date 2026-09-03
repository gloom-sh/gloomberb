import type { PricePoint } from "../../../types/financials";
import type { TimeRange } from "./types";

export interface VisibleWindow {
  points: PricePoint[];
  startIdx: number;
  endIdx: number;
}
import type { DateWindowRange } from "../../../time-series/date-window";
import { subtractTimeRange } from "../../../time-series/date-window";

interface VisibleDateWindow {
  start: Date | null;
  end: Date | null;
  dates: Date[];
  startIdx: number;
  endIdx: number;
  totalDates: number;
}

function coerceDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

function normalizeDateWindowRange(window: DateWindowRange | null | undefined): { startMs: number; endMs: number } | null {
  if (!window?.start || !window.end) return null;
  const rawStartMs = window.start.getTime();
  const rawEndMs = window.end.getTime();
  if (!Number.isFinite(rawStartMs) || !Number.isFinite(rawEndMs)) return null;
  return rawStartMs <= rawEndMs
    ? { startMs: rawStartMs, endMs: rawEndMs }
    : { startMs: rawEndMs, endMs: rawStartMs };
}

function lowerBoundDate(dates: readonly Date[], targetMs: number): number {
  let low = 0;
  let high = dates.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (dates[mid]!.getTime() < targetMs) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function upperBoundDate(dates: readonly Date[], targetMs: number): number {
  let low = 0;
  let high = dates.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (dates[mid]!.getTime() <= targetMs) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function resolveMinimumPointWindow(
  dates: readonly Date[],
  startMs: number,
  endMs: number,
  minimumPoints: number,
): { startIdx: number; endIdx: number } {
  if (dates.length === 0) return { startIdx: 0, endIdx: 0 };

  let startIdx = lowerBoundDate(dates, startMs);
  let endIdx = upperBoundDate(dates, endMs);

  if (minimumPoints <= 0) {
    return {
      startIdx: Math.min(startIdx, dates.length),
      endIdx: Math.min(Math.max(endIdx, startIdx), dates.length),
    };
  }

  if (endIdx - startIdx >= minimumPoints || dates.length <= minimumPoints) {
    return {
      startIdx: Math.min(startIdx, dates.length),
      endIdx: Math.min(Math.max(endIdx, startIdx), dates.length),
    };
  }

  const centerMs = startMs + ((endMs - startMs) / 2);
  let anchorIdx = lowerBoundDate(dates, centerMs);
  if (anchorIdx >= dates.length) anchorIdx = dates.length - 1;
  if (anchorIdx > 0) {
    const currentDistance = Math.abs(dates[anchorIdx]!.getTime() - centerMs);
    const previousDistance = Math.abs(dates[anchorIdx - 1]!.getTime() - centerMs);
    if (previousDistance <= currentDistance) {
      anchorIdx -= 1;
    }
  }

  startIdx = Math.max(Math.min(anchorIdx - Math.floor((minimumPoints - 1) / 2), dates.length - minimumPoints), 0);
  endIdx = Math.min(startIdx + minimumPoints, dates.length);

  return { startIdx, endIdx };
}

function getPointDates(points: readonly Pick<PricePoint, "date">[]): Date[] {
  return points.map((point) => coerceDate(point.date as Date | string | number));
}

export function buildPresetDateWindow(dates: readonly Date[], presetRange: TimeRange): DateWindowRange | null {
  if (dates.length === 0) return null;
  if (presetRange === "ALL") {
    return {
      start: dates[0] ?? null,
      end: dates[dates.length - 1] ?? null,
    };
  }

  const end = dates[dates.length - 1]!;
  const threshold = subtractTimeRange(end, presetRange).getTime();
  const startIdx = dates.findIndex((date) => date.getTime() >= threshold);

  return {
    start: dates[startIdx < 0 ? 0 : startIdx] ?? null,
    end,
  };
}

function buildVisibleDateWindowFromRange(
  dates: readonly Date[],
  window: DateWindowRange | null | undefined,
  minimumPoints = 2,
): VisibleDateWindow {
  if (dates.length === 0) {
    return { start: null, end: null, dates: [], startIdx: 0, endIdx: 0, totalDates: 0 };
  }

  const normalizedWindow = normalizeDateWindowRange(window);
  if (!normalizedWindow) {
    return {
      start: dates[0] ?? null,
      end: dates[dates.length - 1] ?? null,
      dates: [...dates],
      startIdx: 0,
      endIdx: dates.length,
      totalDates: dates.length,
    };
  }

  const { startIdx, endIdx } = resolveMinimumPointWindow(dates, normalizedWindow.startMs, normalizedWindow.endMs, minimumPoints);
  const visibleDates = dates.slice(startIdx, endIdx);

  return {
    start: visibleDates[0] ?? null,
    end: visibleDates[visibleDates.length - 1] ?? null,
    dates: visibleDates,
    startIdx,
    endIdx,
    totalDates: dates.length,
  };
}

export function getVisibleWindowForDateRange(
  points: readonly PricePoint[],
  window: DateWindowRange | null | undefined,
  minimumPoints = 2,
): VisibleWindow {
  if (points.length === 0) {
    return { points: [], startIdx: 0, endIdx: 0 };
  }

  const pointDates = getPointDates(points);
  const visibleWindow = buildVisibleDateWindowFromRange(pointDates, window, minimumPoints);

  return {
    points: points.slice(visibleWindow.startIdx, visibleWindow.endIdx),
    startIdx: visibleWindow.startIdx,
    endIdx: visibleWindow.endIdx,
  };
}
