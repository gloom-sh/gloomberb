// The time window a composite chart scene shows: the explicit viewport, the
// series scoped to it, and the merged observation times of the series.
import type { ResolvedSeries } from "../../../../time-series/types";
import type { BuildCompositeChartSceneOptions, CompositeTimeScale } from "../types";
import { compositeTimeProjector } from "../time-scale";
import { isFiniteNumber } from "../../../../utils/guards";
import { isMarketObservationSeries, normalizedSourcePoints, type NormalizedSourcePoint } from "./points";

/**
 * The sorted union of timestamp lists that are each sorted, as
 * `[...new Set(lists.flat())].sort()` gives it, merged in one pass.
 */
export function mergeSortedTimestamps(lists: readonly (readonly number[])[]): number[] {
  let merged: number[] = [];
  for (const list of lists) {
    const next: number[] = [];
    let left = 0;
    let right = 0;
    while (left < merged.length || right < list.length) {
      const fromLeft = right >= list.length || (left < merged.length && merged[left]! <= list[right]!);
      const value = fromLeft ? merged[left++]! : list[right++]!;
      if (next.length === 0 || next[next.length - 1] !== value) next.push(value);
    }
    merged = next;
  }
  return merged;
}

export function timestampsOf(points: readonly NormalizedSourcePoint[]): number[] {
  const timestamps = new Array<number>(points.length);
  for (let index = 0; index < points.length; index += 1) timestamps[index] = points[index]!.timestamp;
  return timestamps;
}

export function explicitViewport(
  options: BuildCompositeChartSceneOptions,
): { startTime: number; endTime: number } | null {
  const startTime = options.viewport?.start.getTime();
  const endTime = options.viewport?.end.getTime();
  return isFiniteNumber(startTime) && isFiniteNumber(endTime) && startTime <= endTime
    ? { startTime, endTime }
    : null;
}

export function scopeSeriesToViewport(
  series: ResolvedSeries,
  startTime: number,
  endTime: number,
  timeScale: CompositeTimeScale,
  clipToViewport: boolean,
): ResolvedSeries | null {
  const points = normalizedSourcePoints(series, timeScale);
  const placement = timeScale.kind === "market" && !isMarketObservationSeries(series)
    ? "next-market-slot" as const
    : "timestamp" as const;
  const project = compositeTimeProjector(timeScale, placement);
  const visible = points.filter(({ timestamp }) => {
    if (timestamp >= startTime && timestamp <= endTime) return true;
    if (clipToViewport) return false;
    const projected = project(timestamp);
    return !!projected && projected.ratio >= 0 && projected.ratio <= 1;
  });
  if (series.interpolation === "step-after" || series.style === "step") {
    const anchor = points.some(({ timestamp }) => timestamp === startTime) ? undefined
      : [...points].reverse().find(({ timestamp }) => timestamp < startTime);
    if (anchor && !visible.includes(anchor)) visible.unshift(anchor);
  }
  return visible.some(({ value }) => value !== null)
    ? { ...series, points: visible.map(({ point }) => point) }
    : null;
}
