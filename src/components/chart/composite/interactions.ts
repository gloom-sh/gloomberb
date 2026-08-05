import type { ResolvedSeries } from "../../../time-series/types";
import {
  buildCompositeTimeScale,
  projectCompositeTimestamp,
  unprojectCompositeTimestamp,
} from "./time-scale";

export interface CompositeViewportRange {
  start: Date;
  end: Date;
}

export type CompositeChartInteraction =
  | "arm-measure"
  | "arm-zoom"
  | "clear-cursor"
  | "cursor-left"
  | "cursor-right"
  | "pan-left"
  | "pan-right"
  | "reset"
  | "zoom-in"
  | "zoom-out";

export const COMPOSITE_ZOOM_STEP_FACTOR = 1.2;
export const COMPOSITE_KEYBOARD_PAN_RATIO = 0.02;

const FALLBACK_SINGLE_POINT_SPAN_MS = 24 * 60 * 60 * 1000;
const WHEEL_PAN_RATIO_PER_DELTA = 0.005;
const MAX_WHEEL_DELTA_MAGNITUDE = 8;
const SOURCE_VIEWPORT_RESET_RATIO = 0.01;
const SOURCE_VIEWPORT_RESET_FLOOR_MS = 60_000;

function finiteTime(value: Date | undefined): number | null {
  const time = value?.getTime();
  return typeof time === "number" && Number.isFinite(time) ? time : null;
}

function normalizeViewport(
  viewport: CompositeViewportRange | null | undefined,
): CompositeViewportRange | null {
  const start = finiteTime(viewport?.start);
  const end = finiteTime(viewport?.end);
  if (start === null || end === null || start > end) return null;
  if (start < end) {
    return { start: new Date(start), end: new Date(end) };
  }
  return {
    start: new Date(start - FALLBACK_SINGLE_POINT_SPAN_MS / 2),
    end: new Date(end + FALLBACK_SINGLE_POINT_SPAN_MS / 2),
  };
}

function hasRenderableValue(point: ResolvedSeries["points"][number]): boolean {
  return (
    (typeof point.value === "number" && Number.isFinite(point.value))
    || (typeof point.close === "number" && Number.isFinite(point.close))
  );
}

function pointTimestamps(series: ResolvedSeries[]): number[] {
  const timestamps = new Set<number>();
  for (const entry of series) {
    for (const point of entry.points) {
      if (!hasRenderableValue(point)) continue;
      const timestamp = point.date instanceof Date
        ? point.date.getTime()
        : new Date(point.date).getTime();
      if (Number.isFinite(timestamp)) timestamps.add(timestamp);
    }
  }
  return [...timestamps].sort((left, right) => left - right);
}

function viewportHasTimestamps(
  timestamps: readonly number[],
  viewport: CompositeViewportRange,
  minimumCount: number,
): boolean {
  const start = finiteTime(viewport.start);
  const end = finiteTime(viewport.end);
  if (start === null || end === null || start > end) return false;
  const required = Math.max(1, Math.floor(minimumCount));
  let count = 0;
  for (const timestamp of timestamps) {
    if (timestamp < start) continue;
    if (timestamp > end) break;
    count += 1;
    if (count >= required) return true;
  }
  return false;
}

export function compositeViewportHasObservations(
  series: ResolvedSeries[],
  viewport: CompositeViewportRange,
  minimumCount = 2,
): boolean {
  return viewportHasTimestamps(pointTimestamps(series), viewport, minimumCount);
}

