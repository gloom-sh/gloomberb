import type { ResolvedSeries } from "../../../time-series/types";
import type { CompositeTimeScale } from "./types";

const DAY_MS = 24 * 60 * 60 * 1_000;
const QUARTER_HOUR_MS = 15 * 60 * 1_000;
/**
 * Empty space kept after the newest observation, as a fraction of the visible
 * span, so the last bar is drawn whole with air after it instead of hugging the
 * value axis. Six percent is three to five bar slots on the windows these
 * charts show, and because it scales with the plot it reads the same in a
 * narrow terminal pane and at desktop pixel widths.
 */
export const COMPOSITE_RIGHT_OFFSET_RATIO = 0.06;
const MINIMUM_SLOT_FRACTION = 0.25;
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
// Session dates are looked up once per quarter hour, not once per bar: a day
// of one-minute bars asks the same question hundreds of times.
const sessionDateBuckets = new Map<string, Map<number, string>>();
const SESSION_DATE_BUCKET_LIMIT = 200_000;

type MarketAnchors = Extract<CompositeTimeScale, { kind: "market" }>["anchors"];

interface CachedMarketAnchors {
  points: readonly ResolvedSeries["points"][number][];
  pointCount: number;
  lastTimestamp: number | null;
  timeZone: string;
  configuredCadence: number | undefined;
  cadenceMs: number;
  anchors: MarketAnchors;
}

const anchorCache = new WeakMap<ResolvedSeries, CachedMarketAnchors>();

