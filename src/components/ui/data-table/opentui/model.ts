/**
 * How a column the viewport cuts is drawn. Text is fitted to the cells that
 * show, from the visible edge (`inset` cells in), with an ellipsis when it is
 * longer, so a name reads "Definitive agr\u2026", never a hard stop. A number,
 * right-aligned or centred, is left blank instead: part of one reads as
 * another number (LAST 98.53 as "98", a header as "LA"). Scrolling brings it
 * into view whole.
 */
export type DataTableColumnClip = { kind: "fit"; inset: number; width: number } | { kind: "blank" };

const BLANK_COLUMN: DataTableColumnClip = { kind: "blank" };

/**
 * Each column's clip at the current scroll, null for a column shown whole.
 * A frozen first column stays, and what slides under it counts as cut on the
 * left. Null for the whole table when every column is whole, nothing is
 * measured yet, or no column fits whole, when a part of one says more than
 * none.
 */
export function resolveDataTableColumnClips({
  aligns,
  columnGap,
  columnStarts,
  frozenFirstColumn,
  horizontalPadding,
  scrollLeft,
  viewportWidth,
  widths,
}: {
  aligns: readonly (string | undefined)[];
  columnGap: number;
  /** Where each column's content starts, from the first column (tableColumnStarts). */
  columnStarts: readonly number[];
  frozenFirstColumn: boolean;
  horizontalPadding: number;
  scrollLeft: number;
  viewportWidth: number;
  /** Each column's drawn width. */
  widths: readonly number[];
}): (DataTableColumnClip | null)[] | null {
  if (viewportWidth <= 0 || widths.length === 0) return null;
  const right = scrollLeft + viewportWidth;
  const left = frozenFirstColumn ? scrollLeft + horizontalPadding + (widths[0] ?? 0) + columnGap : scrollLeft;
  let whole = 0;
  let cut = 0;
  const clips = widths.map((width, index): DataTableColumnClip | null => {
    if (frozenFirstColumn && index === 0) return null;
    const start = horizontalPadding + (columnStarts[index] ?? 0);
    const end = start + width;
    if (start >= left && end <= right) {
      whole += 1;
      return null;
    }
    cut += 1;
    const shown = Math.min(end, right) - Math.max(start, left);
    const align = aligns[index];
    return shown > 0 && align !== "right" && align !== "center"
      ? { kind: "fit", inset: Math.max(0, left - start), width: shown }
      : BLANK_COLUMN;
  });
  return whole > 0 && cut > 0 ? clips : null;
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
