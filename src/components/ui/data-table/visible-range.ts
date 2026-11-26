import type { DataTableScrollAlign, DataTableVisibleRange } from "./types";

export function resolveDataTableVisibleRange({
  itemCount,
  rowSize,
  scrollOffset,
  viewportSize,
  buffer = 0,
}: {
  itemCount: number;
  rowSize: number;
  scrollOffset: number;
  viewportSize: number;
  /** Rows added past each edge of the viewport. */
  buffer?: number;
}): DataTableVisibleRange {
  const count = Math.max(0, Math.floor(itemCount));
  const size = Number.isFinite(rowSize) && rowSize > 0 ? rowSize : 1;
  const offset = Number.isFinite(scrollOffset) ? Math.max(0, scrollOffset) : 0;
  const viewport = Number.isFinite(viewportSize) ? Math.max(0, viewportSize) : 0;
  const extra = Number.isFinite(buffer) ? Math.max(0, Math.floor(buffer)) : 0;
  const start = Math.min(count, Math.floor(offset / size));
  const end = Math.min(count, Math.max(start, Math.ceil((offset + viewport) / size)));
  // A pixel of subpixel layout does not cut a row.
  const wholeStart = Math.max(0, Math.min(count, Math.ceil(offset / size - WHOLE_ROW_TOLERANCE)));
  const wholeEnd = Math.min(count, Math.max(wholeStart, Math.floor((offset + viewport) / size + WHOLE_ROW_TOLERANCE)));
  const range = { start: Math.max(0, start - extra), end: Math.min(count, end + extra) };
  return range.start === wholeStart && range.end === wholeEnd ? range : { ...range, wholeStart, wholeEnd };
}

const WHOLE_ROW_TOLERANCE = 0.05;

export function sameVisibleRange(a: DataTableVisibleRange, b: DataTableVisibleRange): boolean {
  return a.start === b.start && a.end === b.end && a.wholeStart === b.wholeStart && a.wholeEnd === b.wholeEnd;
}

/**
 * The first visible row, in rows, that brings `targetIndex` into view. With
 * `fromIndex` above it, the rows from there down come into view too, as many
 * as fit with the target still on screen; a centered target stays centered.
 */
export function resolveDataTableScrollTop(
  targetIndex: number,
  currentTop: number,
  visibleHeight: number,
  itemCount: number,
  align: DataTableScrollAlign,
  fromIndex?: number | null,
): number {
  const maxTop = Math.max(0, itemCount - visibleHeight);
  let nextTop = currentTop;
  if (align === "center") {
    nextTop = targetIndex - Math.floor(visibleHeight / 2);
  } else if (align === "start") {
    nextTop = targetIndex;
  } else if (targetIndex < currentTop) {
    nextTop = targetIndex;
  } else if (targetIndex >= currentTop + visibleHeight) {
    nextTop = targetIndex - visibleHeight + 1;
  }
  if (align !== "center" && fromIndex != null && fromIndex < targetIndex && fromIndex < nextTop) {
    nextTop = Math.max(fromIndex, targetIndex - visibleHeight + 1);
  }
  return Math.max(0, Math.min(maxTop, nextTop));
}
