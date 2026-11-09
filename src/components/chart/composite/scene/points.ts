// Point normalization for the composite chart scene: each series' points in time
// order with their values, the single cache that keeps that work across
// rebuilds, and Heikin Ashi bars.
import type { ResolvedSeries, TimeSeriesPoint } from "../../../../time-series/types";
import { effectiveTimeSeriesPointTime, sortedUniquePoints, timeSeriesObservationKey } from "../../../../time-series/alignment";
import type { CompositeTimeScale } from "../types";
import { isFiniteNumber } from "../../../../utils/guards";

export function resolveTimeSeriesPointValue(point: TimeSeriesPoint): number | null {
  if (isFiniteNumber(point.value)) return point.value;
  if (isFiniteNumber(point.close)) return point.close;
  return null;
}

/**
 * Heikin Ashi bars in place of a series' own: each close averages the bar's
 * four prices and each open sits halfway along the previous Heikin Ashi body,
 * so the chain runs from the first loaded bar, before any viewport cut. The
 * real close stays in `rawValue` for the last price marker.
 */
export function heikinAshiPoints(points: readonly TimeSeriesPoint[]): TimeSeriesPoint[] {
  let previous: { open: number; close: number } | null = null;
  // Chain over the bars the chart draws: one per observation, in time order,
  // so a superseded copy of a bar never feeds the next open.
  return sortedUniquePoints(points).map((point) => {
    const close = point.close ?? point.value;
    if (!isFiniteNumber(close)) return point;
    const open = isFiniteNumber(point.open) ? point.open : close;
    const high = isFiniteNumber(point.high) ? point.high : Math.max(open, close);
    const low = isFiniteNumber(point.low) ? point.low : Math.min(open, close);
    const haClose = (open + high + low + close) / 4;
    const haOpen = previous ? (previous.open + previous.close) / 2 : (open + close) / 2;
    previous = { open: haOpen, close: haClose };
    return {
      ...point,
      value: haClose,
      rawValue: close,
      open: haOpen,
      high: Math.max(high, haOpen, haClose),
      low: Math.min(low, haOpen, haClose),
      close: haClose,
    };
  });
}

function pointTime(point: TimeSeriesPoint): number | null {
  const time = point.date instanceof Date ? point.date.getTime() : new Date(point.date).getTime();
  return Number.isFinite(time) ? time : null;
}

export function isMarketObservationSeries(series: ResolvedSeries): boolean {
  return series.observationKind === "market" || series.timeBasis?.kind === "market";
}

function pointTimestampForScale(
  series: ResolvedSeries,
  point: TimeSeriesPoint,
  timeScale?: CompositeTimeScale,
): number | null {
  const timestamp = pointTime(point);
  if (timestamp === null) return null;
  return timeScale?.kind === "market" && !isMarketObservationSeries(series)
    ? effectiveTimeSeriesPointTime(point)
    : timestamp;
}

export interface NormalizedSourcePoint {
  point: TimeSeriesPoint;
  timestamp: number;
  value: number | null;
}

interface NormalizedPointsCache {
  points: readonly TimeSeriesPoint[];
  pointCount: number;
  last: TimeSeriesPoint | undefined;
  lastTimestamp: number | null;
  lastValue: number | null;
  byPlacement: Map<boolean, NormalizedSourcePoint[]>;
}

// Every scene build normalises each series several times over; a viewport
// change must not re-sort thousands of unchanged points. Live ticks mutate
// the last point in place, so the cache also keys on its time and value.
const normalizedPointsCache = new WeakMap<ResolvedSeries, NormalizedPointsCache>();

/**
 * Points already in time order, one per instant and with no fiscal period,
 * normalise in order: each is its own observation, at its own date. Null for
 * anything else, which goes through the keyed sort.
 */
function orderedSourcePoints(points: readonly TimeSeriesPoint[]): NormalizedSourcePoint[] | null {
  const normalized: NormalizedSourcePoint[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point.periodLabel !== undefined) return null;
    const timestamp = pointTime(point);
    if (timestamp === null || timestamp <= previous) return null;
    previous = timestamp;
    normalized.push({ point, timestamp, value: resolveTimeSeriesPointValue(point) });
  }
  return normalized;
}

function computeNormalizedSourcePoints(
  series: ResolvedSeries,
  timeScale?: CompositeTimeScale,
): NormalizedSourcePoint[] {
  // Placed at their own dates, points in time order are already normalised;
  // a live chart re-resolves its series on every tick.
  const effectiveTimes = timeScale?.kind === "market" && !isMarketObservationSeries(series);
  const ordered = effectiveTimes ? null : orderedSourcePoints(series.points);
  if (ordered) return ordered;
  const byObservation = new Map<string, NormalizedSourcePoint>();
  for (const point of series.points) {
    const sourceTimestamp = pointTime(point);
    const timestamp = pointTimestampForScale(series, point, timeScale);
    if (sourceTimestamp === null || timestamp === null || !Number.isFinite(timestamp)) continue;
    byObservation.set(timeSeriesObservationKey(point), {
      point,
      timestamp,
      value: resolveTimeSeriesPointValue(point),
    });
  }
  return [...byObservation.values()].sort((left, right) => (
    left.timestamp - right.timestamp
    || left.point.date.getTime() - right.point.date.getTime()
    || left.point.observedAt.getTime() - right.point.observedAt.getTime()
  ));
}

export function normalizedSourcePoints(
  series: ResolvedSeries,
  timeScale?: CompositeTimeScale,
): NormalizedSourcePoint[] {
  const effectiveTimes = timeScale?.kind === "market" && !isMarketObservationSeries(series);
  const last = series.points[series.points.length - 1];
  const lastTimestamp = last ? pointTime(last) : null;
  const lastValue = last ? resolveTimeSeriesPointValue(last) : null;
  let cached = normalizedPointsCache.get(series);
  if (
    !cached
    || cached.points !== series.points
    || cached.pointCount !== series.points.length
    || cached.last !== last
    || cached.lastTimestamp !== lastTimestamp
    || cached.lastValue !== lastValue
  ) {
    cached = {
      points: series.points,
      pointCount: series.points.length,
      last,
      lastTimestamp,
      lastValue,
      byPlacement: new Map(),
    };
    normalizedPointsCache.set(series, cached);
  }
  let normalized = cached.byPlacement.get(effectiveTimes);
  if (!normalized) {
    normalized = computeNormalizedSourcePoints(series, timeScale);
    cached.byPlacement.set(effectiveTimes, normalized);
  }
  return normalized;
}

export function hasDrawableValue(series: ResolvedSeries): boolean {
  return normalizedSourcePoints(series).some((entry) => entry.value !== null);
}