export function resolveCompositeNavigationBounds(
  series: ResolvedSeries[],
  requestedViewport?: CompositeViewportRange | null,
  options: { historicalPaddingRatio?: number } = {},
): CompositeViewportRange | null {
  const requested = normalizeViewport(requestedViewport);
  const timestamps = pointTimestamps(series);
  if (timestamps.length === 0) return requested;
  const data = normalizeViewport({
    start: new Date(timestamps[0]!),
    end: new Date(timestamps.at(-1)!),
  });
  if (!requested) return data;
  if (!data) return requested;
  const overlapsData = requested.end.getTime() >= data.start.getTime()
    && requested.start.getTime() <= data.end.getTime();
  // Loaded series can include a buffer outside the authored viewport. Use the
  // complete real-data extent when the two ranges overlap. A disjoint request
  // keeps its own window, unioned with the data so navigation can always get
  // back: bounds equal to an observation-free window strand pan and zoom.
  if (!overlapsData) {
    return {
      start: new Date(Math.min(data.start.getTime(), requested.start.getTime())),
      end: new Date(Math.max(data.end.getTime(), requested.end.getTime())),
    };
  }
  const paddingRatio = Math.max(options.historicalPaddingRatio ?? 0, 0);
  if (paddingRatio === 0) return data;
  const requestedSpan = Math.max(requested.end.getTime() - requested.start.getTime(), 1);
  return {
    start: new Date(Math.min(data.start.getTime(), requested.start.getTime()) - requestedSpan * paddingRatio),
    end: data.end,
  };
}

