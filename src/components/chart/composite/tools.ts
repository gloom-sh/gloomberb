import { formatPercentRaw } from "../../../utils/format";
import type { NativeChartBitmap } from "../native/chart-rasterizer";
import { drawLine, fillRect, parseHex } from "../native/raster/primitives";
import { formatCompositeAxisValue, formatCompositeCursorDate } from "./format";
import { unprojectCompositeTimestamp } from "./time-scale";
import type {
  CompositeAxisDomain,
  CompositeChartScene,
  CompositePanelScene,
} from "./types";

/** Drag tools that borrow the pointer from panning while a modifier is held. */
export type ChartToolKind = "measure" | "zoom";

export interface ChartToolDrag {
  kind: ChartToolKind;
  startXRatio: number;
  startYRatio: number;
  endXRatio: number;
  endYRatio: number;
}

export interface ChartToolColors {
  positive: string;
  negative: string;
  zoom: string;
}

/** A drag shorter than this is a mis-click, not a range selection. */
const MINIMUM_TOOL_DRAG_RATIO = 0.004;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function resolveChartToolKind(modifiers: {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}): ChartToolKind | null {
  // Ctrl already means zoom-at-pointer on the wheel; leave it alone.
  if (modifiers.ctrl) return null;
  if (modifiers.shift) return "zoom";
  if (modifiers.alt) return "measure";
  return null;
}

function isMeaningfulToolDrag(drag: ChartToolDrag): boolean {
  return Math.abs(drag.endXRatio - drag.startXRatio) >= MINIMUM_TOOL_DRAG_RATIO;
}

/** Panel axis the measure readout reports against: the first plotted series wins. */
export function resolveMeasureAxisDomain(
  panel: CompositePanelScene,
): CompositeAxisDomain | null {
  for (const series of panel.series) {
    const domain = panel.axes[series.source.axis];
    if (domain) return domain;
  }
  return panel.axes.left ?? panel.axes.right ?? null;
}

