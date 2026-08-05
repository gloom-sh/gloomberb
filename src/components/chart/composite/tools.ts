import { formatPercentRaw } from "../../../utils/format";
import type { ChartVectorShape } from "../../../ui/host";
import type { NativeChartBitmap } from "../native/chart-rasterizer";
import { clamp, drawCircle, drawLine, fillRect, parseHex } from "../native/raster/primitives";
import { formatCompositeAxisValue, formatCompositeCursorDate } from "./format";
import { projectCompositeValue, unprojectCompositeValue } from "./scene";
import { projectCompositeTimestamp, unprojectCompositeTimestamp } from "./time-scale";
import type {
  CompositeAxisDomain,
  CompositeChartScene,
  CompositePanelScene,
} from "./types";

/** Pointer tools that take the drag away from panning while one is picked. */
export type ChartToolKind = "measure" | "zoom" | "line" | "pencil";

export interface ChartDrawingPoint {
  time: number;
  value: number;
}

/** Anchored to data, so pan and zoom keep a drawing on its own points. */
export interface ChartDrawing {
  id: string;
  panelId: string;
  points: ChartDrawingPoint[];
  color: string;
}

export interface ChartDrawingHit {
  drawing: ChartDrawing;
  /** Grabbed endpoint, or null when the whole shape was grabbed. */
  pointIndex: number | null;
}

export const CHART_DRAWING_COLORS = [
  "#f5a524",
  "#4c9aff",
  "#33c481",
  "#ff5c7a",
  "#c084fc",
] as const;

export interface ChartToolDrag {
  kind: ChartToolKind;
  startXRatio: number;
  startYRatio: number;
  endXRatio: number;
  endYRatio: number;
  /** Sampled pointer trail, used by the freehand tool. */
  path: Array<{ xRatio: number; yRatio: number }>;
}

export interface ChartToolColors {
  positive: string;
  negative: string;
  zoom: string;
  draw: string;
}

/** A drag shorter than this is a mis-click, not a range selection. */
const MINIMUM_TOOL_DRAG_RATIO = 0.004;

/** Pointer slack for grabbing a drawing, as a fraction of the plot box. */
const DRAWING_GRAB_RATIO = 0.02;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function drawingPointFrom(
  scene: CompositeChartScene,
  domain: CompositeAxisDomain,
  xRatio: number,
  yRatio: number,
): ChartDrawingPoint | null {
  const value = unprojectCompositeValue(yRatio, domain);
  return value === null
    ? null
    : { time: unprojectCompositeTimestamp(scene.timeScale, xRatio), value };
}

/** Data anchors for a finished drag, so a drawing survives pan and zoom. */
export function resolveDrawingFromDrag(
  scene: CompositeChartScene,
  panel: CompositePanelScene,
  drag: ChartToolDrag,
  color: string,
  id: string,
): ChartDrawing | null {
  const domain = resolveMeasureAxisDomain(panel);
  if (!domain || !isMeaningfulToolDrag(drag)) return null;
  const source = drag.kind === "pencil" && drag.path.length > 1
    ? drag.path
    : [
      { xRatio: drag.startXRatio, yRatio: drag.startYRatio },
      { xRatio: drag.endXRatio, yRatio: drag.endYRatio },
    ];
  const points = source
    .map((point) => drawingPointFrom(scene, domain, point.xRatio, point.yRatio))
    .filter((point): point is ChartDrawingPoint => point !== null);
  return points.length < 2 ? null : { id, panelId: panel.id, points, color };
}

function projectDrawing(
  scene: CompositeChartScene,
  panel: CompositePanelScene,
  drawing: ChartDrawing,
): Array<{ xRatio: number; yRatio: number }> | null {
  const domain = resolveMeasureAxisDomain(panel);
  if (!domain) return null;
  const projected: Array<{ xRatio: number; yRatio: number }> = [];
  for (const point of drawing.points) {
    const xRatio = projectCompositeTimestamp(scene.timeScale, point.time)?.ratio;
    const yRatio = projectCompositeValue(point.value, domain);
    if (typeof xRatio !== "number" || yRatio === null) return null;
    projected.push({ xRatio, yRatio });
  }
  return projected;
}