export function resolveCompositeMinimumSpanMs(
  series: ResolvedSeries[],
  bounds: CompositeViewportRange,
): number {
  const start = bounds.start.getTime();
  const end = bounds.end.getTime();
  const timestamps = pointTimestamps(series).filter((timestamp) => timestamp >= start && timestamp <= end);
  const steps: number[] = [];
  for (let index = 1; index < timestamps.length; index += 1) {
    const step = timestamps[index]! - timestamps[index - 1]!;
    if (step > 0) steps.push(step);
  }
  const boundsSpan = Math.max(end - start, 1);
  steps.sort((left, right) => left - right);
  // Use an observed upper median rather than the absolute minimum. This keeps
  // one near-duplicate live observation from lowering a daily chart's floor.
  const representativeStep = steps[Math.floor(steps.length / 2)];
  return representativeStep !== undefined
    ? Math.min(Math.max(representativeStep, 1), boundsSpan)
    : Math.max(Math.min(boundsSpan, FALLBACK_SINGLE_POINT_SPAN_MS), 1);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function marketViewportProjection(
  viewport: CompositeViewportRange,
  bounds: CompositeViewportRange,
  series: ResolvedSeries[] | undefined,
): {
  scale: Extract<ReturnType<typeof buildCompositeTimeScale>, { kind: "market" }>;
  startRatio: number;
  endRatio: number;
} | null {
  if (!series?.some((entry) => entry.timeBasis?.kind === "market")) return null;
  const scale = buildCompositeTimeScale(
    series,
    bounds.start.getTime(),
    bounds.end.getTime(),
  );
  if (scale.kind !== "market") return null;
  const startRatio = projectCompositeTimestamp(scale, viewport.start.getTime())?.ratio;
  const endRatio = projectCompositeTimestamp(scale, viewport.end.getTime())?.ratio;
  if (
    typeof startRatio !== "number"
    || !Number.isFinite(startRatio)
    || typeof endRatio !== "number"
    || !Number.isFinite(endRatio)
    || startRatio >= endRatio
  ) {
    return null;
  }
  return { scale, startRatio, endRatio };
}

function viewportFromMarketRatios(
  scale: Extract<ReturnType<typeof buildCompositeTimeScale>, { kind: "market" }>,
  startRatio: number,
  endRatio: number,
): CompositeViewportRange {
  return {
    start: new Date(unprojectCompositeTimestamp(scale, startRatio)),
    end: new Date(unprojectCompositeTimestamp(scale, endRatio)),
  };
}

export function clampCompositeViewport(
  viewport: CompositeViewportRange,
  bounds: CompositeViewportRange,
): CompositeViewportRange {
  const boundsStart = bounds.start.getTime();
  const boundsEnd = bounds.end.getTime();
  const boundsSpan = Math.max(boundsEnd - boundsStart, 1);
  const rawRequestedStart = viewport.start.getTime();
  const rawRequestedEnd = viewport.end.getTime();
  const hasValidViewport = Number.isFinite(rawRequestedStart)
    && Number.isFinite(rawRequestedEnd)
    && rawRequestedStart <= rawRequestedEnd;
  const requestedStart = hasValidViewport ? rawRequestedStart : boundsStart;
  const requestedEnd = hasValidViewport ? rawRequestedEnd : boundsEnd;
  const requestedSpan = Math.max(requestedEnd - requestedStart, 1);
  const span = Math.min(requestedSpan, boundsSpan);
  const start = clamp(requestedStart, boundsStart, boundsEnd - span);
  return {
    start: new Date(start),
    end: new Date(start + span),
  };
}

export function sameCompositeViewport(
  left: CompositeViewportRange | null | undefined,
  right: CompositeViewportRange | null | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.start.getTime() === right.start.getTime()
    && left.end.getTime() === right.end.getTime();
}

export function zoomCompositeViewport(
  viewport: CompositeViewportRange,
  bounds: CompositeViewportRange,
  zoomFactor: number,
  anchorRatio: number,
  minimumSpanMs: number,
  series?: ResolvedSeries[],
): CompositeViewportRange {
  const current = clampCompositeViewport(viewport, bounds);
  if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) return current;

  const start = current.start.getTime();
  const end = current.end.getTime();
  const boundsSpan = Math.max(bounds.end.getTime() - bounds.start.getTime(), 1);
  const currentSpan = Math.max(end - start, 1);
  const ratio = clamp(anchorRatio, 0, 1);
  const marketProjection = marketViewportProjection(current, bounds, series);
  const candidate = marketProjection
    ? (() => {
        const {
          scale,
          startRatio,
          endRatio,
        } = marketProjection;
        const currentMarketSpan = endRatio - startRatio;
        const totalMarketPositions = Math.max(
          scale.endPosition - scale.startPosition,
          Number.EPSILON,
        );
        const minimumMarketSpan = clamp(
          Math.max(minimumSpanMs, 1) / scale.cadenceMs / totalMarketPositions,
          Number.EPSILON,
          1,
        );
        const nextMarketSpan = clamp(
          currentMarketSpan / zoomFactor,
          minimumMarketSpan,
          1,
        );
        const anchor = startRatio + currentMarketSpan * ratio;
        const candidateStart = clamp(
          anchor - nextMarketSpan * ratio,
          0,
          1 - nextMarketSpan,
        );
        return viewportFromMarketRatios(
          scale,
          candidateStart,
          candidateStart + nextMarketSpan,
        );
      })()
    : (() => {
        const nextSpan = clamp(
          currentSpan / zoomFactor,
          Math.min(Math.max(minimumSpanMs, 1), boundsSpan),
          boundsSpan,
        );
        const anchor = start + currentSpan * ratio;
        return clampCompositeViewport({
          start: new Date(anchor - nextSpan * ratio),
          end: new Date(anchor + nextSpan * (1 - ratio)),
        }, bounds);
      })();
  if (!series) return candidate;

  const timestamps = pointTimestamps(series)
    .filter((timestamp) => timestamp >= bounds.start.getTime() && timestamp <= bounds.end.getTime());
  if (timestamps.length < 2 || viewportHasTimestamps(timestamps, candidate, 2)) {
    return candidate;
  }

  const currentHasObservations = viewportHasTimestamps(timestamps, current, 2);
  const candidateSpan = candidate.end.getTime() - candidate.start.getTime();
  // An adaptive response can invalidate an existing viewport. Let zoom-out
  // keep expanding from that state until observations re-enter the window.
  if (!currentHasObservations && candidateSpan > currentSpan) return candidate;
  return current;
}

/**
 * Positive ratios move toward older observations, matching the legacy chart:
 * dragging right or scrolling up/left reveals earlier dates.
 */
