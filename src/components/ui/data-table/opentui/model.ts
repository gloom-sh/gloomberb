import { displayWidth } from "../../../../utils/format";
import { tableColumnLeadGap } from "../../table-layout";

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
 * What a table's header says at its right edge while columns are out of view
 * past it, longest first: the longest that fits beside the last column shown
 * whole is drawn. With that column against the edge, the arrow takes the
 * blank its label ends in. The hint never hides a column: with no blank to
 * take, the horizontal scrollbar is the only sign.
 */
const MORE_COLUMNS_LABELS = ["more →", "more", "→"] as const;

export interface MoreColumnsHint {
  /** The cells the hint draws: its label, after a blank unless it takes the last column's own. */
  text: string;
  /** Where `text` starts, from the viewport's left edge. */
  left: number;
  /** Cells at the body's right edge the rows leave blank under the hint (`resolveDataTableColumnClips`). */
  reserve: number;
}

interface HintColumn {
  width: number;
  align?: string;
  /** The header label as drawn, with its sort mark. */
  label: string;
}

/**
 * Whether a column is out of view past the body's right edge at this scroll.
 * A column the edge cuts counts when it shows nothing to read: figures cut on
 * the right are blank (`cutColumnText`), and text shows less than its label.
 * Text cut after its label ends in an ellipsis instead.
 */
function hasColumnsPastRightEdge(columns: readonly HintColumn[], starts: readonly number[], right: number): boolean {
  return columns.some((column, index) => {
    const start = starts[index] ?? 0;
    if (start + column.width <= right) return false;
    const shown = right - start;
    return shown <= 0 || (column.align ?? "left") !== "left" || shown < displayWidth(column.label);
  });
}

/**
 * The "more →" hint at the header's right edge while columns are out of view
 * past it, or null. The header's scroll box is as wide as the viewport, and
 * `besideHeader` blank cells follow it on the header row (the cell over the
 * body's vertical scrollbar); the hint, laid over the row, can reach them.
 * The hint sits after a blank: a gap, cells past the last column shown whole,
 * or that column's own trailing blank (a label shorter than its column keeps
 * one, `fitTableHeaderText`), and only cut columns give it room. Never in a
 * viewport too narrow to show a column beside it, or before it is measured.
 */
export function resolveMoreColumnsHint({
  columns,
  columnGap,
  columnStarts,
  besideHeader = 0,
  frozenFirstColumn = false,
  horizontalPadding,
  scrollLeft,
  viewportWidth,
}: {
  columns: readonly HintColumn[];
  columnGap: number;
  /** Where each column's content starts, from the first column (tableColumnStarts). */
  columnStarts: readonly number[];
  /** Blank cells right of the header's scroll box on the header row. */
  besideHeader?: number;
  frozenFirstColumn?: boolean;
  horizontalPadding: number;
  scrollLeft: number;
  viewportWidth: number;
}): MoreColumnsHint | null {
  const longest = displayWidth(MORE_COLUMNS_LABELS[0]) + 1;
  if (columns.length === 0 || viewportWidth < longest * 2) return null;
  const right = scrollLeft + viewportWidth;
  const starts = columns.map((_, index) => horizontalPadding + (columnStarts[index] ?? 0));
  if (!hasColumnsPastRightEdge(columns, starts, right)) return null;
  // The last column drawn whole (a frozen first column rides along with the scroll), and whether its label
  // ends in a blank of its own.
  let lastEnd = scrollLeft;
  let lastPadded = false;
  columns.forEach((column, index) => {
    const start = (starts[index] ?? 0) + (frozenFirstColumn && index === 0 ? scrollLeft : 0);
    const end = start + column.width;
    if (end > right || end <= lastEnd) return;
    lastEnd = end;
    const next = columns[index + 1];
    lastPadded = !!next && tableColumnLeadGap(columns, index + 1, columnGap) === 0 && displayWidth(column.label) < column.width;
  });
  const headerRight = right + Math.max(0, besideHeader);
  const place = (label: string) => {
    const labelStart = headerRight - displayWidth(label);
    // The rows stop where the blank before the label starts, unless that blank is the last column's own.
    const rowsEnd = labelStart === lastEnd && lastPadded ? lastEnd : labelStart - 1;
    return { text: ` ${label}`, left: labelStart - 1 - scrollLeft, reserve: Math.max(0, right - rowsEnd), fits: rowsEnd >= lastEnd };
  };
  const fitted = MORE_COLUMNS_LABELS.map(place).find((candidate) => candidate.fits);
  if (fitted) return { text: fitted.text, left: fitted.left, reserve: fitted.reserve };
  // The last column ends at the header's edge: the arrow takes its label's trailing blank, the rows keep it.
  if (lastPadded && headerRight === lastEnd) return { text: MORE_COLUMNS_LABELS[2], left: lastEnd - 1 - scrollLeft, reserve: 0 };
  return null;
}

/**
 * Each column's clip at the current scroll, null for a column shown whole.
 * A frozen first column stays, and what slides under it counts as cut on the
 * left. `rightReserve` cells at the right edge show no column (under the
 * "more →" hint, `resolveMoreColumnsHint`). Null for the whole table when every column is whole or nothing is
 * measured yet.
 */
export function resolveDataTableColumnClips({
  columnGap,
  columnStarts,
  frozenFirstColumn,
  horizontalPadding,
  rightReserve = 0,
  scrollLeft,
  viewportWidth,
  widths,
}: {
  columnGap: number;
  /** Where each column's content starts, from the first column (tableColumnStarts). */
  columnStarts: readonly number[];
  frozenFirstColumn: boolean;
  horizontalPadding: number;
  /** Cells at the viewport's right edge that show no column. */
  rightReserve?: number;
  scrollLeft: number;
  viewportWidth: number;
  /** Each column's drawn width. */
  widths: readonly number[];
}): (DataTableColumnClip | null)[] | null {
  if (viewportWidth <= 0 || widths.length === 0) return null;
  const right = scrollLeft + viewportWidth - Math.max(0, rightReserve);
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
