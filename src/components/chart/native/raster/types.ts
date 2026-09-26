export interface CellRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeChartBitmap {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export interface NativePlacement {
  column: number;
  row: number;
  cols: number;
  rows: number;
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  /** Kitty stacking order; overlays sit above the plot they annotate. */
  zIndex?: number;
}