function distanceToSegment(
  point: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0
    ? 0
    : clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared, 0, 1);
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

/**
 * Nearest drawing under the pointer. Endpoints win over the body so a line can
 * be reshaped without first dragging the whole thing out of the way.
 */
export function hitTestDrawings(
  drawings: readonly ChartDrawing[],
  scene: CompositeChartScene,
  panel: CompositePanelScene,
  pointer: { xRatio: number; yRatio: number },
): ChartDrawingHit | null {
  let best: { hit: ChartDrawingHit; distance: number; endpoint: boolean } | null = null;
  const target = { x: pointer.xRatio, y: pointer.yRatio };
  for (const drawing of drawings) {
    if (drawing.panelId !== panel.id) continue;
    const projected = projectDrawing(scene, panel, drawing);
    if (!projected) continue;
    const shape = projected.map((point) => ({ x: point.xRatio, y: point.yRatio }));
    if (drawing.points.length === 2) {
      for (const [index, point] of shape.entries()) {
        const distance = Math.hypot(target.x - point.x, target.y - point.y);
        if (distance > DRAWING_GRAB_RATIO) continue;
        if (!best?.endpoint || best.distance > distance) {
          best = { hit: { drawing, pointIndex: index }, distance, endpoint: true };
        }
      }
    }
    for (let index = 1; index < shape.length; index += 1) {
      const distance = distanceToSegment(target, shape[index - 1]!, shape[index]!);
      if (distance > DRAWING_GRAB_RATIO || best?.endpoint) continue;
      if (!best || best.distance > distance) {
        best = { hit: { drawing, pointIndex: null }, distance, endpoint: false };
      }
    }
  }
  return best?.hit ?? null;
}

/** Re-anchors a drawing after a move, through the projection it is drawn with. */
export function shiftDrawing(
  drawing: ChartDrawing,
  scene: CompositeChartScene,
  panel: CompositePanelScene,
  deltaXRatio: number,
  deltaYRatio: number,
  pointIndex: number | null,
): ChartDrawing {
  const domain = resolveMeasureAxisDomain(panel);
  const projected = projectDrawing(scene, panel, drawing);
  if (!domain || !projected) return drawing;
  return {
    ...drawing,
    points: drawing.points.map((point, index) => {
      if (pointIndex !== null && index !== pointIndex) return point;
      const source = projected[index]!;
      return drawingPointFrom(
        scene,
        domain,
        clamp(source.xRatio + deltaXRatio, 0, 1),
        clamp(source.yRatio + deltaYRatio, 0, 1),
      ) ?? point;
    }),
  };
}

export function nextDrawingColor(color: string): string {
  const index = CHART_DRAWING_COLORS.indexOf(color as typeof CHART_DRAWING_COLORS[number]);
  return CHART_DRAWING_COLORS[(index + 1) % CHART_DRAWING_COLORS.length]!;
}

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

