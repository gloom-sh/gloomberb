import { isOhlcSeriesStyle } from "../../../time-series/spec";
import type { TimeSeriesPoint } from "../../../time-series/types";
import type {
  CompositeChartScene,
  CompositePanelScene,
  CompositeProjectedPoint,
  CompositeProjectedSeries,
} from "./types";
import { isFiniteNumber } from "../../../utils/guards";

function splitConnectedSegments(
  points: readonly CompositeProjectedPoint[],
): CompositeProjectedPoint[][] {
  const segments: CompositeProjectedPoint[][] = [];
  let current: CompositeProjectedPoint[] = [];
  for (const point of points) {
    if (point.breakBefore && current.length > 0) {
      segments.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/**
 * Largest-Triangle-Three-Buckets. Keeps the first and last samples and one
 * representative from each interior bucket so a line still fits the pixel
 * budget without flattening extrema.
 */
export function downsampleLttb(
  points: readonly CompositeProjectedPoint[],
  threshold: number,
): CompositeProjectedPoint[] {
  const count = points.length;
  const budget = Math.max(Math.floor(threshold), 1);
  if (count <= budget) return points as CompositeProjectedPoint[];
  if (budget === 1) return [points[0]!];
  if (budget === 2) return [points[0]!, points[count - 1]!];

  const sampled: CompositeProjectedPoint[] = [points[0]!];
  const bucketSize = (count - 2) / (budget - 2);
  let previousIndex = 0;

  for (let bucketIndex = 0; bucketIndex < budget - 2; bucketIndex += 1) {
    const nextStart = Math.floor((bucketIndex + 1) * bucketSize) + 1;
    const nextEnd = Math.min(Math.floor((bucketIndex + 2) * bucketSize) + 1, count);
    let avgX = 0;
    let avgY = 0;
    const avgCount = Math.max(nextEnd - nextStart, 1);
    for (let index = nextStart; index < nextEnd; index += 1) {
      avgX += points[index]!.xRatio;
      avgY += points[index]!.yRatio;
    }
    avgX /= avgCount;
    avgY /= avgCount;

    const currentStart = Math.floor(bucketIndex * bucketSize) + 1;
    const currentEnd = Math.floor((bucketIndex + 1) * bucketSize) + 1;
    const previous = points[previousIndex]!;
    const prevX = previous.xRatio;
    const prevY = previous.yRatio;
    let maxArea = -1;
    let maxIndex = currentStart;
    for (let index = currentStart; index < currentEnd; index += 1) {
      const point = points[index]!;
      const area = Math.abs(
        (prevX - avgX) * (point.yRatio - prevY) - (prevX - point.xRatio) * (avgY - prevY),
      );
      if (area > maxArea) {
        maxArea = area;
        maxIndex = index;
      }
    }
    sampled.push(points[maxIndex]!);
    previousIndex = maxIndex;
  }

  sampled.push(points[count - 1]!);
  return sampled;
}

function downsampleLineProjectedPoints(
  points: readonly CompositeProjectedPoint[],
  pixelWidth: number,
): CompositeProjectedPoint[] {
  if (points.length <= pixelWidth) return points as CompositeProjectedPoint[];
  const segments = splitConnectedSegments(points);
  if (segments.length === 1) return downsampleLttb(points, pixelWidth);

  const sampled: CompositeProjectedPoint[] = [];
  for (const segment of segments) {
    const budget = Math.max(2, Math.floor(pixelWidth * (segment.length / points.length)));
    const next = downsampleLttb(segment, Math.min(budget, segment.length));
    if (sampled.length > 0 && next[0] && !next[0].breakBefore) {
      sampled.push({ ...next[0], breakBefore: true }, ...next.slice(1));
      continue;
    }
    sampled.push(...next);
  }
  return sampled.length <= pixelWidth ? sampled : downsampleLttb(sampled, pixelWidth);
}

function sourceValue(point: CompositeProjectedPoint, key: "open" | "high" | "low" | "close"): number {
  const candidate = point.point[key];
  return isFiniteNumber(candidate) ? candidate : point.value;
}

function aggregateOhlcProjectedBucket(
  bucket: readonly CompositeProjectedPoint[],
): CompositeProjectedPoint {
  const first = bucket[0]!;
  const last = bucket[bucket.length - 1]!;
  let high = sourceValue(first, "high");
  let low = sourceValue(first, "low");
  let volume = isFiniteNumber(first.point.volume) ? first.point.volume : 0;
  let breakBefore = first.breakBefore;

  for (let index = 1; index < bucket.length; index += 1) {
    const point = bucket[index]!;
    high = Math.max(high, sourceValue(point, "high"));
    low = Math.min(low, sourceValue(point, "low"));
    if (isFiniteNumber(point.point.volume)) volume += point.point.volume;
    if (point.breakBefore) breakBefore = true;
  }

  const open = sourceValue(first, "open");
  const close = sourceValue(last, "close");
  const point: TimeSeriesPoint = {
    ...last.point,
    value: close,
    open,
    high,
    low,
    close,
    volume,
  };
  return {
    ...last,
    point,
    value: close,
    breakBefore,
  };
}

export function downsampleOhlcProjectedPoints(
  points: readonly CompositeProjectedPoint[],
  targetWidth: number,
): CompositeProjectedPoint[] {
  const budget = Math.max(Math.floor(targetWidth), 1);
  if (points.length <= budget) return points as CompositeProjectedPoint[];

  const buckets = new Map<number, CompositeProjectedPoint[]>();
  for (const point of points) {
    const index = Math.min(budget - 1, Math.max(0, Math.floor(point.xRatio * budget)));
    const bucket = buckets.get(index);
    if (bucket) bucket.push(point);
    else buckets.set(index, [point]);
  }
  return [...buckets.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, bucket]) => aggregateOhlcProjectedBucket(bucket));
}

export function downsampleProjectedSeries(
  series: CompositeProjectedSeries,
  pixelWidth: number,
): CompositeProjectedSeries {
  const width = Math.max(Math.floor(pixelWidth), 1);
  if (series.points.length <= 1 || width <= 1) return series;
  const points = isOhlcSeriesStyle(series.source.style)
    ? downsampleOhlcProjectedPoints(series.points, Math.max(Math.floor(width / 2), 1))
    : downsampleLineProjectedPoints(series.points, width);
  return points === series.points ? series : { ...series, points };
}

function downsamplePanel(panel: CompositePanelScene, pixelWidth: number): CompositePanelScene {
  let changed = false;
  const series = panel.series.map((entry) => {
    const next = downsampleProjectedSeries(entry, pixelWidth);
    if (next !== entry) changed = true;
    return next;
  });
  return changed ? { ...panel, series } : panel;
}

/**
 * Caps each panel's projected series to the plot's pixel budget. Cursor
 * snapping still uses the full `dates` / `dateRatios` lists on the scene.
 */
export function downsampleCompositeChartScene(
  scene: CompositeChartScene,
  pixelWidth: number,
): CompositeChartScene {
  const width = Math.max(Math.floor(pixelWidth), 1);
  if (width <= 1) return scene;
  let changed = false;
  const panels = scene.panels.map((panel) => {
    const next = downsamplePanel(panel, width);
    if (next !== panel) changed = true;
    return next;
  });
  return changed ? { ...scene, panels } : scene;
}
