import { useCallback, useEffect, useState, type RefObject } from "react";
import type { ScrollBoxRenderable } from "../../ui";
import { clipToDisplayWidth, displayWidth } from "../../utils/format";

export interface TableWidthColumn {
  width: number;
  flexGrow?: number;
  align?: string;
  label?: string;
}

const TRAILING_COLUMN_GUTTER_WIDTH = 1;
const WEB_CELL_UNIT = "var(--cell-w)";

/** Space the sort indicator (" \u25b2") needs on top of the header label. */
const HEADER_RESERVED_WIDTH = 2;

/** Cells the data table puts between two columns. */
export const TABLE_COLUMN_GAP = 1;

/**
 * Blank cells a column gets on top of the regular gap. A right-aligned value
 * ends on its column edge and a left-aligned one starts on the next, so one
 * blank reads as a word space ("47 60 sessions"); a second keeps them apart.
 * Tables that set no gap pack their columns on purpose and get none.
 */
export function tableColumnLeadGap(
  columns: readonly TableWidthColumn[],
  index: number,
  columnGap = TABLE_COLUMN_GAP,
): number {
  if (index <= 0 || columnGap <= 0) return 0;
  const previous = columns[index - 1];
  const column = columns[index];
  return previous?.align === "right" && (column?.align ?? "left") === "left" ? 1 : 0;
}

/**
 * Width a column actually needs: its configured data width, but never less than
 * its own header label plus the sort indicator, so a header is only ever
 * shortened when the pane itself is too narrow for it.
 */
export function tableColumnWidth(column: TableWidthColumn): number {
  const width = Math.max(1, Math.floor(column.width));
  if (!column.label) return width;
  return Math.max(width, displayWidth(column.label) + HEADER_RESERVED_WIDTH);
}

function normalizeTableColumns<C extends TableWidthColumn>(columns: readonly C[]): C[] {
  return columns.map((column) => {
    const width = tableColumnWidth(column);
    return width === column.width ? column : { ...column, width };
  });
}

function padToWidth(text: string, width: number, align: string | undefined): string {
  const padding = Math.max(0, width - displayWidth(text));
  if (align === "right") return " ".repeat(padding) + text;
  if (align === "center") {
    const left = Math.floor(padding / 2);
    return " ".repeat(left) + text + " ".repeat(padding - left);
  }
  return text + " ".repeat(padding);
}

/**
 * Fit cell text to a fixed column width. Overlong text always keeps an ellipsis
 * marker, so a clipped number or date can never be misread as a shorter valid
 * value.
 */
export function fitTableCellText(text: string, width: number, align?: string): string {
  return padToWidth(clipToDisplayWidth(text, width), width, align);
}

/**
 * Fit a header label to its column, keeping one cell clear on the side facing
 * the next column. One blank is a word separator, so without this two adjacent
 * headers read as a single label ("OI ENDS").
 */
export function fitTableHeaderText(
  text: string,
  width: number,
  align?: string,
  hasNextColumn = true,
): string {
  // Never bought at the price of shortening the label: a header that already
  // fills its column keeps every character.
  const reserve = hasNextColumn && displayWidth(text) < width ? 1 : 0;
  const available = width - reserve;
  const inner = padToWidth(clipToDisplayWidth(text, available), available, align);
  return reserve > 0 ? `${inner} ` : inner;
}

export function getTableWidth(
  columns: readonly TableWidthColumn[],
  columnGap = 1,
  horizontalPadding = 1,
): number {
  return columns.reduce(
    (sum, column, index) => sum + tableColumnLeadGap(columns, index, columnGap) + tableColumnWidth(column) + columnGap,
    horizontalPadding * 2,
  );
}

/**
 * The columns that fit in `width` cells: whole columns in `dropOrder` (least
 * needed first) give way until the rest fit, rather than the table's right
 * edge cutting a value, so a narrow pane drops a name that repeats its ticker
 * before it cuts a date. An entry that lists several ids drops them together,
 * for columns that mean little apart (a bid's venue and an ask's). Columns not
 * listed stay at every width. A table that scrolls vertically passes its width
 * less the scrollbar's cell.
 */
