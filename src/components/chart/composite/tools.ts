import { formatPercentRaw } from "../../../utils/format";
import type { ChartVectorShape } from "../../../ui/host";
import type { NativeChartBitmap } from "../native/chart-rasterizer";
import { drawCircle, drawLine, fillRect, parseHex, type RgbaColor } from "../native/raster/primitives";
import { formatCompositeAxisValue, formatCompositeCursorDate, formatCompositeCursorValue } from "./format";
import { projectCompositeValue, unprojectCompositeValue } from "./scene";
import { projectCompositeTimestamp, unprojectCompositeTimestamp } from "./time-scale";
import type {
  CompositeAxisDomain,
  CompositeChartScene,
  CompositePanelScene,
} from "./types";
import { clamp } from "../../../utils/math";

/** Pointer tools that take the drag away from panning while one is picked. */
export type ChartToolKind = "measure" | "zoom" | "line" | "pencil" | "level" | "rect" | "fib" | "ray";

/** How a saved drawing is drawn from its points. */
export type ChartDrawingShape = "line" | "rect" | "fib" | "ray";
const SHAPED_TOOLS = ["rect", "fib", "ray"] as const;

/** Retracement ratios, measured back from the drag's end toward its start. */
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;

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

export const CHART_DRAWINGS_SETTING_KEY = "chartDrawings";
const MAX_SHARED_CHART_DRAWINGS = 100;
const MAX_SHARED_DRAWING_POINTS = 5_000;

export function parseChartDrawings(value: unknown): ChartDrawing[] {
  if (!Array.isArray(value) || value.length > MAX_SHARED_CHART_DRAWINGS) return [];
  let pointCount = 0;
  const drawings: ChartDrawing[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const drawing = entry as Record<string, unknown>;
    if (!Object.keys(drawing).every((key) => ["id", "panelId", "points", "color"].includes(key))) return [];
    if (
      typeof drawing.id !== "string"
      || drawing.id.length === 0
      || drawing.id.length > 160
      || typeof drawing.panelId !== "string"
      || drawing.panelId.length === 0
      || drawing.panelId.length > 120
      || typeof drawing.color !== "string"
      || !/^#[0-9a-f]{6}$/i.test(drawing.color)
      || !Array.isArray(drawing.points)
      || drawing.points.length < 2
    ) return [];
    pointCount += drawing.points.length;
    if (pointCount > MAX_SHARED_DRAWING_POINTS) return [];
    const points: ChartDrawingPoint[] = [];
    for (const point of drawing.points) {
      if (!point || typeof point !== "object" || Array.isArray(point)) return [];
      const raw = point as Record<string, unknown>;
      if (
        !Object.keys(raw).every((key) => key === "time" || key === "value")
        || typeof raw.time !== "number"
        || !Number.isFinite(raw.time)
        || typeof raw.value !== "number"
        || !Number.isFinite(raw.value)
      ) return [];
      points.push({ time: raw.time, value: raw.value });
    }
    drawings.push({
      id: drawing.id,
      panelId: drawing.panelId,
      points,
      color: drawing.color,
    });
  }
  return drawings;
}

/**
 * The shape rides in the id (`fib:3`) rather than a field of its own: an older
 * build refuses a saved drawing with a key it does not know and would drop every
 * drawing of the pane, while an id it does not know still draws as a line.
 */
