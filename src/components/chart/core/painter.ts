export interface ChartPaintPoint {
  x: number;
  y: number;
}

/** Renderer-neutral drawing primitives shared by browser and terminal charts. */
export interface ChartPainter {
  clear(color: string): void;
  fillRect(
    left: number,
    top: number,
    right: number,
    bottom: number,
    color: string,
    opacity?: number,
  ): void;
  line(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: string,
    width: number,
  ): void;
  path(
    points: readonly ChartPaintPoint[],
    color: string,
    width: number,
    step: boolean,
  ): void;
  area(
    points: readonly ChartPaintPoint[],
    baseline: number,
    color: string,
    opacity: number,
    step: boolean,
  ): void;
  circle(x: number, y: number, radius: number, color: string): void;
}

/** A complete chart frame in logical surface pixels. */
export interface ChartPaintFrame {
  width: number;
  height: number;
  /** Changes only when pixels must be repainted. */
  revision: number;
  /** Compositor-only horizontal placement inside the clipped chart surface. */
  offsetX: number;
  paint(painter: ChartPainter): void;
}

export interface ChartPointerInput {
  x: number;
  y: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

/** Mutable frame source used by native chart surfaces outside React's render loop. */
export interface ChartPaintSource {
  getFrame(): ChartPaintFrame | null;
  subscribe(listener: () => void): () => void;
  pointerDown?(input: ChartPointerInput): boolean;
  pointerMove?(input: ChartPointerInput): void;
  pointerUp?(input: ChartPointerInput): void;
  pointerCancel?(): void;
}
