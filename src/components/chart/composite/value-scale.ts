import type { PanelScale, ResolvedSeries } from "../../../time-series/types";
import type { CompositeAxisSide } from "./types";
import { clamp } from "../../../utils/math";

/** What a value axis shows, in its own values. */
export interface CompositeValueRange {
  min: number;
  max: number;
}

/**
 * A value axis stretched or squeezed by hand, and what it plots: a range set
 * for one listing's prices means nothing for another's, so it holds only
 * while the axis plots the same series in the same unit and scale.
 */
export interface CompositeManualValueScale extends CompositeValueRange {
  key: string;
}

/** Manual value scales by panel and side (`valueScaleSlot`). */
export type CompositeValueScales = Readonly<Record<string, CompositeManualValueScale>>;

export const NO_VALUE_SCALES: CompositeValueScales = Object.freeze({});

export function valueScaleSlot(panelId: string, side: CompositeAxisSide): string {
  return `${panelId}\u0000${side}`;
}

/** Identifies what an axis plots, for `CompositeManualValueScale.key`. */
export function valueScaleKey(scale: PanelScale, axisSeries: readonly ResolvedSeries[]): string {
  return [
    scale,
    ...axisSeries.map((entry) => [entry.id, entry.label, entry.unit, entry.listing?.symbol ?? ""].join("\u0001")),
  ].join("\u0000");
}

/** Pixels of drag along an axis that stretch or squeeze it by a factor of e. */
const AXIS_DRAG_PIXELS_PER_E = 200;
/** The finest and coarsest a linear axis may get, against the size of the values it shows. */
const MIN_LINEAR_SPAN_RATIO = 1e-9;
const MAX_LINEAR_SPAN = 1e15;
/** The same for a log axis, in natural-log units. */
const MIN_LOG_SPAN = 1e-9;
const MAX_LOG_SPAN = 60;

/**
 * How much a drag of `deltaPx` along an axis multiplies the span it shows.
 * Down a value axis or right along the time axis shows more (a factor above
 * one), the other way less, and the way back undoes it exactly.
 */
export function resolveAxisDragSpanFactor(deltaPx: number): number {
  return Number.isFinite(deltaPx) ? Math.exp(deltaPx / AXIS_DRAG_PIXELS_PER_E) : 1;
}

function toAxis(value: number, scale: PanelScale): number {
  return scale === "log" ? Math.log(value) : value;
}

function fromAxis(value: number, scale: PanelScale): number {
  return scale === "log" ? Math.exp(value) : value;
}

/** The range as top and bottom in the axis's own space: values, or their logs. */
function axisEnds(range: CompositeValueRange, scale: PanelScale): { top: number; bottom: number } | null {
  if (scale === "log" && (range.min <= 0 || range.max <= 0)) return null;
  const top = toAxis(range.max, scale);
  const bottom = toAxis(range.min, scale);
  return Number.isFinite(top) && Number.isFinite(bottom) && top > bottom ? { top, bottom } : null;
}

function rangeFromEnds(top: number, bottom: number, scale: PanelScale): CompositeValueRange {
  return { min: fromAxis(bottom, scale), max: fromAxis(top, scale) };
}

/**
 * The range after multiplying its span by `spanFactor` (above one shows more)
 * around the value at `anchorRatio`, 0 the top of the panel and 1 the bottom,
 * which stays where it is. A log axis stretches in its own, logarithmic space.
 */
export function zoomValueRange(
  range: CompositeValueRange,
  scale: PanelScale,
  spanFactor: number,
  anchorRatio: number,
): CompositeValueRange {
  const ends = axisEnds(range, scale);
  if (!ends || !(spanFactor > 0) || !Number.isFinite(spanFactor)) return range;
  const ratio = clamp(Number.isFinite(anchorRatio) ? anchorRatio : 0.5, 0, 1);
  const span = ends.top - ends.bottom;
  const anchor = ends.top - span * ratio;
  const nextSpan = scale === "log"
    ? clamp(span * spanFactor, MIN_LOG_SPAN, MAX_LOG_SPAN)
    : clamp(span * spanFactor, Math.max(Math.abs(anchor), Number.MIN_VALUE) * MIN_LINEAR_SPAN_RATIO, MAX_LINEAR_SPAN);
  const top = anchor + nextSpan * ratio;
  return rangeFromEnds(top, top - nextSpan, scale);
}

/**
 * The range moved with a drag of `deltaRatio` of the panel's height, positive
 * downward: what was under the pointer stays under it.
 */
export function panValueRange(
  range: CompositeValueRange,
  scale: PanelScale,
  deltaRatio: number,
): CompositeValueRange {
  const ends = axisEnds(range, scale);
  if (!ends || !Number.isFinite(deltaRatio) || deltaRatio === 0) return range;
  const shift = (ends.top - ends.bottom) * deltaRatio;
  return rangeFromEnds(ends.top + shift, ends.bottom + shift, scale);
}

/** A manual range holds while some of the data is in it; pushed clear of the data it fits the data again. */
export function manualValueRangeApplies(
  manual: CompositeValueRange,
  data: CompositeValueRange,
  scale: PanelScale,
): boolean {
  const ends = axisEnds(manual, scale);
  return !!ends && manual.max > data.min && manual.min < data.max;
}

/**
 * Keeps an end of a segment that leaves the band from `minY` to `maxY` on the
 * band's edge, along the segment: what is drawn of it inside stays exact and
 * nothing is drawn far outside. Null when it misses the band.
 */
export function clipSegmentToBand(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  minY: number,
  maxY: number,
): [number, number, number, number] | null {
  if ((y0 < minY && y1 < minY) || (y0 > maxY && y1 > maxY)) return null;
  if (y0 >= minY && y0 <= maxY && y1 >= minY && y1 <= maxY) return [x0, y0, x1, y1];
  const at = (y: number) => {
    const t = (y - y0) / (y1 - y0);
    return x0 + (x1 - x0) * t;
  };
  let startX = x0;
  let startY = y0;
  let endX = x1;
  let endY = y1;
  if (startY < minY) { startX = at(minY); startY = minY; } else if (startY > maxY) { startX = at(maxY); startY = maxY; }
  if (endY < minY) { endX = at(minY); endY = minY; } else if (endY > maxY) { endX = at(maxY); endY = maxY; }
  return [startX, startY, endX, endY];
}
