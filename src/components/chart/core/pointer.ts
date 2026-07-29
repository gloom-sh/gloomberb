import type { NativeRendererHost as CliRenderer } from "../../../ui";

type RendererMetricsHost = Pick<CliRenderer, "resolution" | "terminalWidth" | "terminalHeight">;

interface RenderableSizeLike {
  width?: number;
  height?: number;
}

interface PlotRenderableLike extends RenderableSizeLike {
  x?: number;
  y?: number;
  absoluteX?: number;
  absoluteY?: number;
  absoluteBounds?: { x: number; y: number; width: number; height: number };
}

export interface ChartMouseEvent {
  x: number;
  y: number;
  preciseX?: number;
  preciseY?: number;
  pixelX?: number;
  pixelY?: number;
  stopPropagation?: () => void;
  preventDefault?: () => void;
  modifiers: {
    shift: boolean;
    alt: boolean;
    ctrl: boolean;
  };
  scroll?: {
    direction: "up" | "down" | "left" | "right";
    delta: number;
  };
}

export function consumeChartMouseEvent(event: Pick<ChartMouseEvent, "stopPropagation" | "preventDefault">): void {
  event.stopPropagation?.();
  event.preventDefault?.();
}

export interface LocalPlotPointer {
  cellX: number;
  cellY: number;
  pixelX: number | null;
  pixelY: number | null;
  hasPixelPrecision: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getRendererCellMetrics(renderer: RendererMetricsHost) {
  if (!renderer.resolution) return null;
  const cellWidth = renderer.resolution.width / Math.max(renderer.terminalWidth, 1);
  const cellHeight = renderer.resolution.height / Math.max(renderer.terminalHeight, 1);
  if (!(cellWidth > 0) || !(cellHeight > 0)) return null;
  return { cellWidth, cellHeight };
}

function getRenderableSize(renderable: RenderableSizeLike | null): { width: number; height: number } | null {
  if (!renderable) return null;
  if (typeof renderable.width === "number" && typeof renderable.height === "number") {
    return { width: renderable.width, height: renderable.height };
  }
  const absoluteBounds = (renderable as PlotRenderableLike).absoluteBounds;
  if (absoluteBounds && typeof absoluteBounds.width === "number" && typeof absoluteBounds.height === "number") {
    return { width: absoluteBounds.width, height: absoluteBounds.height };
  }
  return null;
}

function getPlotBounds(renderable: PlotRenderableLike | null): { x: number; y: number; width: number; height: number } | null {
  if (!renderable) return null;
  const size = getRenderableSize(renderable);
  if (!size) return null;
  const x = typeof renderable.absoluteX === "number"
    ? renderable.absoluteX
    : typeof renderable.absoluteBounds?.x === "number"
      ? renderable.absoluteBounds.x
      : renderable.x;
  const y = typeof renderable.absoluteY === "number"
    ? renderable.absoluteY
    : typeof renderable.absoluteBounds?.y === "number"
      ? renderable.absoluteBounds.y
      : renderable.y;
  if (typeof x !== "number" || typeof y !== "number") return null;
  return { x, y, width: size.width, height: size.height };
}

export function scaleLocalPixelCoordinate(value: number | null, sourceExtent: number, targetExtent: number): number | null {
  if (value === null) return null;
  if (targetExtent <= 1) return 0;
  if (!(sourceExtent > 1)) {
    return clamp(value, 0, Math.max(targetExtent - 1, 0));
  }
  return clamp(
    (value / Math.max(sourceExtent - 1, 1)) * Math.max(targetExtent - 1, 0),
    0,
    Math.max(targetExtent - 1, 0),
  );
}

export function getLocalPlotPointer(
  event: ChartMouseEvent,
  renderable: PlotRenderableLike | null,
  renderer: RendererMetricsHost,
): LocalPlotPointer | null {
  const bounds = getPlotBounds(renderable);
  if (!bounds) return null;

  const rawCellX = typeof event.preciseX === "number" ? event.preciseX : event.x;
  const rawCellY = typeof event.preciseY === "number" ? event.preciseY : event.y;
  const localCellX = rawCellX - bounds.x;
  const localCellY = rawCellY - bounds.y;
  if (localCellX < 0 || localCellX >= bounds.width || localCellY < 0 || localCellY >= bounds.height) {
    return null;
  }

  const metrics = getRendererCellMetrics(renderer);
  if (event.pixelX === undefined || event.pixelY === undefined || !metrics) {
    return {
      cellX: localCellX,
      cellY: localCellY,
      pixelX: null,
      pixelY: null,
      hasPixelPrecision: false,
    };
  }

  const pixelLeft = bounds.x * metrics.cellWidth;
  const pixelTop = bounds.y * metrics.cellHeight;
  const pixelWidth = bounds.width * metrics.cellWidth;
  const pixelHeight = bounds.height * metrics.cellHeight;
  const localPixelX = event.pixelX - pixelLeft;
  const localPixelY = event.pixelY - pixelTop;

  if (localPixelX < 0 || localPixelY < 0 || localPixelX > pixelWidth || localPixelY > pixelHeight) {
    return {
      cellX: localCellX,
      cellY: localCellY,
      pixelX: null,
      pixelY: null,
      hasPixelPrecision: false,
    };
  }

  return {
    cellX: bounds.width <= 1
      ? 0
      : clamp(
        (localPixelX / Math.max(pixelWidth - 1, 1)) * Math.max(bounds.width - 1, 0),
        0,
        Math.max(bounds.width - 1, 0),
      ),
    cellY: bounds.height <= 1
      ? 0
      : clamp(
        (localPixelY / Math.max(pixelHeight - 1, 1)) * Math.max(bounds.height - 1, 0),
        0,
        Math.max(bounds.height - 1, 0),
      ),
    pixelX: clamp(localPixelX, 0, Math.max(pixelWidth - 1, 0)),
    pixelY: clamp(localPixelY, 0, Math.max(pixelHeight - 1, 0)),
    hasPixelPrecision: true,
  };
}

export function getGlobalMouseX(
  event: ChartMouseEvent,
  renderer: RendererMetricsHost,
): number {
  const metrics = getRendererCellMetrics(renderer);
  if (event.pixelX === undefined || !metrics) return event.x;
  return event.pixelX / metrics.cellWidth;
}
