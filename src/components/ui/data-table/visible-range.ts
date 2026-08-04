import type { DataTableVisibleRange } from "./types";

export function resolveDataTableVisibleRange({
  itemCount,
  rowSize,
  scrollOffset,
  viewportSize,
}: {
  itemCount: number;
  rowSize: number;
  scrollOffset: number;
  viewportSize: number;
}): DataTableVisibleRange {
  const count = Math.max(0, Math.floor(itemCount));
  const size = Number.isFinite(rowSize) && rowSize > 0 ? rowSize : 1;
  const offset = Number.isFinite(scrollOffset) ? Math.max(0, scrollOffset) : 0;
  const viewport = Number.isFinite(viewportSize) ? Math.max(0, viewportSize) : 0;
  const start = Math.min(count, Math.floor(offset / size));
  const end = Math.min(count, Math.max(start, Math.ceil((offset + viewport) / size)));
  return { start, end };
}
