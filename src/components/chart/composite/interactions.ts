import type { ResolvedSeries } from "../../../time-series/types";
import type { CompositeTimeScale } from "./types";
import {
  buildCompositeTimeScale,
  compositeTimeAtPosition,
  compositeTimePosition,
} from "./time-scale";

export interface CompositeViewportRange {
  start: Date;
  end: Date;
}

export type CompositeChartInteraction =
  | "arm-line"
  | "arm-measure"
  | "arm-pencil"
  | "arm-zoom"
  | "cycle-colour"
  | "clear-cursor"
  | "cursor-left"
  | "cursor-right"
  | "pan-left"
  | "pan-right"
  | "delete-drawing"
  | "reset"
  | "zoom-in"
  | "zoom-out";

export const COMPOSITE_ZOOM_STEP_FACTOR = 1.2;
export const COMPOSITE_KEYBOARD_PAN_RATIO = 0.02;
/** Pixels of trackpad or wheel travel that zoom the viewport by a factor of e. */
const WHEEL_ZOOM_PIXELS_PER_E = 160;
/** Bound on one wheel event so a coarse mouse notch cannot zoom by more than this. */
const WHEEL_ZOOM_STEP_LIMIT = 1.5;

const DAY_MS = 24 * 60 * 60 * 1000;
const FALLBACK_SINGLE_POINT_SPAN_MS = DAY_MS;
/** Bars that stay in view at the deepest zoom. */
const MINIMUM_VISIBLE_BARS = 2;
const WHEEL_PAN_RATIO_PER_DELTA = 0.005;
const MAX_WHEEL_DELTA_MAGNITUDE = 8;
const WHEEL_ZOOM_RATIO_PER_DELTA = 0.04;
const SOURCE_VIEWPORT_RESET_RATIO = 0.01;
const SOURCE_VIEWPORT_RESET_FLOOR_MS = 60_000;

/**
 * The space every navigation gesture works in. Market charts collapse closed
 * sessions, so a position is a bar slot there; calendar charts use wall-clock
 * milliseconds. Data refreshes build a new frame; an in-flight gesture keeps
 * the one it started with, so a refresh can never move the view under the
 * pointer.
 */
export interface CompositeNavigationFrame {
  scale: CompositeTimeScale;
  dataStart: number;
  dataEnd: number;
  dataStartPosition: number;
  dataEndPosition: number;
  minimumSpanPositions: number;
  /** Wall-clock equivalent of `minimumSpanPositions`, for tools that select time ranges. */
  minimumSpanMs: number;
  /** Fraction of the visible span the viewport may extend before the first observation. */
  historicalPaddingRatio: number;
}

function finiteTime(value: Date | undefined): number | null {
  const time = value?.getTime();
  return typeof time === "number" && Number.isFinite(time) ? time : null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function hasRenderableValue(point: ResolvedSeries["points"][number]): boolean {
  return (
    (typeof point.value === "number" && Number.isFinite(point.value))
    || (typeof point.close === "number" && Number.isFinite(point.close))
  );
}

function dataExtent(series: readonly ResolvedSeries[]): { start: number; end: number } | null {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const entry of series) {
    for (const point of entry.points) {
      if (!hasRenderableValue(point)) continue;
      const timestamp = point.date.getTime();
      if (!Number.isFinite(timestamp)) continue;
      if (timestamp < start) start = timestamp;
      if (timestamp > end) end = timestamp;
    }
  }
  return start <= end ? { start, end } : null;
}

function medianStepMs(series: readonly ResolvedSeries[]): number | null {
  const timestamps = new Set<number>();
  for (const entry of series) {
    for (const point of entry.points) {
      if (!hasRenderableValue(point)) continue;
      const timestamp = point.date.getTime();
      if (Number.isFinite(timestamp)) timestamps.add(timestamp);
    }
  }
  const sorted = [...timestamps].sort((left, right) => left - right);
  const steps: number[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const step = sorted[index]! - sorted[index - 1]!;
    if (step > 0) steps.push(step);
  }
  if (steps.length === 0) return null;
  steps.sort((left, right) => left - right);
  // An upper median keeps one near-duplicate live observation from lowering
  // a daily chart's zoom floor.
  return steps[Math.floor(steps.length / 2)]!;
}