export function isDrawingTool(tool: ChartToolKind | null): boolean {
  return tool === "line" || tool === "pencil";
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

/** Overlay geometry in plot ratios, for renderers that composite vectors. */
export function buildChartToolVectors(input: {
  scene: CompositeChartScene;
  panel: CompositePanelScene;
  drawings: readonly ChartDrawing[];
  selectedId: string | null;
  drag: ChartToolDrag | null;
  colors: ChartToolColors;
  direction: "up" | "down";
}): ChartVectorShape[] {
  const shapes: ChartVectorShape[] = [];
  for (const drawing of input.drawings) {
    const projected = projectDrawing(input.scene, input.panel, drawing);
    if (!projected) continue;
    const selected = input.selectedId === drawing.id;
    shapes.push({
      id: drawing.id,
      points: projected.map((point) => ({ x: point.xRatio, y: point.yRatio })),
      color: drawing.color,
      strokeWidth: selected ? 2.4 : 1.6,
      handles: selected && drawing.points.length === 2,
    });
  }

  const drag = input.drag;
  if (!drag) return shapes;
  const start = { x: drag.startXRatio, y: drag.startYRatio };
  const end = { x: drag.endXRatio, y: drag.endYRatio };
  if (drag.kind === "zoom") {
    shapes.push({
      id: "tool:zoom",
      points: [{ x: drag.startXRatio, y: 0 }, { x: drag.endXRatio, y: 1 }],
      color: input.colors.zoom,
      box: true,
      fillOpacity: 0.16,
      strokeWidth: 1.2,
    });
    return shapes;
  }
  if (drag.kind === "measure") {
    const color = input.direction === "down" ? input.colors.negative : input.colors.positive;
    shapes.push({
      id: "tool:measure",
      points: [start, end],
      color,
      box: true,
      fillOpacity: 0.18,
      strokeWidth: 1.2,
    });
    shapes.push({ id: "tool:measure-line", points: [start, end], color, strokeWidth: 1.4 });
    return shapes;
  }
  const trail = drag.kind === "pencil" && drag.path.length > 1
    ? drag.path.map((point) => ({ x: point.xRatio, y: point.yRatio }))
    : [start, end];
  shapes.push({ id: "tool:draw", points: trail, color: input.colors.draw, strokeWidth: 1.6 });
  return shapes;
}

/**
 * Paints drawings and the active tool on a copy of the panel raster. Copying
 * keeps the cached plot bitmap intact and keeps a single bitmap layer, which is
 * all the terminal surface uploads.
 */
export function drawChartToolOverlay(
  base: NativeChartBitmap,
  drag: ChartToolDrag | null,
  colors: ChartToolColors,
  direction: "up" | "down" = "up",
  drawings?: {
    scene: CompositeChartScene;
    panel: CompositePanelScene;
    items: readonly ChartDrawing[];
    selectedId?: string | null;
  },
): NativeChartBitmap {
  const width = base.width;
  const height = base.height;
  const data = new Uint8Array(base.pixels);
  const maxX = Math.max(width - 1, 0);
  const maxY = Math.max(height - 1, 0);

  for (const drawing of drawings?.items ?? []) {
    const shape = projectDrawing(drawings!.scene, drawings!.panel, drawing);
    if (!shape) continue;
    const selected = drawings!.selectedId === drawing.id;
    const color = parseHex(drawing.color);
    for (let index = 1; index < shape.length; index += 1) {
      drawLine(
        data,
        width,
        height,
        shape[index - 1]!.xRatio * maxX,
        shape[index - 1]!.yRatio * maxY,
        shape[index]!.xRatio * maxX,
        shape[index]!.yRatio * maxY,
        color,
        selected ? 2.2 : 1.4,
      );
    }
    if (!selected) continue;
    for (const handle of shape.length === 2 ? shape : [shape[0]!, shape.at(-1)!]) {
      drawCircle(data, width, height, handle.xRatio * maxX, handle.yRatio * maxY, 3.2, color);
    }
  }
  if (!drag) return { width, height, pixels: data };

  const x0 = drag.startXRatio * maxX;
  const x1 = drag.endXRatio * maxX;
  const y0 = drag.startYRatio * maxY;
  const y1 = drag.endYRatio * maxY;
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);

  if (drag.kind === "line" || drag.kind === "pencil") {
    const color = parseHex(colors.draw);
    const trail = drag.kind === "pencil" && drag.path.length > 1
      ? drag.path
      : [{ xRatio: drag.startXRatio, yRatio: drag.startYRatio }, { xRatio: drag.endXRatio, yRatio: drag.endYRatio }];
    for (let index = 1; index < trail.length; index += 1) {
      drawLine(
        data,
        width,
        height,
        trail[index - 1]!.xRatio * maxX,
        trail[index - 1]!.yRatio * maxY,
        trail[index]!.xRatio * maxX,
        trail[index]!.yRatio * maxY,
        color,
        1.4,
      );
    }
    return { width, height, pixels: data };
  }

  if (drag.kind === "zoom") {
    const tint = parseHex(colors.zoom);
    fillRect(data, width, height, left, 0, right, maxY, tint, 0.16);
    drawLine(data, width, height, x0, 0, x0, maxY, tint, 1.2);
    drawLine(data, width, height, x1, 0, x1, maxY, tint, 1.2);
    return { width, height, pixels: data };
  }

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
