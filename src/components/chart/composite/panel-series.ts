import type { ResolvedSeries, TimeSeriesPoint } from "../../../time-series/types";

function sameTime(left: Date | undefined, right: Date | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return left == right;
  return left.getTime() === right.getTime();
}

function samePoint(left: TimeSeriesPoint, right: TimeSeriesPoint): boolean {
  return left === right
    || (
      sameTime(left.date, right.date)
      && sameTime(left.observedAt, right.observedAt)
      && sameTime(left.availableAt, right.availableAt)
      && left.value === right.value
      && left.open === right.open
      && left.high === right.high
      && left.low === right.low
      && left.close === right.close
      && left.volume === right.volume
      && left.periodLabel === right.periodLabel
    );
}

function sameSeriesMeta(left: ResolvedSeries, right: ResolvedSeries): boolean {
  return left.id === right.id
    && left.label === right.label
    && left.color === right.color
    && left.unit === right.unit
    && left.unitGroup === right.unitGroup
    && left.priceAssetCategory === right.priceAssetCategory
    && left.nativeFrequency === right.nativeFrequency
    && left.timestampMode === right.timestampMode
    && left.dataShape === right.dataShape
    && left.style === right.style
    && left.transform === right.transform
    && left.axis === right.axis
    && left.panelId === right.panelId
    && left.interpolation === right.interpolation
    && left.warning === right.warning
    && left.hidden === right.hidden
    && left.observationKind === right.observationKind
    && left.timeBasis?.kind === right.timeBasis?.kind
    && left.timeBasis?.timeZone === right.timeBasis?.timeZone
    && left.timeBasis?.cadenceMs === right.timeBasis?.cadenceMs;
}

function prefixPointsEqual(left: readonly TimeSeriesPoint[], right: readonly TimeSeriesPoint[]): boolean {
  if (left.length !== right.length || left.length === 0) return false;
  for (let index = 0; index < left.length - 1; index += 1) {
    if (!samePoint(left[index]!, right[index]!)) return false;
  }
  return true;
}

/**
 * Reuses a previous ResolvedSeries object when a parent allocated a new wrapper
 * for the same data, including live ticks that only change the last bar's
 * close/time. Bitmap dirty detection keys off object identity, so this keeps
 * an otherwise-stable plot from full-rerastering on every quote.
 */
export function reuseResolvedSeriesIdentity(
  previous: ResolvedSeries | undefined,
  next: ResolvedSeries,
): ResolvedSeries {
  if (!previous) return next;
  if (previous === next) return next;
  if (!sameSeriesMeta(previous, next)) return next;
  if (previous.points === next.points && previous.latestChangePercent === next.latestChangePercent) {
    return previous;
  }
  if (previous.points.length !== next.points.length) return next;
  const lastPrev = previous.points[previous.points.length - 1]!;
  const lastNext = next.points[next.points.length - 1]!;
  if (!samePoint(lastPrev, lastNext)) {
    if (!prefixPointsEqual(previous.points, next.points)) return next;
    previous.points[previous.points.length - 1] = lastNext;
    previous.latestChangePercent = next.latestChangePercent;
    return previous;
  }
  if (previous.points.every((point, index) => samePoint(point, next.points[index]!))) {
    if (previous.latestChangePercent === next.latestChangePercent) return previous;
    previous.latestChangePercent = next.latestChangePercent;
    return previous;
  }
  return next;
}

export function reuseResolvedSeriesList(
  previous: readonly ResolvedSeries[] | undefined,
  next: readonly ResolvedSeries[],
): ResolvedSeries[] {
  if (!previous) return next as ResolvedSeries[];
  if (previous === next) return previous as ResolvedSeries[];
  const reused = next.map((series, index) => reuseResolvedSeriesIdentity(previous[index], series));
  if (
    reused.length === previous.length
    && reused.every((series, index) => series === previous[index])
  ) {
    return previous as ResolvedSeries[];
  }
  return reused;
}