export function buildCompositeNavigationFrame(
  series: readonly ResolvedSeries[],
  timelineSeries: readonly ResolvedSeries[],
  options: { historicalPaddingRatio?: number } = {},
): CompositeNavigationFrame | null {
  const extent = dataExtent(series);
  if (!extent) return null;
  const scale = buildCompositeTimeScale(timelineSeries, extent.start, extent.end);
  const dataStartPosition = compositeTimePosition(scale, extent.start);
  const dataEndPosition = compositeTimePosition(scale, extent.end);
  const minimumSpanMs = scale.kind === "market"
    ? scale.cadenceMs * MINIMUM_VISIBLE_BARS
    : (medianStepMs(series) ?? FALLBACK_SINGLE_POINT_SPAN_MS) * MINIMUM_VISIBLE_BARS;
  const minimumSpanPositions = scale.kind === "market" ? MINIMUM_VISIBLE_BARS : minimumSpanMs;
  return {
    scale,
    dataStart: extent.start,
    dataEnd: extent.end,
    dataStartPosition,
    dataEndPosition,
    minimumSpanPositions: Math.max(minimumSpanPositions, Number.EPSILON),
    minimumSpanMs: Math.max(minimumSpanMs, 1),
    historicalPaddingRatio: Math.max(options.historicalPaddingRatio ?? 0, 0),
  };
}

export function compositeNavigationDataViewport(frame: CompositeNavigationFrame): CompositeViewportRange {
  if (frame.dataStart < frame.dataEnd) {
    return { start: new Date(frame.dataStart), end: new Date(frame.dataEnd) };
  }
  return {
    start: new Date(frame.dataStart - FALLBACK_SINGLE_POINT_SPAN_MS / 2),
    end: new Date(frame.dataEnd + FALLBACK_SINGLE_POINT_SPAN_MS / 2),
  };
}

interface PositionRange {
  start: number;
  end: number;
}

export function compositeViewportPositions(
  frame: CompositeNavigationFrame,
  viewport: CompositeViewportRange,
): PositionRange | null {
  const startTime = finiteTime(viewport.start);
  const endTime = finiteTime(viewport.end);
  if (startTime === null || endTime === null || startTime > endTime) return null;
  const start = compositeTimePosition(frame.scale, startTime);
  const end = compositeTimePosition(frame.scale, endTime);
  return { start, end: Math.max(end, start) };
}

function viewportFromPositions(frame: CompositeNavigationFrame, range: PositionRange): CompositeViewportRange {
  return {
    start: new Date(Math.round(compositeTimeAtPosition(frame.scale, range.start))),
    end: new Date(Math.round(compositeTimeAtPosition(frame.scale, range.end))),
  };
}

function clampPositions(
  frame: CompositeNavigationFrame,
  range: PositionRange,
  paddingRatio: number,
): PositionRange {
  const dataSpan = Math.max(frame.dataEndPosition - frame.dataStartPosition, 0);
  const maximumSpan = Math.max(dataSpan * (1 + paddingRatio), frame.minimumSpanPositions);
  const span = clamp(range.end - range.start, frame.minimumSpanPositions, maximumSpan);
  let start = Math.max(range.start, frame.dataStartPosition - span * paddingRatio);
  // The newest observation is the hard edge: nothing lies beyond it yet.
  start = Math.min(start, frame.dataEndPosition - span);
  return { start, end: start + span };
}

/**
 * Fits an authored viewport to the loaded data, keeping its wall-clock span:
 * a one-day window that ends after the close still shows one session. One
 * that misses the data entirely is left alone so the time axis still says
 * where the chart is and navigation can bring it back.
 */
export function clampCompositeViewport(
  frame: CompositeNavigationFrame,
  viewport: CompositeViewportRange,
): CompositeViewportRange {
  const data = compositeNavigationDataViewport(frame);
  const startTime = finiteTime(viewport.start);
  const endTime = finiteTime(viewport.end);
  if (startTime === null || endTime === null || startTime > endTime) return data;
  const overlapsData = endTime >= frame.dataStart && startTime <= frame.dataEnd;
  if (!overlapsData) return viewport;
  const dataStart = data.start.getTime();
  const dataEnd = data.end.getTime();
  const span = Math.min(endTime - startTime, dataEnd - dataStart);
  const start = clamp(startTime, dataStart, dataEnd - span);
  return start === startTime && start + span === endTime
    ? viewport
    : { start: new Date(start), end: new Date(start + span) };
}

export function sameCompositeViewport(
  left: CompositeViewportRange | null | undefined,
  right: CompositeViewportRange | null | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.start.getTime() === right.start.getTime()
    && left.end.getTime() === right.end.getTime();
}

/**
 * Positive deltas move toward older observations, matching the legacy chart:
 * dragging right or scrolling up/left reveals earlier dates.
 */
