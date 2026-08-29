import type { NativeChartBitmap } from "../native/chart-rasterizer";
import {
  drawCircle,
  drawLine,
  fillOpaque,
  fillRect,
  parseHex,
  type RgbaColor,
} from "../native/raster/primitives";
import type { ChartPaintPoint, ChartPainter } from "../core/painter";
import { paintCompositePanel } from "./painter";
import type { CompositeChartColors, CompositePanelScene } from "./types";

interface RenderCompositePanelBitmapOptions {
  pixelWidth: number;
  pixelHeight: number;
  colors: CompositeChartColors;
}

class BitmapCompositePainter implements ChartPainter {
  private readonly colors = new Map<string, RgbaColor>();

  constructor(
    private readonly data: Uint8Array,
    private readonly width: number,
    private readonly height: number,
  ) {}

  private color(value: string): RgbaColor {
    const cached = this.colors.get(value);
    if (cached) return cached;
    const parsed = parseHex(value);
    this.colors.set(value, parsed);
    return parsed;
  }

  clear(color: string): void {
    fillOpaque(this.data, this.color(color));
  }

  fillRect(
    left: number,
    top: number,
    right: number,
    bottom: number,
    color: string,
    opacity = 1,
  ): void {
    fillRect(
      this.data,
      this.width,
      this.height,
      left,
      top,
      right,
      bottom,
      this.color(color),
      opacity,
    );
  }

  line(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: string,
    width: number,
  ): void {
    drawLine(
      this.data,
      this.width,
      this.height,
      x0,
      y0,
      x1,
      y1,
      this.color(color),
      width,
    );
  }

  path(
    points: readonly ChartPaintPoint[],
    color: string,
    width: number,
    step: boolean,
  ): void {
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1]!;
      const current = points[index]!;
      if (step) {
        this.line(previous.x, previous.y, current.x, previous.y, color, width);
        this.line(current.x, previous.y, current.x, current.y, color, width);
      } else {
        this.line(previous.x, previous.y, current.x, current.y, color, width);
      }
    }
  }

  area(
    points: readonly ChartPaintPoint[],
    baseline: number,
    color: string,
    opacity: number,
    step: boolean,
  ): void {
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1]!;
      const current = points[index]!;
      const left = Math.round(Math.min(previous.x, current.x));
      const right = Math.round(Math.max(previous.x, current.x));
      for (let x = left; x <= right; x += 1) {
        const ratio = right === left ? 0 : (x - left) / (right - left);
        const y = step ? previous.y : previous.y + (current.y - previous.y) * ratio;
        this.fillRect(x, Math.min(y, baseline), x, Math.max(y, baseline), color, opacity);
      }
    }
  }

  circle(x: number, y: number, radius: number, color: string): void {
    drawCircle(
      this.data,
      this.width,
      this.height,
      x,
      y,
      radius,
      this.color(color),
    );
  }
}

export function renderCompositePanelBitmap(
  panel: CompositePanelScene,
  options: RenderCompositePanelBitmapOptions,
): NativeChartBitmap {
  const width = Math.max(1, Math.floor(options.pixelWidth));
  const height = Math.max(1, Math.floor(options.pixelHeight));
  const pixels = new Uint8Array(width * height * 4);
  paintCompositePanel(
    new BitmapCompositePainter(pixels, width, height),
    panel,
    options.colors,
    width,
    height,
  );
  return { width, height, pixels };
}