function finiteTimestamp(value: Date): number | null {
  const timestamp = value.getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function uniqueSeriesTimestamps(series: ResolvedSeries): number[] {
  return [...new Set(series.points.flatMap((point) => {
    const timestamp = finiteTimestamp(point.date);
    return timestamp === null ? [] : [timestamp];
  }))].sort((left, right) => left - right);
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function formatSessionDate(timestamp: number, timeZone: string): string {
  try {
    const parts = formatterFor(timeZone).formatToParts(new Date(timestamp));
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // Invalid or unsupported IANA zones fall back to UTC below.
  }
  return new Date(timestamp).toISOString().slice(0, 10);
}

function sessionDate(timestamp: number, timeZone: string): string {
  // Every IANA offset is a multiple of fifteen minutes, so local midnight
  // always lands on a bucket edge and one bucket never spans two sessions.
  let buckets = sessionDateBuckets.get(timeZone);
  if (!buckets) {
    buckets = new Map();
    sessionDateBuckets.set(timeZone, buckets);
  }
  const bucket = Math.floor(timestamp / QUARTER_HOUR_MS);
  const cached = buckets.get(bucket);
  if (cached !== undefined) return cached;
  const date = formatSessionDate(timestamp, timeZone);
  if (buckets.size >= SESSION_DATE_BUCKET_LIMIT) buckets.clear();
  buckets.set(bucket, date);
  return date;
}

function median(values: readonly number[]): number | null {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function lowerBoundAnchor(
  anchors: MarketAnchors,
  timestamp: number,
): number {
  let low = 0;
  let high = anchors.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (anchors[middle]!.timestamp < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function positionForTimestamp(
  scale: Pick<Extract<CompositeTimeScale, { kind: "market" }>, "anchors" | "cadenceMs">,
  timestamp: number,
): number {
  const { anchors, cadenceMs } = scale;
  const index = lowerBoundAnchor(anchors, timestamp);
  const next = anchors[index];
  if (next?.timestamp === timestamp) return next.position;
  const previous = anchors[index - 1];
  if (!previous) {
    return anchors[0]!.position + (timestamp - anchors[0]!.timestamp) / cadenceMs;
  }
  if (!next) {
    const last = anchors.at(-1)!;
    return last.position + (timestamp - last.timestamp) / cadenceMs;
  }
  const elapsed = next.timestamp - previous.timestamp;
  if (elapsed <= 0) return previous.position;
  return previous.position
    + (next.position - previous.position) * ((timestamp - previous.timestamp) / elapsed);
}

function buildMarketAnchors(series: ResolvedSeries, timeZone: string): {
  cadenceMs: number;
  anchors: MarketAnchors;
} {
  const anchorTimestamps = uniqueSeriesTimestamps(series);
  const sessionDates = anchorTimestamps.map((timestamp) => sessionDate(timestamp, timeZone));
  const sameSessionGaps: number[] = [];
  const allGaps: number[] = [];
  for (let index = 1; index < anchorTimestamps.length; index += 1) {
    const gap = anchorTimestamps[index]! - anchorTimestamps[index - 1]!;
    if (gap <= 0) continue;
    allGaps.push(gap);
    if (sessionDates[index - 1] === sessionDates[index]) sameSessionGaps.push(gap);
  }
  const configuredCadence = series.timeBasis?.cadenceMs;
  const cadenceMs = typeof configuredCadence === "number"
    && Number.isFinite(configuredCadence)
    && configuredCadence > 0
    ? configuredCadence
    : median(sameSessionGaps) ?? median(allGaps) ?? DAY_MS;

  const anchors: MarketAnchors = [];
  let position = 0;
  anchorTimestamps.forEach((timestamp, index) => {
    if (index > 0) {
      const previous = anchorTimestamps[index - 1]!;
      position += sessionDates[index - 1] === sessionDates[index]
        ? Math.max((timestamp - previous) / cadenceMs, MINIMUM_SLOT_FRACTION)
        : 1;
    }
    anchors.push({ timestamp, position });
  });
  return { cadenceMs, anchors };
}

/**
 * Anchor slots for a market series, cached on the series object. Live ticks
 * mutate the last point in place, so the cache also keys on the point count
 * and the last timestamp.
 */
function resolveMarketAnchors(
  series: ResolvedSeries,
): { cadenceMs: number; anchors: MarketAnchors; timeZone: string } | null {
  if (!series.timeBasis || series.timeBasis.kind !== "market") return null;
  const { timeZone, cadenceMs: configuredCadence } = series.timeBasis;
  const lastTimestamp = series.points.length > 0
    ? finiteTimestamp(series.points[series.points.length - 1]!.date)
    : null;
  const cached = anchorCache.get(series);
  if (
    cached
    && cached.points === series.points
    && cached.pointCount === series.points.length
    && cached.lastTimestamp === lastTimestamp
    && cached.timeZone === timeZone
    && cached.configuredCadence === configuredCadence
  ) {
    return { cadenceMs: cached.cadenceMs, anchors: cached.anchors, timeZone };
  }
  const built = buildMarketAnchors(series, timeZone);
  anchorCache.set(series, {
    points: series.points,
    pointCount: series.points.length,
    lastTimestamp,
    timeZone,
    configuredCadence,
    cadenceMs: built.cadenceMs,
    anchors: built.anchors,
  });
  return { ...built, timeZone };
}

export function buildCompositeTimeScale(
  timelineSeries: readonly ResolvedSeries[],
  startTime: number,
  endTime: number,
  rightOffsetRatio = 0,
): CompositeTimeScale {
  const offset = Number.isFinite(rightOffsetRatio) && rightOffsetRatio > 0 ? rightOffsetRatio : 0;
  const anchorSeries = timelineSeries.find((series) => series.timeBasis?.kind === "market");
  const resolved = anchorSeries ? resolveMarketAnchors(anchorSeries) : null;
  if (!anchorSeries || !resolved || resolved.anchors.length === 0) {
    return { kind: "calendar", startTime, endTime, rightOffsetRatio: offset };
  }
  const { cadenceMs, anchors } = resolved;
  const startPosition = positionForTimestamp({ anchors, cadenceMs }, startTime);
  const endPosition = positionForTimestamp({ anchors, cadenceMs }, endTime);
  return {
    kind: "market",
    startTime,
    endTime,
    anchorSeriesId: anchorSeries.id,
    cadenceMs,
    anchors,
    startPosition,
    endPosition: endPosition > startPosition ? endPosition : startPosition + 1,
    rightOffsetRatio: offset,
  };
}

/** Fraction of the visible span held empty after the newest observation. */
export function compositeRightOffsetRatio(scale: CompositeTimeScale): number {
  const ratio = scale.rightOffsetRatio ?? 0;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 0;
}

/** Span the plot's full width covers, viewport plus reserved right offset. */
function projectionSpan(scale: CompositeTimeScale): number {
  const viewportSpan = scale.kind === "calendar"
    ? Math.max(scale.endTime - scale.startTime, 1)
    : Math.max(scale.endPosition - scale.startPosition, Number.EPSILON);
  return viewportSpan * (1 + compositeRightOffsetRatio(scale));
}

/** Slot position of a timestamp on a market scale, or wall-clock time on a calendar scale. */
export function compositeTimePosition(scale: CompositeTimeScale, timestamp: number): number {
  return scale.kind === "calendar" ? timestamp : positionForTimestamp(scale, timestamp);
}

/** Inverse of `compositeTimePosition`. */
export function compositeTimeAtPosition(scale: CompositeTimeScale, position: number): number {
  if (scale.kind === "calendar") return position;
  const anchors = scale.anchors;
  let low = 0;
  let high = anchors.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (anchors[middle]!.position < position) low = middle + 1;
    else high = middle;
  }
  const next = anchors[low];
  const previous = anchors[low - 1];
  if (!previous) {
    return anchors[0]!.timestamp + (position - anchors[0]!.position) * scale.cadenceMs;
  }
  if (!next) {
    const last = anchors.at(-1)!;
    return last.timestamp + (position - last.position) * scale.cadenceMs;
  }
  const positionSpan = next.position - previous.position;
  if (positionSpan <= 0) return previous.timestamp;
  return previous.timestamp
    + (next.timestamp - previous.timestamp) * ((position - previous.position) / positionSpan);
}

export function projectCompositeTimestamp(
  scale: CompositeTimeScale,
  timestamp: number,
  placement: "timestamp" | "next-market-slot" = "timestamp",
): { ratio: number; xSlot?: number } | null {
  if (!Number.isFinite(timestamp)) return null;
  if (scale.kind === "calendar") {
    return { ratio: (timestamp - scale.startTime) / projectionSpan(scale) };
  }

  let position: number;
  let xSlot: number | undefined;
  if (placement === "next-market-slot") {
    const index = lowerBoundAnchor(scale.anchors, timestamp);
    const anchor = scale.anchors[index];
    if (!anchor) return null;
    position = anchor.position;
    xSlot = index;
  } else {
    const index = lowerBoundAnchor(scale.anchors, timestamp);
    const exact = scale.anchors[index];
    position = positionForTimestamp(scale, timestamp);
    if (exact?.timestamp === timestamp) xSlot = index;
  }
  return { ratio: (position - scale.startPosition) / projectionSpan(scale), xSlot };
}

export function unprojectCompositeTimestamp(
  scale: CompositeTimeScale,
  ratio: number,
): number {
  const safeRatio = Math.max(0, Math.min(1, ratio));
  if (scale.kind === "calendar") {
    return scale.startTime + projectionSpan(scale) * safeRatio;
  }
  return compositeTimeAtPosition(scale, scale.startPosition + projectionSpan(scale) * safeRatio);
}