export function dropColumnsToFit<C extends TableWidthColumn & { id: string }>(
  columns: readonly C[],
  width: number,
  dropOrder: readonly (string | readonly string[])[],
): C[] {
  let shown = [...columns];
  for (const step of dropOrder) {
    if (getTableWidth(shown) <= width) break;
    const ids = typeof step === "string" ? [step] : step;
    shown = shown.filter((column) => !ids.includes(column.id));
  }
  return shown;
}

/**
 * Where each column's content starts, in cells from the first column, counting
 * the gap after every column and any lead gap before it. Takes columns already
 * at their drawn width (after normalizeTableColumns or expandTableColumns).
 */
export function tableColumnStarts(columns: readonly TableWidthColumn[], columnGap = 1): number[] {
  const starts: number[] = [];
  let offset = 0;
  columns.forEach((column, index) => {
    offset += tableColumnLeadGap(columns, index, columnGap);
    starts.push(offset);
    offset += column.width + columnGap;
  });
  return starts;
}

/**
 * Where a sideways step of a table too wide for its pane lands (Shift or
 * Ctrl+Left/Right, "more →"): half the viewport on. With a frozen first
 * column it stops at a column's edge, so the column beside the frozen one
 * shows whole: half a viewport cut a column under it, and a rate too wide
 * for what showed went blank. A column wider than half the viewport is
 * stepped to whole, and the table's far end is an edge (`tableFarEdgePad`).
 */
export function tableScrollStep({
  columns,
  columnGap = 1,
  frozenFirstColumn = false,
  scrollLeft,
  direction,
  viewportWidth,
  maxLeft,
}: {
  columns: readonly TableWidthColumn[];
  columnGap?: number;
  frozenFirstColumn?: boolean;
  scrollLeft: number;
  direction: -1 | 1;
  viewportWidth: number;
  maxLeft: number;
}): number {
  const step = Math.max(1, Math.floor(viewportWidth / 2));
  const target = scrollLeft + direction * step;
  if (!frozenFirstColumn) return Math.max(0, Math.min(maxLeft, target));
  const normalized = normalizeTableColumns(columns);
  // A column is whole at the left once it starts past the frozen one.
  const frozenWidth = (normalized[0]?.width ?? 0) + columnGap;
  const columnEdges = tableColumnStarts(normalized, columnGap).slice(1).map((start) => start - frozenWidth);
  const edges = [...new Set([0, ...columnEdges.filter((edge) => edge > 0 && edge < maxLeft), maxLeft])];
  const onward = edges.filter((edge) => (direction > 0 ? edge > scrollLeft : edge < scrollLeft));
  if (onward.length === 0) return Math.max(0, Math.min(maxLeft, scrollLeft));
  const within = onward.filter((edge) => (direction > 0 ? edge <= target : edge >= target));
  if (within.length > 0) return direction > 0 ? Math.max(...within) : Math.min(...within);
  return direction > 0 ? Math.min(...onward) : Math.max(...onward);
}

/**
 * Blank cells a table with a frozen first column takes past its last column,
 * so scrolled to its far end it starts a column whole beside the frozen one,
 * as each step does (`tableScrollStep`), rather than cutting one under it.
 */
export function tableFarEdgePad({
  columns,
  columnGap = 1,
  contentWidth,
  viewportWidth,
}: {
  columns: readonly TableWidthColumn[];
  columnGap?: number;
  contentWidth: number;
  viewportWidth: number;
}): number {
  const maxLeft = contentWidth - viewportWidth;
  if (viewportWidth <= 0 || maxLeft <= 0) return 0;
  const normalized = normalizeTableColumns(columns);
  const frozenWidth = (normalized[0]?.width ?? 0) + columnGap;
  const edge = tableColumnStarts(normalized, columnGap).slice(1).map((start) => start - frozenWidth).find((left) => left >= maxLeft);
  return edge == null ? 0 : edge - maxLeft;
}

export function hasMeaningfulTableHorizontalOverflow(
  tableWidth: number,
  viewportWidth: number,
  columnGap = TRAILING_COLUMN_GUTTER_WIDTH,
): boolean {
  return viewportWidth > 0 && tableWidth - viewportWidth > columnGap;
}

