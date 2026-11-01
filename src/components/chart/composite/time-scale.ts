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

/** A series' anchors, and what they were worked out from, so the next tick redoes only its tail. */
interface MarketAnchorBuild {
  timeZone: string;
  configuredCadence: number | undefined;
  timestamps: number[];
  sessionDates: string[];
  /** The gaps between consecutive anchors, in ascending order: the cadence is their median. */
  sameSessionGaps: number[];
  allGaps: number[];
  cadenceMs: number;
  historyMsPerSlot: number;
  anchors: MarketAnchors;
}

interface CachedMarketAnchors {
  points: readonly ResolvedSeries["points"][number][];
  pointCount: number;
  lastTimestamp: number | null;
  build: MarketAnchorBuild;
}

const anchorCache = new WeakMap<ResolvedSeries, CachedMarketAnchors>();
/**
 * The last anchors built over a history, by its first point: a live chart
 * resolves a new series around the same history points on a tick that adds
 * a bar, and its anchors differ from the last ones only at the end.
 */
const anchorsByFirstPoint = new WeakMap<ResolvedSeries["points"][number], MarketAnchorBuild>();
/** Past this many changed anchors, building them again costs less than patching. */
const MAX_PATCHED_ANCHORS = 32;

function finiteTimestamp(value: Date): number | null {
  const timestamp = value.getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function uniqueSeriesTimestamps(series: ResolvedSeries): number[] {
  // A market series comes in time order: its timestamps are already unique and sorted.
  const ordered: number[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (const point of series.points) {
    const timestamp = finiteTimestamp(point.date);
    if (timestamp === null) continue;
    if (timestamp <= previous) return sortedUniqueSeriesTimestamps(series);
    ordered.push(timestamp);
    previous = timestamp;
  }
  return ordered;
}

function sortedUniqueSeriesTimestamps(series: ResolvedSeries): number[] {
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

/** The median of positive gaps already in ascending order. */
function sortedMedian(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function sortedIndex(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (sorted[middle]! < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function insertSorted(sorted: number[], value: number): void {
  sorted.splice(sortedIndex(sorted, value), 0, value);
}

function removeSorted(sorted: number[], value: number): void {
  const index = sortedIndex(sorted, value);
  if (sorted[index] === value) sorted.splice(index, 1);
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

/**
 * `lowerBoundAnchor` for a timestamp no earlier than the one `hint` was found
 * for: a run of timestamps in time order steps on from the last anchor rather
 * than searching again.
 */
function lowerBoundAnchorFrom(
  anchors: MarketAnchors,
  timestamp: number,
  hint: number,
): number {
  if (hint > anchors.length || (hint > 0 && anchors[hint - 1]!.timestamp >= timestamp)) {
    return lowerBoundAnchor(anchors, timestamp);
  }
  let low = hint;
  for (let step = 0; step < 4; step += 1) {
    if (low >= anchors.length || anchors[low]!.timestamp >= timestamp) return low;
    low += 1;
  }
  let high = anchors.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (anchors[middle]!.timestamp < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

type MarketScaleSlots = Pick<Extract<CompositeTimeScale, { kind: "market" }>, "anchors" | "cadenceMs" | "historyMsPerSlot">;

function positionForTimestamp(scale: MarketScaleSlots, timestamp: number): number {
  return positionAtAnchor(scale, timestamp, lowerBoundAnchor(scale.anchors, timestamp));
}

/** The slot position of `timestamp`, given `index`, its lower bound among the anchors. */
function positionAtAnchor(scale: MarketScaleSlots, timestamp: number, index: number): number {
  const { anchors, cadenceMs } = scale;
  const next = anchors[index];
  if (next?.timestamp === timestamp) return next.position;
  const previous = anchors[index - 1];
  if (!previous) {
    return anchors[0]!.position + (timestamp - anchors[0]!.timestamp) / (scale.historyMsPerSlot ?? cadenceMs);
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

/**
 * Wall-clock time per slot across the loaded bars, nights and weekends
 * included. History not loaded yet is laid out at this rate: at the bar
 * cadence instead, a view panned into it would hold a few days where it held
 * weeks, and squeeze shut when the bars arrive.
 */
function averageMsPerSlot(anchors: MarketAnchors, cadenceMs: number): number {
  const first = anchors[0];
  const last = anchors.at(-1);
  if (!first || !last || last.position <= first.position) return cadenceMs;
  return Math.max(cadenceMs, (last.timestamp - first.timestamp) / (last.position - first.position));
}

function buildMarketAnchors(
  series: ResolvedSeries,
  timeZone: string,
  previous: MarketAnchorBuild | undefined,
): MarketAnchorBuild {
  const timestamps = uniqueSeriesTimestamps(series);
  const configuredCadence = series.timeBasis?.cadenceMs;
  // The anchors a tick leaves alone: those before the first timestamp it moved or added.
  let shared = 0;
  if (previous && previous.timeZone === timeZone && previous.configuredCadence === configuredCadence) {
    const limit = Math.min(previous.timestamps.length, timestamps.length);
    while (shared < limit && previous.timestamps[shared] === timestamps[shared]) shared += 1;
    if (previous.timestamps.length - shared + timestamps.length - shared > MAX_PATCHED_ANCHORS) shared = 0;
  }
  const base = shared > 0 ? previous! : null;
  const sessionDates = base ? base.sessionDates.slice(0, shared) : [];
  for (let index = sessionDates.length; index < timestamps.length; index += 1) {
    sessionDates.push(sessionDate(timestamps[index]!, timeZone));
  }
  const sameSessionGaps = base ? base.sameSessionGaps.slice() : [];
  const allGaps = base ? base.allGaps.slice() : [];
  if (base) {
    for (let index = shared; index < base.timestamps.length; index += 1) {
      const gap = base.timestamps[index]! - base.timestamps[index - 1]!;
      if (gap <= 0) continue;
      removeSorted(allGaps, gap);
      if (base.sessionDates[index - 1] === base.sessionDates[index]) removeSorted(sameSessionGaps, gap);
    }
  }
  for (let index = Math.max(shared, 1); index < timestamps.length; index += 1) {
    const gap = timestamps[index]! - timestamps[index - 1]!;
    if (gap <= 0) continue;
    if (base) insertSorted(allGaps, gap);
    else allGaps.push(gap);
    if (sessionDates[index - 1] === sessionDates[index]) {
      if (base) insertSorted(sameSessionGaps, gap);
      else sameSessionGaps.push(gap);
    }
  }
  if (!base) {
    allGaps.sort((left, right) => left - right);
    sameSessionGaps.sort((left, right) => left - right);
  }
  const cadenceMs = typeof configuredCadence === "number"
    && Number.isFinite(configuredCadence)
    && configuredCadence > 0
    ? configuredCadence
    : sortedMedian(sameSessionGaps) ?? sortedMedian(allGaps) ?? DAY_MS;

  // Each slot follows from the one before it, so with the cadence unchanged
  // the shared anchors keep their places.
  const anchors: MarketAnchors = base && base.cadenceMs === cadenceMs ? base.anchors.slice(0, shared) : [];
  let position = anchors.at(-1)?.position ?? 0;
  for (let index = anchors.length; index < timestamps.length; index += 1) {
    const timestamp = timestamps[index]!;
    if (index > 0) {
      const previousTimestamp = timestamps[index - 1]!;
      position += sessionDates[index - 1] === sessionDates[index]
        ? Math.max((timestamp - previousTimestamp) / cadenceMs, MINIMUM_SLOT_FRACTION)
        : 1;
    }
    anchors.push({ timestamp, position });
  }
  return {
    timeZone,
    configuredCadence,
    timestamps,
    sessionDates,
    sameSessionGaps,
    allGaps,
    cadenceMs,
    historyMsPerSlot: averageMsPerSlot(anchors, cadenceMs),
    anchors,
  };
}

/**
 * Anchor slots for a market series, cached on the series object. Live ticks
 * mutate the last point in place, so the cache also keys on the point count
 * and the last timestamp; a tick then redoes only the anchors it moved.
 */
function resolveMarketAnchors(
  series: ResolvedSeries,
): { cadenceMs: number; historyMsPerSlot: number; anchors: MarketAnchors; timeZone: string } | null {
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
    && cached.build.timeZone === timeZone
    && cached.build.configuredCadence === configuredCadence
  ) {
    const { cadenceMs, historyMsPerSlot, anchors } = cached.build;
    return { cadenceMs, historyMsPerSlot, anchors, timeZone };
  }
  const firstPoint = series.points[0];
  const build = buildMarketAnchors(series, timeZone, cached?.build ?? (firstPoint ? anchorsByFirstPoint.get(firstPoint) : undefined));
  anchorCache.set(series, {
    points: series.points,
    pointCount: series.points.length,
    lastTimestamp,
    build,
  });
  if (firstPoint) anchorsByFirstPoint.set(firstPoint, build);
  return { cadenceMs: build.cadenceMs, historyMsPerSlot: build.historyMsPerSlot, anchors: build.anchors, timeZone };
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
  const { cadenceMs, historyMsPerSlot, anchors } = resolved;
  const startPosition = positionForTimestamp({ anchors, cadenceMs, historyMsPerSlot }, startTime);
  const endPosition = positionForTimestamp({ anchors, cadenceMs, historyMsPerSlot }, endTime);
  return {
    kind: "market",
    startTime,
    endTime,
    anchorSeriesId: anchorSeries.id,
    cadenceMs,
    historyMsPerSlot,
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
    return anchors[0]!.timestamp + (position - anchors[0]!.position) * (scale.historyMsPerSlot ?? scale.cadenceMs);
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

type CompositeTimePlacement = "timestamp" | "next-market-slot";
type ProjectedTimestamp = { ratio: number; xSlot?: number };

function projectMarketTimestamp(
  scale: Extract<CompositeTimeScale, { kind: "market" }>,
  timestamp: number,
  placement: CompositeTimePlacement,
  index: number,
  span: number,
): ProjectedTimestamp | null {
  let position: number;
  let xSlot: number | undefined;
  if (placement === "next-market-slot") {
    const anchor = scale.anchors[index];
    if (!anchor) return null;
    position = anchor.position;
    xSlot = index;
  } else {
    const exact = scale.anchors[index];
    position = positionAtAnchor(scale, timestamp, index);
    if (exact?.timestamp === timestamp) xSlot = index;
  }
  return { ratio: (position - scale.startPosition) / span, xSlot };
}

export function projectCompositeTimestamp(
  scale: CompositeTimeScale,
  timestamp: number,
  placement: CompositeTimePlacement = "timestamp",
): ProjectedTimestamp | null {
  if (!Number.isFinite(timestamp)) return null;
  if (scale.kind === "calendar") {
    return { ratio: (timestamp - scale.startTime) / projectionSpan(scale) };
  }
  return projectMarketTimestamp(scale, timestamp, placement, lowerBoundAnchor(scale.anchors, timestamp), projectionSpan(scale));
}

/**
 * `projectCompositeTimestamp` for many timestamps on one scale. Fed in time
 * order, as a series' points and a scene's dates are, each finds its anchor
 * by stepping on from the last one's instead of searching the scale again.
 */
export function compositeTimeProjector(
  scale: CompositeTimeScale,
  placement: CompositeTimePlacement = "timestamp",
): (timestamp: number) => ProjectedTimestamp | null {
  const span = projectionSpan(scale);
  if (scale.kind === "calendar") {
    return (timestamp) => Number.isFinite(timestamp) ? { ratio: (timestamp - scale.startTime) / span } : null;
  }
  let hint = 0;
  return (timestamp) => {
    if (!Number.isFinite(timestamp)) return null;
    hint = lowerBoundAnchorFrom(scale.anchors, timestamp, hint);
    return projectMarketTimestamp(scale, timestamp, placement, hint, span);
  };
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
