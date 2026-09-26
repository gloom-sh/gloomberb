import type { PixelResolution } from "../../../../ui";
import type { CellRect, NativeChartBitmap, NativePlacement } from "./types";

export function sameCellRect(a: CellRect | null, b: CellRect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export function intersectCellRects(a: CellRect, b: CellRect): CellRect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return {
    x,
    y,
    width: right - x,
    height: bottom - y,
  };
}

function subtractCellRect(rect: CellRect, cut: CellRect): CellRect[] {
  const intersection = intersectCellRects(rect, cut);
  if (!intersection) return [rect];

  const fragments: CellRect[] = [];
  const rectRight = rect.x + rect.width;
  const rectBottom = rect.y + rect.height;
  const cutRight = intersection.x + intersection.width;
  const cutBottom = intersection.y + intersection.height;

  if (intersection.y > rect.y) {
    fragments.push({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: intersection.y - rect.y,
    });
  }

  if (cutBottom < rectBottom) {
    fragments.push({
      x: rect.x,
      y: cutBottom,
      width: rect.width,
      height: rectBottom - cutBottom,
    });
  }

  if (intersection.x > rect.x) {
    fragments.push({
      x: rect.x,
      y: intersection.y,
      width: intersection.x - rect.x,
      height: intersection.height,
    });
  }

  if (cutRight < rectRight) {
    fragments.push({
      x: cutRight,
      y: intersection.y,
      width: rectRight - cutRight,
      height: intersection.height,
    });
  }

  return fragments.filter((fragment) => fragment.width > 0 && fragment.height > 0);
}

function subtractCellRects(rects: CellRect[], cut: CellRect): CellRect[] {
  return rects.flatMap((rect) => subtractCellRect(rect, cut));
}

export function excludeCellRects(rect: CellRect, cuts: CellRect[]): CellRect[] {
  let fragments = [rect];
  for (const cut of cuts) {
    fragments = subtractCellRects(fragments, cut);
    if (fragments.length === 0) break;
  }
  return fragments;
}

export function computeBitmapSize(rect: CellRect, resolution: PixelResolution, terminalWidth: number, terminalHeight: number) {
  const cellWidth = resolution.width / Math.max(terminalWidth, 1);
  const cellHeight = resolution.height / Math.max(terminalHeight, 1);
  return {
    cellWidth,
    cellHeight,
    pixelWidth: Math.max(1, Math.round(rect.width * cellWidth)),
    pixelHeight: Math.max(1, Math.round(rect.height * cellHeight)),
  };
}

export function computeNativePlacement(
  rect: CellRect,
  visibleRect: CellRect,
  bitmap: NativeChartBitmap,
  resolution: PixelResolution,
  terminalWidth: number,
  terminalHeight: number,
): NativePlacement | null {
  const cellWidth = resolution.width / Math.max(terminalWidth, 1);
  const cellHeight = resolution.height / Math.max(terminalHeight, 1);
  const clipped = intersectCellRects(rect, visibleRect);
  if (!clipped) return null;

  const cropX = Math.max(0, Math.round((clipped.x - rect.x) * cellWidth));
  const cropY = Math.max(0, Math.round((clipped.y - rect.y) * cellHeight));
  const cropWidth = Math.max(1, Math.min(bitmap.width - cropX, Math.round(clipped.width * cellWidth)));
  const cropHeight = Math.max(1, Math.min(bitmap.height - cropY, Math.round(clipped.height * cellHeight)));

  return {
    column: clipped.x + 1,
    row: clipped.y + 1,
    cols: clipped.width,
    rows: clipped.height,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
  };
}

export function computeNativePlacements(
  rect: CellRect,
  visibleRects: CellRect[],
  bitmap: NativeChartBitmap,
  resolution: PixelResolution,
  terminalWidth: number,
  terminalHeight: number,
): NativePlacement[] {
  return visibleRects
    .map((visibleRect) => computeNativePlacement(rect, visibleRect, bitmap, resolution, terminalWidth, terminalHeight))
    .filter((placement): placement is NativePlacement => placement !== null);
}