export function expandTableColumns<C extends TableWidthColumn>(
  columns: readonly C[],
  targetWidth: number,
  columnGap = 1,
  horizontalPadding = 1,
): C[] {
  const normalized = normalizeTableColumns(columns);
  const currentWidth = getTableWidth(normalized, columnGap, horizontalPadding);
  const extraWidth = Math.floor(targetWidth) - currentWidth;
  if (extraWidth <= 0) return normalized;

  const growIndex = normalized.findIndex((column) => (column.flexGrow ?? 0) > 0);
  if (growIndex < 0) return normalized;

  return normalized.map((column, index) => {
    return index === growIndex ? { ...column, width: column.width + extraWidth } : column;
  });
}

function columnMinCh(column: TableWidthColumn): number {
  const width = tableColumnWidth(column);
  const headerFloor = column.label
    ? Math.min(width, displayWidth(column.label) + HEADER_RESERVED_WIDTH)
    : 0;
  const heuristic = (() => {
    if ((column.flexGrow ?? 0) > 0) {
      return Math.max(8, Math.min(18, Math.floor(width * 0.35)));
    }
    if (column.align === "right") {
      return Math.max(3, Math.min(width, 8));
    }
    if (width >= 16) {
      return Math.max(8, Math.min(16, Math.floor(width * 0.35)));
    }
    return Math.max(1, Math.min(width, 8));
  })();
  return Math.max(heuristic, headerFloor);
}

function columnFlexWeight(column: TableWidthColumn): number {
  const flexGrow = column.flexGrow ?? 0;
  const baseWeight = tableColumnWidth(column);
  return flexGrow > 0 ? baseWeight * Math.max(1, flexGrow) : baseWeight;
}

function cellWidthCss(width: number): string {
  return `calc(${width} * ${WEB_CELL_UNIT})`;
}

/**
 * Grid tracks for the desktop table. A column's lead gap is part of its own
 * track (the cell sits after it as a margin), so the tracks add up to
 * getTableWidth and the row and header grids stay in step.
 */
export function buildTableGridTemplateColumns(
  columns: readonly TableWidthColumn[],
  fillAvailableWidth = true,
  columnGap = TABLE_COLUMN_GAP,
): string {
  const hasFlexColumn = columns.some((column) => (column.flexGrow ?? 0) > 0);
  return columns
    .map((column, index) => {
      const lead = tableColumnLeadGap(columns, index, columnGap);
      const width = tableColumnWidth(column) + lead;
      const minWidth = cellWidthCss(columnMinCh(column) + lead);
      if (!fillAvailableWidth) {
        return `minmax(${minWidth}, ${cellWidthCss(width)})`;
      }
      if (!hasFlexColumn || (column.flexGrow ?? 0) > 0) {
        return `minmax(${minWidth}, ${columnFlexWeight(column) + lead}fr)`;
      }
      return `minmax(${minWidth}, ${cellWidthCss(width)})`;
    })
    .join(" ");
}

export function useMeasuredTableContentWidth(
  tableWidth: number,
  headerScrollRef: RefObject<ScrollBoxRenderable | null> | undefined,
  scrollRef: RefObject<ScrollBoxRenderable | null> | undefined,
) {
  const [viewportWidth, setViewportWidth] = useState(0);

  const measureContentWidth = useCallback(() => {
    const bodyWidth = scrollRef?.current?.viewport?.width || scrollRef?.current?.width || 0;
    const headerWidth = headerScrollRef?.current?.viewport?.width || headerScrollRef?.current?.width || 0;
    const nextWidth = bodyWidth || headerWidth;
    setViewportWidth((current) => current === nextWidth ? current : nextWidth);
  }, [headerScrollRef, scrollRef]);
  const scheduleContentWidthMeasure = useCallback(() => {
    measureContentWidth();
    queueMicrotask(measureContentWidth);
  }, [measureContentWidth]);

  useEffect(scheduleContentWidthMeasure, [scheduleContentWidthMeasure]);

  return {
    contentWidth: Math.max(tableWidth, viewportWidth),
    viewportWidth,
    measureContentWidth: scheduleContentWidthMeasure,
  };
}

export function tableContentWidthProps(contentWidth: number) {
  return {
    width: contentWidth,
  };
}
