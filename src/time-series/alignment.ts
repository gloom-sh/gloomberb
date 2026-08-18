import type { ResolvedSeries, TimeSeriesPoint } from "./types";

export interface AlignmentOptions {
  mode?: "union" | "intersection";
  timeline?: readonly Date[];
  carryForward?: boolean;
  maxCarryMilliseconds?: number;
  start?: Date;
  end?: Date;
}

export interface AlignedSeriesValue {
  point: TimeSeriesPoint;
  value: number | null;
  carried: boolean;
}

export interface AlignedTimeSeriesRow {
  date: Date;
  values: Record<string, AlignedSeriesValue | null>;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function scalarPointValue(point: TimeSeriesPoint): number | null {
  return finiteNumber(point.value)
    ? point.value
    : finiteNumber(point.close)
      ? point.close
      : null;
}

function sortedUniquePoints(points: readonly TimeSeriesPoint[]): TimeSeriesPoint[] {
  const byTime = new Map<number, TimeSeriesPoint>();
  for (const point of points) {
    const time = point.date.getTime();
    if (Number.isFinite(time)) byTime.set(time, point);
  }
  return [...byTime.values()].sort((left, right) => left.date.getTime() - right.date.getTime());
}

export function effectiveTimeSeriesPointTime(point: TimeSeriesPoint): number {
  const pointTime = point.date.getTime();
  const availableTime = point.availableAt?.getTime();
  return finiteNumber(availableTime) ? Math.max(pointTime, availableTime) : pointTime;
}

/**
 * Aligns heterogeneous observations on one timeline. Step series carry their
 * last known value forward only after `availableAt`; values are never filled
 * backward before the first public observation.
 */
export function alignTimeSeries(
  sourceSeries: readonly ResolvedSeries[],
  options: AlignmentOptions = {},
): AlignedTimeSeriesRow[] {
  const series = sourceSeries.map((entry) => ({ ...entry, points: sortedUniquePoints(entry.points) }));
  const start = options.start?.getTime() ?? Number.NEGATIVE_INFINITY;
  const end = options.end?.getTime() ?? Number.POSITIVE_INFINITY;
  const timeline = new Set<number>();
  for (const date of options.timeline ?? []) {
    const time = date.getTime();
    if (Number.isFinite(time) && time >= start && time <= end) timeline.add(time);
  }
  if (!options.timeline) {
    for (const entry of series) {
      for (const point of entry.points) {
        const time = point.date.getTime();
        if (time >= start && time <= end) timeline.add(time);
        const effectiveTime = effectiveTimeSeriesPointTime(point);
        if (effectiveTime !== time && effectiveTime >= start && effectiveTime <= end) {
          timeline.add(effectiveTime);
        }
      }
    }
  }

  const exactMaps = series.map((entry) => (
    new Map(entry.points.map((point) => [effectiveTimeSeriesPointTime(point), point]))
  ));
  const carryPoints = series.map((entry) => [...entry.points].sort((left, right) => (
    effectiveTimeSeriesPointTime(left) - effectiveTimeSeriesPointTime(right)
  )));
  const sortedTimes = [...timeline].sort((left, right) => left - right);
  const carryPointers = new Array<number>(series.length).fill(-1);
  const rows: AlignedTimeSeriesRow[] = [];
  for (const time of sortedTimes) {
    const values: Record<string, AlignedSeriesValue | null> = {};
    series.forEach((entry, seriesIndex) => {
      const points = carryPoints[seriesIndex]!;
      let pointer = carryPointers[seriesIndex]!;
      while (
        pointer + 1 < points.length
        && effectiveTimeSeriesPointTime(points[pointer + 1]!) <= time
      ) pointer += 1;
      carryPointers[seriesIndex] = pointer;

      const exact = exactMaps[seriesIndex]!.get(time);
      if (exact) {
        values[entry.id] = { point: exact, value: scalarPointValue(exact), carried: false };
        return;
      }
      const allowCarry = options.carryForward ?? entry.interpolation === "step-after";
      if (!allowCarry) {
        values[entry.id] = null;
        return;
      }

      if (pointer < 0) {
        values[entry.id] = null;
        return;
      }
      const previous = points[pointer]!;
      const age = time - effectiveTimeSeriesPointTime(previous);
      if (options.maxCarryMilliseconds !== undefined && age > options.maxCarryMilliseconds) {
        values[entry.id] = null;
        return;
      }
      values[entry.id] = {
        point: previous,
        value: scalarPointValue(previous),
        carried: true,
      };
    });
    if (options.mode !== "intersection" || series.every((entry) => values[entry.id] !== null)) {
      rows.push({ date: new Date(time), values });
    }
  }
  return rows;
}

/** Returns visible points and optionally the prior step anchor needed to draw continuity. */
export function clipSeriesToWindow(
  series: ResolvedSeries,
  start: Date,
  end: Date,
  includeStepAnchor = true,
): ResolvedSeries {
  const startTime = start.getTime();
  const endTime = end.getTime();
  const sorted = sortedUniquePoints(series.points);
  const visible = sorted.filter((point) => {
    const time = point.date.getTime();
    return time >= startTime && time <= endTime;
  });
  if (includeStepAnchor && series.interpolation === "step-after") {
    const anchor = [...sorted].reverse().find((point) => (
      effectiveTimeSeriesPointTime(point) <= startTime && point.date.getTime() < startTime
    ));
    if (anchor) visible.unshift(anchor);
  }
  return { ...series, points: visible };
}
