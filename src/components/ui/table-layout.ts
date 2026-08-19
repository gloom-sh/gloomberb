import { useCallback, useEffect, useState, type RefObject } from "react";
import type { ScrollBoxRenderable } from "../../ui";
import { displayWidth, truncateToDisplayWidth } from "../../utils/format";

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
 * Width a column actually needs: its configured data width, but never less than
 * its own header label plus the sort indicator, so a header is only ever
 * shortened when the pane itself is too narrow for it.
 */
export function tableColumnWidth(column: TableWidthColumn): number {
  const width = Math.max(1, Math.floor(column.width));
  if (!column.label) return width;
  return Math.max(width, displayWidth(column.label) + HEADER_RESERVED_WIDTH);
}

export function normalizeTableColumns<C extends TableWidthColumn>(columns: readonly C[]): C[] {
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
  return padToWidth(truncateToDisplayWidth(text, width), width, align);
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
  const inner = padToWidth(truncateToDisplayWidth(text, available), available, align);
  return reserve > 0 ? `${inner} ` : inner;
}

export function getTableWidth(
  columns: readonly TableWidthColumn[],
  columnGap = 1,
  horizontalPadding = 1,
): number {
  return columns.reduce((sum, column) => sum + tableColumnWidth(column) + columnGap, horizontalPadding * 2);
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

export function buildTableGridTemplateColumns(
  columns: readonly TableWidthColumn[],
  fillAvailableWidth = true,
): string {
  const hasFlexColumn = columns.some((column) => (column.flexGrow ?? 0) > 0);
  return columns
    .map((column) => {
      const width = tableColumnWidth(column);
      const minWidth = cellWidthCss(columnMinCh(column));
      if (!fillAvailableWidth) {
        return `minmax(${minWidth}, ${cellWidthCss(width)})`;
      }
      if (!hasFlexColumn || (column.flexGrow ?? 0) > 0) {
        return `minmax(${minWidth}, ${columnFlexWeight(column)}fr)`;
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

  useEffect(scheduleContentWidthMeasure);

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