export function panCompositeViewport(
  viewport: CompositeViewportRange,
  bounds: CompositeViewportRange,
  shiftRatio: number,
  series?: ResolvedSeries[],
  allowEmpty = false,
): CompositeViewportRange {
  const current = clampCompositeViewport(viewport, bounds);
  if (!Number.isFinite(shiftRatio) || shiftRatio === 0) return current;
  const marketProjection = marketViewportProjection(current, bounds, series);
  // Market scales collapse overnight and weekend gaps, so a wall-clock shift
  // changes how many slots stay visible and the plot accordions instead of
  // translating. Shift in slot space so the visible span is preserved.
  const candidate = marketProjection
    ? (() => {
        const { scale, startRatio, endRatio } = marketProjection;
        const marketSpan = endRatio - startRatio;
        const nextStart = clamp(startRatio - marketSpan * shiftRatio, 0, 1 - marketSpan);
        return clampCompositeViewport(
          viewportFromMarketRatios(scale, nextStart, nextStart + marketSpan),
          bounds,
        );
      })()
    : (() => {
        const shift = Math.max(current.end.getTime() - current.start.getTime(), 1) * shiftRatio;
        return clampCompositeViewport({
          start: new Date(current.start.getTime() - shift),
          end: new Date(current.end.getTime() - shift),
        }, bounds);
      })();
  if (!series || allowEmpty) return candidate;

  const timestamps = pointTimestamps(series)
    .filter((timestamp) => timestamp >= bounds.start.getTime() && timestamp <= bounds.end.getTime());
  return timestamps.length < 2 || viewportHasTimestamps(timestamps, candidate, 2)
    ? candidate
    : current;
}

export function resolveCompositeWheelPanRatio(
  direction: "up" | "down" | "left" | "right",
  delta: number | undefined,
): number {
  const rawMagnitude = Math.abs(delta ?? 1);
  const magnitude = clamp(rawMagnitude > 0 ? rawMagnitude : 1, 1, MAX_WHEEL_DELTA_MAGNITUDE);
  const directionSign = direction === "up" || direction === "left" ? 1 : -1;
  return directionSign * magnitude * WHEEL_PAN_RATIO_PER_DELTA;
}

export function shouldResetCompositeViewport(
  previous: CompositeViewportRange | null,
  next: CompositeViewportRange | null,
): boolean {
  if (!previous || !next) return previous !== next;
  const previousSpan = Math.max(previous.end.getTime() - previous.start.getTime(), 1);
  const nextSpan = Math.max(next.end.getTime() - next.start.getTime(), 1);
  const tolerance = Math.max(
    SOURCE_VIEWPORT_RESET_FLOOR_MS,
    Math.max(previousSpan, nextSpan) * SOURCE_VIEWPORT_RESET_RATIO,
  );
  return Math.abs(previousSpan - nextSpan) > tolerance
    || Math.abs(previous.start.getTime() - next.start.getTime()) > tolerance
    || Math.abs(previous.end.getTime() - next.end.getTime()) > tolerance;
}

export function resolveCompositeChartInteraction(event: {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  super?: boolean;
  shift?: boolean;
  targetEditable?: boolean;
  defaultPrevented?: boolean;
  propagationStopped?: boolean;
}): CompositeChartInteraction | null {
  if (
    event.defaultPrevented
    || event.propagationStopped
    || event.targetEditable
    || event.ctrl
    || event.meta
    || event.alt
    || event.super
  ) {
    return null;
  }

  const name = event.name ?? "";
  const sequence = event.sequence ?? "";
  if ([name, sequence].some((key) => key === "=" || key === "+" || key === "plus")) {
    return "zoom-in";
  }
  if ([name, sequence].some((key) => key === "-" || key === "_" || key === "minus")) {
    return "zoom-out";
  }

  const key = (name || sequence).toLowerCase();
  if (key === "left") return event.shift ? "pan-left" : "cursor-left";
  if (key === "right") return event.shift ? "pan-right" : "cursor-right";
  // Terminals reserve shift-drag and option-drag for their own selection, so the
  // pointer tools also need a keyboard path that always reaches the app. Without
  // the kitty keyboard protocol a shifted letter arrives uppercase and unflagged.
  const shifted = event.shift || name === name.toUpperCase() && name !== key;
  if (shifted && key === "m") return "arm-measure";
  if (shifted && key === "z") return "arm-zoom";
  if (event.shift) return null;
  if (key === "a") return "pan-left";
  if (key === "d") return "pan-right";
  if (key === "0") return "reset";
  if (key === "escape") return "clear-cursor";
  return null;
}
