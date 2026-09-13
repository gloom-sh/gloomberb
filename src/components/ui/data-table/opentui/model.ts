import type { DataTableScrollAlign } from "../types";

interface DataTableVisibleWindowOptions<T> {
  appViewportHeight: number;
  items: T[];
  measuredViewportHeight: number | undefined;
  overscan: number;
  scrollTop: number;
  virtualize: boolean;
  /**
   * Cells per row. The scroll box measures in cells while the window is in
   * rows, so every conversion between the two goes through this. It used to be
   * implicitly 1, which is why a taller row would have scrolled at double
   * speed and rendered twice the rows that fit.
   */
  rowHeight?: number;
}

export interface DataTableVisibleWindow<T> {
  endIndex: number;
  startIndex: number;
  viewportHeight: number;
  visibleItems: T[];
}

/** Row index of the first visible row, from a scroll offset measured in cells. */
export function dataTableTopRow(scrollTop: number, rowHeight: number): number {
  const size = normalizeRowHeight(rowHeight);
  return Math.max(0, Math.floor((Number.isFinite(scrollTop) ? scrollTop : 0) / size));
}

function normalizeRowHeight(rowHeight: number | undefined): number {
  return Number.isFinite(rowHeight) && (rowHeight ?? 0) > 0 ? Math.floor(rowHeight!) : 1;
}

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

export function resolveDataTableVisibleWindow<T>({
  appViewportHeight,
  items,
  measuredViewportHeight,
  overscan,
  scrollTop,
  virtualize,
  rowHeight,
}: DataTableVisibleWindowOptions<T>): DataTableVisibleWindow<T> {
  const size = normalizeRowHeight(rowHeight);
  // Both measurements arrive in cells; the window is in rows.
  const viewportRows = virtualize
    ? Math.max(
        1,
        Math.ceil(
          Math.min(
            measuredViewportHeight ?? Math.min(items.length * size, 16),
            Math.max(1, Math.ceil(appViewportHeight)),
          ) / size,
        ),
      )
    : items.length;
  const viewportHeight = viewportRows;
  const startIndex = virtualize ? Math.max(dataTableTopRow(scrollTop, size) - overscan, 0) : 0;
  const endIndex = virtualize
    ? Math.min(startIndex + viewportRows + overscan * 2, items.length)
    : items.length;

  return {
    endIndex,
    startIndex,
    viewportHeight,
    visibleItems: items.slice(startIndex, endIndex),
  };
}
