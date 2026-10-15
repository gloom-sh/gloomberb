/** The columns a table draws: `from` to `to`, inclusive, besides a frozen first column. */
export interface DataTableWholeColumns {
  from: number;
  to: number;
}

/**
 * The columns the viewport shows whole. A column the edge of the pane would
 * cut is left blank instead, so a number never shows shorter than it is (LAST
 * 98.53 as "98") and a header never as a stub ("LA"); scrolling brings it
 * into view whole. A frozen first column stays, and the columns that slide
 * under it count as cut. Null draws every column: nothing is measured yet, or
 * no column fits the viewport whole, when a part of one says more than none.
 */
export function resolveDataTableWholeColumns({
  columnGap,
  columnStarts,
  frozenFirstColumn,
  horizontalPadding,
  scrollLeft,
  viewportWidth,
  widths,
}: {
  columnGap: number;
  /** Where each column's content starts, from the first column (tableColumnStarts). */
  columnStarts: readonly number[];
  frozenFirstColumn: boolean;
  horizontalPadding: number;
  scrollLeft: number;
  viewportWidth: number;
  /** Each column's drawn width. */
  widths: readonly number[];
}): DataTableWholeColumns | null {
  if (viewportWidth <= 0 || widths.length === 0) return null;
  const right = scrollLeft + viewportWidth;
  const first = frozenFirstColumn ? 1 : 0;
  const left = frozenFirstColumn ? scrollLeft + horizontalPadding + (widths[0] ?? 0) + columnGap : scrollLeft;
  let from = -1;
  let to = -1;
  for (let index = first; index < widths.length; index += 1) {
    const start = horizontalPadding + (columnStarts[index] ?? 0);
    if (start < left || start + (widths[index] ?? 0) > right) continue;
    if (from < 0) from = index;
    to = index;
  }
  if (from < 0) return null;
  // Every column is whole: the table draws as it always has.
  if (from === first && to === widths.length - 1) return null;
  return { from, to };
}

/** Whether the table draws the column at `index`; a frozen first column always shows. */
export function isDataTableColumnShown(shown: DataTableWholeColumns | null, index: number, frozenFirstColumn: boolean): boolean {
  if (!shown || (frozenFirstColumn && index === 0)) return true;
  return index >= shown.from && index <= shown.to;
}

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
