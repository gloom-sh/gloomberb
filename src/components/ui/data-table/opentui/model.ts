import { displayWidth } from "../../../../utils/format";

/**
 * Where the viewport cuts a column: `inset` cells hidden on its left (past the
 * scroll, or under a frozen first column), then `width` cells that show (0
 * when none do). A column whose shown cells stop short of its width is cut on
 * the right as well. `cutColumnText` says what such a column draws.
 */
export interface DataTableColumnClip {
  inset: number;
  width: number;
}

/** Whether the viewport's edge falls inside the column, not after it. */
function clipCutsRight(clip: DataTableColumnClip, columnWidth: number): boolean {
  return clip.inset + clip.width < columnWidth;
}

/**
 * What a cut column draws in the cells that show. Text is fitted to them from
 * the visible edge, with an ellipsis when it is longer, so a name reads
 * "Definitive agr\u2026", never a hard stop. A number, right-aligned or
 * centred, keeps its place in the column and shows when those cells hold all
 * of it; otherwise they stay blank, because part of one reads as another
 * number (LAST 98.53 as "98", a header as "LA"). Scrolling brings it whole.
 *
 * `fit` places the text in a width (fitTableCellText or fitTableHeaderText);
 * `cutRight` tells it the width ends at the viewport's edge.
 */
export function cutColumnText(
  text: string,
  align: string | undefined,
  columnWidth: number,
  clip: DataTableColumnClip,
  fit: (text: string, width: number, cutRight: boolean) => string,
): string {
  if (clip.width <= 0) return "";
  if (align !== "right" && align !== "center") return fit(text, clip.width, clipCutsRight(clip, columnWidth));
  const placed = fit(text, columnWidth, false);
  const body = placed.trim();
  const start = placed.length - placed.trimStart().length;
  const end = start + displayWidth(body);
  const shownEnd = clip.inset + clip.width;
  if (!body || start < clip.inset || end > shownEnd) return " ".repeat(clip.width);
  return `${" ".repeat(start - clip.inset)}${body}${" ".repeat(shownEnd - end)}`;
}

function sameClip(a: DataTableColumnClip | null, b: DataTableColumnClip | null): boolean {
  return a === b || (a !== null && b !== null && a.inset === b.inset && a.width === b.width);
}

/**
 * The previous clips when the new ones say the same, so the memoized rows a
 * horizontal scroll did not change keep their props and skip the render.
 */
export function reuseDataTableColumnClips(
  previous: readonly (DataTableColumnClip | null)[] | null,
  next: (DataTableColumnClip | null)[] | null,
): readonly (DataTableColumnClip | null)[] | null {
  if (previous === next || !previous || !next) return next;
  return previous.length === next.length && next.every((clip, index) => sameClip(clip, previous[index] ?? null)) ? previous : next;
}

/**
 * Each column's clip at the current scroll, null for a column shown whole.
 * A frozen first column stays, and what slides under it counts as cut on the
 * left. Null for the whole table when every column is whole or nothing is
 * measured yet.
 */
export function resolveDataTableColumnClips({
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
}): (DataTableColumnClip | null)[] | null {
  if (viewportWidth <= 0 || widths.length === 0) return null;
  const right = scrollLeft + viewportWidth;
  const left = frozenFirstColumn ? scrollLeft + horizontalPadding + (widths[0] ?? 0) + columnGap : scrollLeft;
  let cut = false;
  const clips = widths.map((width, index): DataTableColumnClip | null => {
    if (frozenFirstColumn && index === 0) return null;
    const start = horizontalPadding + (columnStarts[index] ?? 0);
    const end = start + width;
    if (start >= left && end <= right) return null;
    cut = true;
    const inset = Math.min(width, Math.max(0, left - start));
    return { inset, width: Math.max(0, Math.min(end, right) - start - inset) };
  });
  return cut ? clips : null;
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
