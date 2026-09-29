interface DataTableVisibleWindowOptions<T> {
  appViewportHeight: number;
  items: T[];
  measuredViewportHeight: number | undefined;
  overscan: number;
  scrollTop: number;
  virtualize: boolean;
}

export interface DataTableVisibleWindow<T> {
  endIndex: number;
  startIndex: number;
  viewportHeight: number;
  visibleItems: T[];
}

export function resolveDataTableVisibleWindow<T>({
  appViewportHeight,
  items,
  measuredViewportHeight,
  overscan,
  scrollTop,
  virtualize,
}: DataTableVisibleWindowOptions<T>): DataTableVisibleWindow<T> {
  const viewportHeight = virtualize
    ? Math.max(
        1,
        Math.min(
          measuredViewportHeight ?? Math.min(items.length, 16),
          Math.max(1, Math.ceil(appViewportHeight)),
        ),
      )
    : items.length;
  const startIndex = virtualize ? Math.max(scrollTop - overscan, 0) : 0;
  const endIndex = virtualize
    ? Math.min(startIndex + viewportHeight + overscan * 2, items.length)
    : items.length;

  return {
    endIndex,
    startIndex,
    viewportHeight,
    visibleItems: items.slice(startIndex, endIndex),
  };
}
