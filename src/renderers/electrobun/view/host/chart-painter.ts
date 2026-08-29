import type {
  ChartPaintPoint,
  ChartPainter,
} from "../../../../components/chart/core/painter";

export class CanvasChartPainter implements ChartPainter {
  constructor(
    private readonly context: CanvasRenderingContext2D,
    private readonly width: number,
    private readonly height: number,
  ) {}

  clear(color: string): void {
    this.context.globalAlpha = 1;
    this.context.fillStyle = color;
    this.context.fillRect(0, 0, this.width, this.height);
  }

  fillRect(
    left: number,
    top: number,
    right: number,
    bottom: number,
    color: string,
    opacity = 1,
  ): void {
    this.context.globalAlpha = opacity;
    this.context.fillStyle = color;
    this.context.fillRect(
      left,
      top,
      Math.max(right - left, 1),
      Math.max(bottom - top, 1),
    );
    this.context.globalAlpha = 1;
  }

  line(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: string,
    width: number,
  ): void {
    this.context.beginPath();
    this.context.moveTo(x0, y0);
    this.context.lineTo(x1, y1);
    this.context.strokeStyle = color;
    this.context.lineWidth = width;
    this.context.lineCap = "round";
    this.context.stroke();
  }

  path(
    points: readonly ChartPaintPoint[],
    color: string,
    width: number,
    step: boolean,
  ): void {
    const first = points[0];
    if (!first) return;
    this.context.beginPath();
    this.context.moveTo(first.x, first.y);
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1]!;
      const current = points[index]!;
      if (step) this.context.lineTo(current.x, previous.y);
      this.context.lineTo(current.x, current.y);
    }
    this.context.strokeStyle = color;
    this.context.lineWidth = width;
    this.context.lineCap = "round";
    this.context.lineJoin = "round";
    this.context.stroke();
  }

  area(
    points: readonly ChartPaintPoint[],
    baseline: number,
    color: string,
    opacity: number,
    step: boolean,
  ): void {
    const first = points[0];
    const last = points.at(-1);
    if (!first || !last) return;
    this.context.beginPath();
    this.context.moveTo(first.x, baseline);
    this.context.lineTo(first.x, first.y);
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1]!;
      const current = points[index]!;
      if (step) this.context.lineTo(current.x, previous.y);
      this.context.lineTo(current.x, current.y);
    }
    this.context.lineTo(last.x, baseline);
    this.context.closePath();
    this.context.globalAlpha = opacity;
    this.context.fillStyle = color;
    this.context.fill();
    this.context.globalAlpha = 1;
  }

  circle(x: number, y: number, radius: number, color: string): void {
    this.context.beginPath();
    this.context.arc(x, y, radius, 0, Math.PI * 2);
    this.context.fillStyle = color;
    this.context.fill();
  }
}