export function panCompositeViewport(
  frame: CompositeNavigationFrame,
  viewport: CompositeViewportRange,
  deltaPositions: number,
): CompositeViewportRange {
  const positions = compositeViewportPositions(frame, viewport);
  if (!positions) return compositeNavigationDataViewport(frame);
  const shift = Number.isFinite(deltaPositions) ? deltaPositions : 0;
  const clamped = clampPositions(
    frame,
    { start: positions.start - shift, end: positions.end - shift },
    frame.historicalPaddingRatio,
  );
  return viewportFromPositions(frame, clamped);
}

export function zoomCompositeViewport(
  frame: CompositeNavigationFrame,
  viewport: CompositeViewportRange,
  zoomFactor: number,
  anchorRatio: number,
): CompositeViewportRange {
  const positions = compositeViewportPositions(frame, viewport);
  if (!positions) return compositeNavigationDataViewport(frame);
  if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) return viewport;
  const span = Math.max(positions.end - positions.start, frame.minimumSpanPositions);
  const ratio = clamp(anchorRatio, 0, 1);
  const anchor = positions.start + span * ratio;
  const nextSpan = span / zoomFactor;
  const clamped = clampPositions(
    frame,
    { start: anchor - nextSpan * ratio, end: anchor + nextSpan * (1 - ratio) },
    frame.historicalPaddingRatio,
  );
  return viewportFromPositions(frame, clamped);
}

export function fitCompositeViewport(
  frame: CompositeNavigationFrame,
  viewport: CompositeViewportRange,
): CompositeViewportRange {
  const positions = compositeViewportPositions(frame, viewport);
  if (!positions) return compositeNavigationDataViewport(frame);
  return viewportFromPositions(frame, clampPositions(frame, positions, frame.historicalPaddingRatio));
}

export interface CompositeWheelGesture {
  direction: "up" | "down" | "left" | "right";
  delta?: number;
  /** Signed pixel deltas when the host reports them; terminals report notches only. */
  deltaX?: number;
  deltaY?: number;
}

/**
 * Pan distance for one wheel event as a fraction of the visible span. Pixel
 * hosts move the plot exactly as far as the fingers travelled, so the sum of
 * both axes pans and a diagonal swipe never flickers between them. Notch hosts
 * step a bounded fraction per event.
 */
export function resolveCompositeWheelPan(
  gesture: CompositeWheelGesture,
  plotPixelWidth: number,
): number {
  if (typeof gesture.deltaX === "number" && typeof gesture.deltaY === "number") {
    const travel = gesture.deltaX + gesture.deltaY;
    if (!Number.isFinite(travel) || plotPixelWidth <= 0) return 0;
    return -travel / plotPixelWidth;
  }
  const rawMagnitude = Math.abs(gesture.delta ?? 1);
  const magnitude = clamp(rawMagnitude > 0 ? rawMagnitude : 1, 1, MAX_WHEEL_DELTA_MAGNITUDE);
  const directionSign = gesture.direction === "up" || gesture.direction === "left" ? 1 : -1;
  return directionSign * magnitude * WHEEL_PAN_RATIO_PER_DELTA;
}

/** Zoom factor for one modifier-wheel or pinch event; greater than one zooms in. */
export function resolveCompositeWheelZoom(gesture: CompositeWheelGesture): number {
  if (typeof gesture.deltaY === "number") {
    if (!Number.isFinite(gesture.deltaY) || gesture.deltaY === 0) return 1;
    return clamp(
      Math.exp(-gesture.deltaY / WHEEL_ZOOM_PIXELS_PER_E),
      1 / WHEEL_ZOOM_STEP_LIMIT,
      WHEEL_ZOOM_STEP_LIMIT,
    );
  }
  const magnitude = clamp(Math.abs(gesture.delta ?? 1), 1, MAX_WHEEL_DELTA_MAGNITUDE);
  const step = 1 + magnitude * WHEEL_ZOOM_RATIO_PER_DELTA;
  return gesture.direction === "up" ? step : 1 / step;
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
  if (shifted && key === "d") return "arm-line";
  if (shifted && key === "p") return "arm-pencil";
  if (key === "backspace") return "delete-drawing";
  if (key === "c" && !event.shift) return "cycle-colour";
  if (event.shift) return null;
  if (key === "a") return "pan-left";
  if (key === "d") return "pan-right";
  if (key === "0") return "reset";
  if (key === "escape") return "clear-cursor";
  return null;
}