export function formatMeasureSpan(spanMs: number): string {
  const span = Math.max(0, Math.round(spanMs));
  if (span < MINUTE_MS) return `${Math.round(span / 1000)}s`;
  if (span < HOUR_MS) return `${Math.round(span / MINUTE_MS)}m`;
  if (span < DAY_MS) {
    const hours = Math.floor(span / HOUR_MS);
    const minutes = Math.round((span - hours * HOUR_MS) / MINUTE_MS);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(span / DAY_MS);
  const hours = Math.round((span - days * DAY_MS) / HOUR_MS);
  return days < 7 && hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

export function countMeasureBars(
  dates: readonly Date[],
  startTime: number,
  endTime: number,
): number {
  const low = Math.min(startTime, endTime);
  const high = Math.max(startTime, endTime);
  let count = 0;
  for (const date of dates) {
    const timestamp = date.getTime();
    if (timestamp >= low && timestamp <= high) count += 1;
  }
  return count;
}

export function summarizeMeasure(input: {
  startValue: number | null;
  endValue: number | null;
  startTime: number;
  endTime: number;
  bars: number;
  domain: CompositeAxisDomain | null;
}): string | null {
  const { startValue, endValue, domain } = input;
  const spanText = formatMeasureSpan(Math.abs(input.endTime - input.startTime));
  const barsText = input.bars > 0 ? ` · ${input.bars} bar${input.bars === 1 ? "" : "s"}` : "";
  if (
    startValue === null
    || endValue === null
    || !Number.isFinite(startValue)
    || !Number.isFinite(endValue)
  ) {
    return `Δ —${barsText} · ${spanText}`;
  }
  const delta = endValue - startValue;
  // Sign leads the unit: the axis formatter would render "$-11.0".
  const magnitude = Math.abs(delta);
  const magnitudeText = domain
    ? formatCompositeAxisValue(magnitude, domain)
    : magnitude.toFixed(2);
  const signedDeltaText = `${delta > 0 ? "+" : delta < 0 ? "-" : ""}${magnitudeText}`;
  // A zero or sign-flipping baseline makes the percentage meaningless, not huge.
  const percentText = startValue !== 0 && startValue * endValue > 0
    ? ` (${formatPercentRaw((delta / Math.abs(startValue)) * 100)})`
    : "";
  return `Δ ${signedDeltaText}${percentText}${barsText} · ${spanText}`;
}

/**
 * Range preview for a live zoom drag. The band drawn on the raster is invisible
 * on the braille renderer, so the selection is also reported as text.
 */
export function summarizeZoomSelection(
  scene: CompositeChartScene,
  drag: ChartToolDrag,
): string | null {
  if (!isMeaningfulToolDrag(drag)) return null;
  const first = unprojectCompositeTimestamp(scene.timeScale, drag.startXRatio);
  const second = unprojectCompositeTimestamp(scene.timeScale, drag.endXRatio);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
  const start = Math.min(first, second);
  const end = Math.max(first, second);
  const label = (timestamp: number) => formatCompositeCursorDate(
    new Date(timestamp),
    scene.startTime,
    scene.endTime,
  );
  return `${label(start)} → ${label(end)} · ${formatMeasureSpan(end - start)}`;
}

export function resolveMeasureDirection(
  startValue: number | null,
  endValue: number | null,
): "up" | "down" {
  if (startValue === null || endValue === null) return "up";
  return endValue < startValue ? "down" : "up";
}

/**
 * Time range a zoom-box drag selects. Returns null when the drag is too short
 * to be intentional, so a modifier-held click never zooms to a single instant.
 */
export function resolveZoomBoxRange(
  scene: CompositeChartScene,
  drag: ChartToolDrag,
  minimumSpanMs: number,
): { start: Date; end: Date } | null {
  if (!isMeaningfulToolDrag(drag)) return null;
  const first = unprojectCompositeTimestamp(scene.timeScale, drag.startXRatio);
  const second = unprojectCompositeTimestamp(scene.timeScale, drag.endXRatio);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
  const start = Math.min(first, second);
  const end = Math.max(first, second);
  const minimumSpan = Math.max(1, minimumSpanMs);
  if (end - start >= minimumSpan) return { start: new Date(start), end: new Date(end) };
  const center = (start + end) / 2;
  return {
    start: new Date(center - minimumSpan / 2),
    end: new Date(center + minimumSpan / 2),
  };
}

/**
 * Paints the active tool on a copy of the panel raster. Copying keeps the cached
 * plot bitmap intact so releasing the tool costs no re-render, and it keeps a
 * single bitmap layer, which is all the terminal surface uploads.
 */
export function drawChartToolOverlay(
  base: NativeChartBitmap,
  drag: ChartToolDrag,
  colors: ChartToolColors,
  direction: "up" | "down" = "up",
): NativeChartBitmap {
  const width = base.width;
  const height = base.height;
  const data = new Uint8Array(base.pixels);
  const maxX = Math.max(width - 1, 0);
  const maxY = Math.max(height - 1, 0);
  const x0 = drag.startXRatio * maxX;
  const x1 = drag.endXRatio * maxX;
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);

  if (drag.kind === "zoom") {
    const tint = parseHex(colors.zoom);
    fillRect(data, width, height, left, 0, right, maxY, tint, 0.16);
    drawLine(data, width, height, x0, 0, x0, maxY, tint, 1.2);
    drawLine(data, width, height, x1, 0, x1, maxY, tint, 1.2);
    return { width, height, pixels: data };
  }

  const y0 = drag.startYRatio * maxY;
  const y1 = drag.endYRatio * maxY;
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  const tint = parseHex(direction === "down" ? colors.negative : colors.positive);
  fillRect(data, width, height, left, top, right, bottom, tint, 0.18);
  drawLine(data, width, height, left, top, right, top, tint, 1.2);
  drawLine(data, width, height, left, bottom, right, bottom, tint, 1.2);
  drawLine(data, width, height, left, top, left, bottom, tint, 1.2);
  drawLine(data, width, height, right, top, right, bottom, tint, 1.2);
  drawLine(data, width, height, x0, y0, x1, y1, tint, 1.4);
  return { width, height, pixels: data };
}
