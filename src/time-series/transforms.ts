import type { ResolvedSeries, SeriesTransform, TimeSeriesPoint } from "./types";

const DAY_MS = 24 * 60 * 60 * 1_000;
const NUMERIC_POINT_FIELDS = ["value", "open", "high", "low", "close", "volume"] as const;

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clonePoint(point: TimeSeriesPoint): TimeSeriesPoint {
  return {
    ...point,
    date: new Date(point.date),
    observedAt: new Date(point.observedAt),
    availableAt: point.availableAt ? new Date(point.availableAt) : undefined,
    provenance: point.provenance ? { ...point.provenance } : undefined,
  };
}

function primaryValue(point: TimeSeriesPoint): number | null {
  return finiteNumber(point.value)
    ? point.value
    : finiteNumber(point.close)
      ? point.close
      : null;
}

function relativeValue(value: number | null | undefined, baseline: number, index100: boolean): number | null {
  if (!finiteNumber(value) || baseline === 0) return null;
  return index100 ? (value / baseline) * 100 : ((value - baseline) / Math.abs(baseline)) * 100;
}

function growthValue(value: number | null | undefined, previous: number | null | undefined): number | null {
  if (!finiteNumber(value) || !finiteNumber(previous) || previous === 0) return null;
  return ((value - previous) / Math.abs(previous)) * 100;
}

function shiftUtcMonths(date: Date, months: number): Date {
  const shifted = new Date(date);
  const originalDay = shifted.getUTCDate();
  shifted.setUTCDate(1);
  shifted.setUTCMonth(shifted.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  shifted.setUTCDate(Math.min(originalDay, lastDay));
  return shifted;
}

function referencePoint(
  points: readonly TimeSeriesPoint[],
  currentIndex: number,
  months: number,
  toleranceDays: number,
  observationsSorted: boolean,
): TimeSeriesPoint | null {
  const current = points[currentIndex];
  if (!current) return null;
  const currentTime = current.observedAt.getTime();
  const target = shiftUtcMonths(current.observedAt, months).getTime();
  const maxDistance = toleranceDays * DAY_MS;
  let best: { point: TimeSeriesPoint; distance: number; date: number; index: number } | null = null;
  const consider = (index: number) => {
    const candidate = points[index]!;
    const candidateTime = candidate.observedAt.getTime();
    if (candidateTime >= currentTime) return;
    const distance = Math.abs(candidateTime - target);
    if (distance > maxDistance) return;
    if (
      !best
      || distance < best.distance
      || (distance === best.distance && candidateTime > best.date)
      || (distance === best.distance && candidateTime === best.date && index < best.index)
    ) {
      best = { point: candidate, distance, date: candidateTime, index };
    }
  };

  if (!observationsSorted) {
    for (let index = 0; index < currentIndex; index += 1) consider(index);
    return (best as { point: TimeSeriesPoint } | null)?.point ?? null;
  }

  let low = 0;
  let high = currentIndex;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle]!.observedAt.getTime() < target) low = middle + 1;
    else high = middle;
  }
  for (let index = low - 1; index >= 0; index -= 1) {
    if (target - points[index]!.observedAt.getTime() > maxDistance) break;
    consider(index);
  }
  for (let index = low; index < currentIndex; index += 1) {
    if (points[index]!.observedAt.getTime() - target > maxDistance) break;
    consider(index);
  }
  return (best as { point: TimeSeriesPoint } | null)?.point ?? null;
}

function mapNumericFields(
  point: TimeSeriesPoint,
  mapper: (value: number | null | undefined, field: typeof NUMERIC_POINT_FIELDS[number]) => number | null,
): TimeSeriesPoint {
  const transformed = clonePoint(point);
  for (const field of NUMERIC_POINT_FIELDS) {
    const value = point[field];
    if (field !== "value" && value === undefined) continue;
    (transformed as unknown as Record<string, unknown>)[field] = mapper(value, field);
  }
  return transformed;
}

/** Applies a display transform without mutating the source observations. */
export function applySeriesTransform(
  sourcePoints: readonly TimeSeriesPoint[],
  transform: SeriesTransform,
  options: { baseline?: number | null } = {},
): TimeSeriesPoint[] {
  const points = sourcePoints
    .map(clonePoint)
    .filter((point) => Number.isFinite(point.date.getTime()) && Number.isFinite(point.observedAt.getTime()))
    .sort((left, right) => left.date.getTime() - right.date.getTime());
  if (transform === "raw") return points;

  if (transform === "percent" || transform === "index100") {
    const baselinePoint = points.find((point) => {
      const value = primaryValue(point);
      return value !== null && value !== 0;
    });
    const baseline = options.baseline !== undefined
      ? options.baseline
      : baselinePoint ? primaryValue(baselinePoint) : null;
    if (baseline === null || baseline === 0) {
      return points.map((point) => mapNumericFields(point, () => null));
    }
    return points.map((point) => mapNumericFields(
      point,
      (value) => relativeValue(value, baseline, transform === "index100"),
    ));
  }

  if (transform === "log") {
    return points.map((point) => mapNumericFields(
      point,
      (value) => finiteNumber(value) && value > 0 ? Math.log(value) : null,
    ));
  }

  const months = transform === "yoy" ? 12 : 3;
  const toleranceDays = transform === "yoy" ? 62 : 46;
  const observationsSorted = points.every((point, index) => (
    index === 0 || points[index - 1]!.observedAt.getTime() <= point.observedAt.getTime()
  ));
  return points.map((point, index) => {
    const reference = referencePoint(points, index, months, toleranceDays, observationsSorted);
    if (!reference) return mapNumericFields(point, () => null);
    return mapNumericFields(point, (value, field) => growthValue(value, reference[field]));
  });
}

export function applyResolvedSeriesTransform(
  series: ResolvedSeries,
  transform: SeriesTransform = series.transform,
  options: { baseline?: number | null } = {},
): ResolvedSeries {
  if (transform === "raw") return { ...series, transform, points: applySeriesTransform(series.points, "raw") };
  const percent = transform === "percent" || transform === "yoy" || transform === "qoq";
  return {
    ...series,
    transform,
    unit: percent ? "%" : transform === "index100" ? "index" : "log",
    unitGroup: percent ? "percent" : transform === "index100" ? "index" : "log",
    dataShape: "scalar",
    style: series.style === "candles" || series.style === "ohlc" || series.style === "hlc"
      ? "line"
      : series.style,
    points: applySeriesTransform(series.points, transform, options),
  };
}
