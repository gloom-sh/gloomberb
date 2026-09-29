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
  return { start: Math.max(0, start - extra), end: Math.min(count, end + extra) };
}

/** The first visible row, in rows, that brings `targetIndex` into view. */
export function resolveDataTableScrollTop(
  targetIndex: number,
  currentTop: number,
  visibleHeight: number,
  itemCount: number,
  align: DataTableScrollAlign,
): number {
  const maxTop = Math.max(0, itemCount - visibleHeight);
  let nextTop = currentTop;
  if (align === "center") {
    nextTop = targetIndex - Math.floor(visibleHeight / 2);
  } else if (targetIndex < currentTop) {
    nextTop = targetIndex;
  } else if (targetIndex >= currentTop + visibleHeight) {
    nextTop = targetIndex - visibleHeight + 1;
  }
  return Math.max(0, Math.min(maxTop, nextTop));
}