export function chartDrawingShape(drawing: Pick<ChartDrawing, "id" | "points">): ChartDrawingShape {
  const prefix = drawing.id.slice(0, Math.max(0, drawing.id.indexOf(":")));
  return drawing.points.length === 2 && (SHAPED_TOOLS as readonly string[]).includes(prefix)
    ? prefix as ChartDrawingShape
    : "line";
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

/** Pointer slack for grabbing a drawing, as a fraction of the plot's height. */
const DRAWING_GRAB_RATIO = 0.03;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function drawingPointFrom(
  scene: Pick<CompositeChartScene, "timeScale">,
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
  scene: Pick<CompositeChartScene, "timeScale">,
  panel: CompositePanelScene,
  drag: ChartToolDrag,
  color: string,
  id: string,
): ChartDrawing | null {
  const domain = resolveMeasureAxisDomain(panel);
  // A ray needs only its price, so a click places one.
  if (!domain || (drag.kind !== "ray" && !isMeaningfulToolDrag(drag))) return null;
  if (isShapedTool(drag.kind)) {
    // A ray holds its first price, so its stored end is level with it and an
    // older build draws the same horizontal run.
    const endYRatio = drag.kind === "ray" ? drag.startYRatio : drag.endYRatio;
    const start = drawingPointFrom(scene, domain, drag.startXRatio, drag.startYRatio);
    const end = drawingPointFrom(scene, domain, drag.endXRatio, endYRatio);
    return start && end ? { id: shapedDrawingId(drag.kind, id), panelId: panel.id, points: [start, end], color } : null;
  }
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

function isShapedTool(kind: ChartToolKind): kind is typeof SHAPED_TOOLS[number] {
  return (SHAPED_TOOLS as readonly string[]).includes(kind);
}

/** The id a drawing of this tool is saved under, see `chartDrawingShape`. */
export function shapedDrawingId(kind: ChartToolKind, id: string): string {
  return isShapedTool(kind) ? `${kind}:${id}` : id;
}

type RatioPoint = { xRatio: number; yRatio: number };

interface DrawingGeometry {
  segments: Array<[RatioPoint, RatioPoint]>;
  /** Corners of a filled box under the segments. */
  box: [RatioPoint, RatioPoint] | null;
  /** The points that can be grabbed and reshaped. */
  anchors: RatioPoint[];
  labels: Array<{ at: RatioPoint; text: string }>;
}

/** What a drawing paints, in plot ratios: shared by the bitmap, the vectors and the hit test. */
function drawingGeometry(
  scene: Pick<CompositeChartScene, "timeScale">,
  panel: CompositePanelScene,
  drawing: ChartDrawing,
): DrawingGeometry | null {
  const projected = projectDrawing(scene, panel, drawing);
  if (!projected) return null;
  const shape = chartDrawingShape(drawing);
  if (shape === "line") {
    return {
      segments: projected.slice(1).map((point, index) => [projected[index]!, point]),
      box: null,
      anchors: projected.length === 2 ? projected : [],
      labels: [],
    };
  }
  const [start, end] = projected as [RatioPoint, RatioPoint];
  if (shape === "ray") {
    return { segments: [[start, { xRatio: 1, yRatio: start.yRatio }]], box: null, anchors: [start], labels: [] };
  }
  if (shape === "rect") {
    const corner = (xRatio: number, yRatio: number) => ({ xRatio, yRatio });
    const a = corner(start.xRatio, end.yRatio);
    const b = corner(end.xRatio, start.yRatio);
    return { segments: [[start, a], [a, end], [end, b], [b, start]], box: [start, end], anchors: [start, end], labels: [] };
  }
  const domain = resolveMeasureAxisDomain(panel)!;
  const left = Math.min(start.xRatio, end.xRatio);
  const right = Math.max(start.xRatio, end.xRatio);
  const [from, to] = drawing.points as [ChartDrawingPoint, ChartDrawingPoint];
  const segments: DrawingGeometry["segments"] = [];
  const labels: DrawingGeometry["labels"] = [];
  for (const level of FIB_LEVELS) {
    const value = to.value + (from.value - to.value) * level;
    const yRatio = projectCompositeValue(value, domain);
    if (yRatio === null) continue;
    segments.push([{ xRatio: left, yRatio }, { xRatio: right, yRatio }]);
    labels.push({ at: { xRatio: left, yRatio }, text: `${level} ${formatCompositeCursorValue(value, domain)}` });
  }
  return { segments, box: null, anchors: [start, end], labels };
}

function projectDrawing(
  scene: Pick<CompositeChartScene, "timeScale">,
  panel: CompositePanelScene,
  drawing: ChartDrawing,
): RatioPoint[] | null {
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
  /** Plot width over height in pixels, so slack is even in both directions. */
  aspect = 1,
): ChartDrawingHit | null {
  let best: { hit: ChartDrawingHit; distance: number; endpoint: boolean } | null = null;
  const scale = Math.max(aspect, Number.EPSILON);
  const target = { x: pointer.xRatio * scale, y: pointer.yRatio };
  const toPlot = (point: RatioPoint) => ({ x: point.xRatio * scale, y: point.yRatio });
  for (const drawing of drawings) {
    if (drawing.panelId !== panel.id) continue;
    const geometry = drawingGeometry(scene, panel, drawing);
    if (!geometry) continue;
    for (const [index, anchor] of geometry.anchors.entries()) {
      const point = toPlot(anchor);
      const distance = Math.hypot(target.x - point.x, target.y - point.y);
      if (distance > DRAWING_GRAB_RATIO) continue;
      if (!best?.endpoint || best.distance > distance) {
        best = { hit: { drawing, pointIndex: index }, distance, endpoint: true };
      }
    }
    for (const [from, to] of geometry.segments) {
      const distance = distanceToSegment(target, toPlot(from), toPlot(to));
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
  const points = drawing.points.map((point, index) => {
    if (pointIndex !== null && index !== pointIndex) return point;
    const source = projected[index]!;
    return drawingPointFrom(
      scene,
      domain,
      clamp(source.xRatio + deltaXRatio, 0, 1),
      clamp(source.yRatio + deltaYRatio, 0, 1),
    ) ?? point;
  });
  if (chartDrawingShape(drawing) === "ray") points[1] = { ...points[1]!, value: points[0]!.value };
  return { ...drawing, points };
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
  return tool === "line" || tool === "pencil" || (tool !== null && isShapedTool(tool));
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

/**
 * Value of the series the measure reads, at a time: its last observation at or
 * before it. A tool placed from the keyboard starts and follows the price here.
 */
export function resolveMeasureValueAt(
  panel: CompositePanelScene,
  timestamp: number,
): number | null {
  const series = panel.series.find((entry) => panel.axes[entry.source.axis]);
  const points = series?.points ?? [];
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (points[middle]!.timestamp <= timestamp) low = middle + 1;
    else high = middle;
  }
  const value = points[low - 1]?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
  return summarizeZoomRange(
    scene,
    unprojectCompositeTimestamp(scene.timeScale, drag.startXRatio),
    unprojectCompositeTimestamp(scene.timeScale, drag.endXRatio),
  );
}

/** The same preview for two times, in either order. */
export function summarizeZoomRange(
  scene: Pick<CompositeChartScene, "startTime" | "endTime" | "timeZone">,
  first: number,
  second: number,
): string | null {
  if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
  const start = Math.min(first, second);
  const end = Math.max(first, second);
  const label = (timestamp: number) => formatCompositeCursorDate(
    new Date(timestamp),
    scene.startTime,
    scene.endTime,
    scene.timeZone,
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
  return resolveZoomTimeRange(
    unprojectCompositeTimestamp(scene.timeScale, drag.startXRatio),
    unprojectCompositeTimestamp(scene.timeScale, drag.endXRatio),
    minimumSpanMs,
  );
}

/** The range between two times, in either order, widened about its centre to the zoom floor. */
export function resolveZoomTimeRange(
  first: number,
  second: number,
  minimumSpanMs: number,
): { start: Date; end: Date } | null {
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
    const selected = input.selectedId === drawing.id;
    if (chartDrawingShape(drawing) === "line") {
      const projected = projectDrawing(input.scene, input.panel, drawing);
      if (!projected) continue;
      shapes.push({
        id: drawing.id,
        points: projected.map((point) => ({ x: point.xRatio, y: point.yRatio })),
        color: drawing.color,
        strokeWidth: selected ? 2.4 : 1.6,
        handles: selected && drawing.points.length === 2,
      });
      continue;
    }
    shapes.push(...shapedDrawingVectors(input.scene, input.panel, drawing, selected));
  }

  const drag = input.drag;
  if (!drag) return shapes;
  if (isShapedTool(drag.kind)) {
    const preview = resolveDrawingFromDrag(input.scene, input.panel, drag, input.colors.draw, "tool:draw");
    if (preview) shapes.push(...shapedDrawingVectors(input.scene, input.panel, preview, false));
    return shapes;
  }
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

function shapedDrawingVectors(
  scene: Pick<CompositeChartScene, "timeScale">,
  panel: CompositePanelScene,
  drawing: ChartDrawing,
  selected: boolean,
): ChartVectorShape[] {
  const geometry = drawingGeometry(scene, panel, drawing);
  if (!geometry) return [];
  const toVector = (point: RatioPoint) => ({ x: point.xRatio, y: point.yRatio });
  const shapes: ChartVectorShape[] = [];
  if (geometry.box) {
    shapes.push({ id: `${drawing.id}:box`, points: geometry.box.map(toVector), color: drawing.color, box: true, fillOpacity: 0.12, strokeWidth: 0 });
  }
  geometry.segments.forEach((segment, index) => shapes.push({
    id: `${drawing.id}:${index}`,
    points: segment.map(toVector),
    color: drawing.color,
    strokeWidth: selected ? 2 : 1.3,
    ...(geometry.labels[index] ? { label: geometry.labels[index]!.text } : {}),
  }));
  if (selected) {
    shapes.push({ id: `${drawing.id}:anchors`, points: geometry.anchors.map(toVector), color: drawing.color, opacity: 0, handles: true });
  }
  return shapes;
}

/** Paints a shaped drawing's segments, box and handles onto a raster. */
function paintShapedDrawing(
  data: Uint8Array,
  width: number,
  height: number,
  geometry: DrawingGeometry,
  color: RgbaColor,
  selected: boolean,
): void {
  const maxX = Math.max(width - 1, 0);
  const maxY = Math.max(height - 1, 0);
  if (geometry.box) {
    const [a, b] = geometry.box;
    fillRect(data, width, height, Math.min(a.xRatio, b.xRatio) * maxX, Math.min(a.yRatio, b.yRatio) * maxY,
      Math.max(a.xRatio, b.xRatio) * maxX, Math.max(a.yRatio, b.yRatio) * maxY, color, 0.12);
  }
  for (const [from, to] of geometry.segments) {
    drawLine(data, width, height, from.xRatio * maxX, from.yRatio * maxY, to.xRatio * maxX, to.yRatio * maxY, color, selected ? 2.2 : 1.4);
  }
  if (!selected) return;
  for (const anchor of geometry.anchors) drawCircle(data, width, height, anchor.xRatio * maxX, anchor.yRatio * maxY, 3.2, color);
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
    scene: Pick<CompositeChartScene, "timeScale">;
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
    const selected = drawings!.selectedId === drawing.id;
    const color = parseHex(drawing.color);
    if (chartDrawingShape(drawing) !== "line") {
      const geometry = drawingGeometry(drawings!.scene, drawings!.panel, drawing);
      if (geometry) paintShapedDrawing(data, width, height, geometry, color, selected);
      continue;
    }
    const shape = projectDrawing(drawings!.scene, drawings!.panel, drawing);
    if (!shape) continue;
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

  if (isShapedTool(drag.kind)) {
    const preview = drawings && resolveDrawingFromDrag(drawings.scene, drawings.panel, drag, colors.draw, "tool:draw");
    const geometry = preview && drawingGeometry(drawings.scene, drawings.panel, preview);
    if (geometry) paintShapedDrawing(data, width, height, geometry, parseHex(colors.draw), false);
    return { width, height, pixels: data };
  }

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

export interface ChartToolSpan {
  startXRatio: number;
  endXRatio: number;
  /** The anchor's own time, which can sit outside the view once it pans. */
  startTime: number;
  color: string;
}
