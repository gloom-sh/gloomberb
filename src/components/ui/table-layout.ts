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
 *
 * `keepEnd`, the end of `text` the cut keeps whole (a cell's `keepEnd`), moves
 * the ellipsis before it while the width holds it and a character of what
 * comes first: "Brent Crude Oil Last Day… Jan 2027".
 */
export function fitTableCellText(text: string, width: number, align?: string, keepEnd?: string): string {
  return padToWidth(clipKeepingEnd(text, width, keepEnd), width, align);
}

function clipKeepingEnd(text: string, width: number, keepEnd: string | undefined): string {
  if (!keepEnd || displayWidth(text) <= width || !text.endsWith(keepEnd)) return clipToDisplayWidth(text, width);
  const lead = text.slice(0, -keepEnd.length);
  const room = width - displayWidth(keepEnd);
  // One character and the ellipsis, or the end is all there is to read.
  if (lead.trim() === "" || room < 2) return clipToDisplayWidth(text, width);
  return `${clipToDisplayWidth(lead, room)}${keepEnd}`;
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

/** The narrowest first column that names its row: a short ticker. A rank (`#`) or a status dot is narrower. */
const ROW_LABEL_MIN_WIDTH = 4;

/**
 * Whether a table pins its first column while it scrolls sideways. A table
 * that sets `freezeFirstColumn` gets what it set; one that leaves it unset
 * pins its first column while it is too wide for its viewport (`overflows`)
 * and that column leaves the others at least half the viewport, so scrolled
 * right each row still says what it is (a 70-column Relative Valuation read
 * `4.50T 23.6 11.7` with no ticker). A first column the pane draws itself
 * (a name beside its kind, a badge) pins as drawn. A table that fits is drawn
 * as it always was. A first column too narrow to name its row (a rank, a
 * status dot, a star) or wider than half would leave nothing worth pinning or
 * too little to scroll through, so it scrolls.
 */
export function tableFreezesFirstColumn({
  freezeFirstColumn,
  columns,
  columnGap = 1,
  horizontalPadding = 1,
  viewportWidth,
  overflows,
}: {
  freezeFirstColumn: boolean | undefined;
  columns: readonly TableWidthColumn[];
  columnGap?: number;
  horizontalPadding?: number;
  viewportWidth: number;
  overflows: boolean;
}): boolean {
  if (freezeFirstColumn !== undefined) return freezeFirstColumn;
  const first = columns[0];
  if (!overflows || !first || columns.length < 2 || viewportWidth <= 0) return false;
  const width = tableColumnWidth(first);
  return width >= ROW_LABEL_MIN_WIDTH && (horizontalPadding + width + columnGap) * 2 <= viewportWidth;
}

/**
 * Where a frozen board can stop: 0, each column's edge (its start just past
 * the frozen column) and its end, the first edge that shows the last column
 * whole, or `maxLeft` when none does.
 */
function frozenBoardStops(columns: readonly TableWidthColumn[], columnGap: number, horizontalPadding: number, viewportWidth: number) {
  const normalized = normalizeTableColumns(columns);
  const starts = tableColumnStarts(normalized, columnGap);
  const frozenWidth = (normalized[0]?.width ?? 0) + columnGap;
  const edges = starts.slice(1).map((start) => start - frozenWidth).filter((edge) => edge > 0);
  const last = normalized.length - 1;
  // Scrolled this far the last column shows whole; what follows it is the table's own blank edge.
  const lastShown = Math.max(0, horizontalPadding + (starts[last] ?? 0) + (normalized[last]?.width ?? 0) - viewportWidth);
  return { edges, end: edges.find((edge) => edge >= lastShown) ?? null };
}

/**
 * Where a sideways step of a table too wide for its pane lands (Shift or
 * Ctrl+Left/Right, "more ⇧→"): half the viewport on. With a frozen first
 * column it stops at a column's edge, so the column beside the frozen one
 * shows whole: half a viewport cut a column under it, and a rate too wide
 * for what showed went blank. A column wider than half the viewport is
 * stepped to whole, and the far end is an edge too (`tableFarEdgePad`).
 */
export function tableScrollStep({
  columns,
  columnGap = 1,
  horizontalPadding = 1,
  frozenFirstColumn = false,
  scrollLeft,
  direction,
  viewportWidth,
  maxLeft,
}: {
  columns: readonly TableWidthColumn[];
  columnGap?: number;
  horizontalPadding?: number;
  frozenFirstColumn?: boolean;
  scrollLeft: number;
  direction: -1 | 1;
  viewportWidth: number;
  maxLeft: number;
}): number {
  const step = Math.max(1, Math.floor(viewportWidth / 2));
  const target = scrollLeft + direction * step;
  if (!frozenFirstColumn) return Math.max(0, Math.min(maxLeft, target));
  const board = frozenBoardStops(columns, columnGap, horizontalPadding, viewportWidth);
  const end = Math.min(maxLeft, board.end ?? maxLeft);
  const stops = [...new Set([0, ...board.edges.filter((edge) => edge < end), end])];
  const onward = stops.filter((stop) => (direction > 0 ? stop > scrollLeft : stop < scrollLeft));
  if (onward.length === 0) return Math.max(0, Math.min(end, scrollLeft));
  const within = onward.filter((stop) => (direction > 0 ? stop <= target : stop >= target));
  if (within.length > 0) return direction > 0 ? Math.max(...within) : Math.min(...within);
  return direction > 0 ? Math.min(...onward) : Math.max(...onward);
}

/**
 * Where a table too wide for its pane scrolls to put one column in the middle
 * of what shows past a frozen first column (OVDV's grid opens on its ATM
 * column, not on the 80% one at its left edge). With a frozen first column it
 * stops at a column's edge, as a step does, so the column beside the frozen
 * one shows whole; within `maxLeft` either way.
 */
export function tableRevealLeft({
  columns,
  columnGap = 1,
  horizontalPadding = 1,
  frozenFirstColumn = false,
  columnIndex,
  viewportWidth,
  maxLeft,
}: {
  columns: readonly TableWidthColumn[];
  columnGap?: number;
  horizontalPadding?: number;
  frozenFirstColumn?: boolean;
  columnIndex: number;
  viewportWidth: number;
  maxLeft: number;
}): number {
  const normalized = normalizeTableColumns(columns);
  const starts = tableColumnStarts(normalized, columnGap);
  const column = normalized[columnIndex];
  if (!column || viewportWidth <= 0 || maxLeft <= 0) return 0;
  const frozenEnd = frozenFirstColumn && columnIndex > 0 ? horizontalPadding + (normalized[0]?.width ?? 0) + columnGap : 0;
  const start = horizontalPadding + starts[columnIndex]!;
  const centred = start + column.width / 2 - (frozenEnd + (viewportWidth - frozenEnd) / 2);
  const clamp = (left: number) => Math.max(0, Math.min(maxLeft, left));
  if (!frozenFirstColumn) return clamp(Math.round(centred));
  // A column edge just past the frozen column, the nearest to centring it that still shows it whole.
  const shows = (left: number) => start - left >= frozenEnd && start + column.width - left <= viewportWidth;
  const edges = [0, ...starts.slice(1).map((edge) => edge - (normalized[0]?.width ?? 0) - columnGap), maxLeft]
    .map(clamp).filter(shows);
  return edges.length ? edges.reduce((best, edge) => Math.abs(edge - centred) < Math.abs(best - centred) ? edge : best)
    : clamp(Math.round(centred));
}

/**
 * Blank cells a table with a frozen first column takes past its last column,
 * so scrolled to its far end it starts a column whole beside the frozen one,
 * as each step does (`tableScrollStep`), rather than cutting one under it.
 * None when an edge already shows the last column whole.
 */
export function tableFarEdgePad({
  columns,
  columnGap = 1,
  horizontalPadding = 1,
  contentWidth,
  viewportWidth,
}: {
  columns: readonly TableWidthColumn[];
  columnGap?: number;
  horizontalPadding?: number;
  contentWidth: number;
  viewportWidth: number;
}): number {
  const maxLeft = contentWidth - viewportWidth;
  if (viewportWidth <= 0 || maxLeft <= 0) return 0;
  const { end } = frozenBoardStops(columns, columnGap, horizontalPadding, viewportWidth);
  return end == null ? 0 : Math.max(0, end - maxLeft);
}

export function hasMeaningfulTableHorizontalOverflow(
  tableWidth: number,
  viewportWidth: number,
  columnGap = TRAILING_COLUMN_GUTTER_WIDTH,
): boolean {
  return viewportWidth > 0 && tableWidth - viewportWidth > columnGap;
}

/**
 * The columns a terminal table drew, by its body's scroll box, while
 * `fitTableColumns` has moved them from the widths the pane set: a sideways
 * step and the column a table opens on go by the edges the reader sees.
 */
export const drawnTableColumns = new WeakMap<object, readonly TableWidthColumn[]>();

/** Cells handed out one at a time, left to right, to the columns still short of their target. */
function growColumns(widths: number[], targets: readonly number[], indexes: readonly number[], extra: number): number {
  let left = extra;
  while (left > 0) {
    const short = indexes.filter((index) => widths[index]! < targets[index]!);
    if (short.length === 0) break;
    for (const index of short) {
      if (left <= 0) break;
      widths[index]! += 1;
      left -= 1;
    }
  }
  return left;
}

/**
 * The terminal table's columns as wide as the room and what they hold allow,
 * before any column is cut or pushed out of view past the right edge.
 * `contentWidths` is the widest text each column holds now, its header aside,
 * or null where it draws something that cannot be measured (it keeps its set
 * width). A table whose set widths fit (to its trailing gap) and cut nothing
 * is left as set. Otherwise every column first gives up the blank past its
 * text, down to its header and sort mark; a column that cuts its text then
 * takes back what it needs while room is left, and the others take back
 * their blank, a cell at a time. A column that grows (`flexGrow`) takes what
 * is left after that, as it always did.
 *
 * When even that leaves columns past the edge, as many leading columns as fit
 * whole beside the shortest form of the hint that says more follow
 * (`edgeHint.least`) keep the room, or beside the table's padding without a
 * hint. Their cut text takes what it needs first; then the hint's whole form
 * (`edgeHint.whole`), unless a last column, a few cells of it then in view,
 * would show them as cut text instead of the hint; then their blank, up to
 * their set widths. The others wait past the edge at their narrowest.
 *
 * A fit that shows no more than the set widths do (no cut text longer, no
 * column more in view) leaves the table as set.
 */
export function fitTableColumns<C extends TableWidthColumn>(
  columns: readonly C[],
  contentWidths: readonly (number | null)[],
  viewportWidth: number,
  columnGap = 1,
  horizontalPadding = 1,
  edgeHint: { least: number; whole: number } = { least: 0, whole: 0 },
): C[] {
  const set = normalizeTableColumns(columns);
  if (viewportWidth <= 0 || set.length === 0) return set;
  const floors = set.map((column) => (column.label ? Math.min(column.width, displayWidth(column.label) + HEADER_RESERVED_WIDTH) : 1));
  const wants = set.map((column, index) => {
    const content = contentWidths[index];
    return content == null ? column.width : Math.max(floors[index]!, Math.ceil(content));
  });
  const cut = set.flatMap((column, index) => (wants[index]! > column.width ? [index] : []));
  const room = Math.floor(viewportWidth);
  const overflows = hasMeaningfulTableHorizontalOverflow(getTableWidth(set, columnGap, horizontalPadding), room, columnGap);
  if (cut.length === 0 && !overflows) return set;
  const widths = set.map((column, index) => Math.min(column.width, wants[index]!));
  const sized = () => set.map((column, index) => (widths[index] === column.width ? column : { ...column, width: widths[index]! }));
  const setWidths = set.map((column) => column.width);
  const cutGrew = (indexes: readonly number[]) => indexes.some((index) => widths[index]! > setWidths[index]!);
  let extra = room - getTableWidth(sized(), columnGap, horizontalPadding);
  if (extra >= 0) {
    extra = growColumns(widths, wants, cut, extra);
    if (!overflows && !cutGrew(cut)) return set;
    growColumns(widths, setWidths, set.map((_, index) => index), extra);
    return sized();
  }
  // Where the first `count` columns end, without the blank after the last.
  const prefixEnd = (count: number, columns: readonly C[] = sized()) => (
    getTableWidth(columns.slice(0, count), columnGap, horizontalPadding) - columnGap - horizontalPadding
  );
  const least = edgeHint.least > 0 ? edgeHint.least : horizontalPadding;
  // What the first `count` columns keep after them: the hint, or the padding, while columns follow; after the
  // last its padding, so the table runs no further past the edge than its trailing gap.
  const tail = (count: number) => (count < set.length ? least : horizontalPadding);
  let count = 0;
  while (count < set.length && prefixEnd(count + 1) + tail(count + 1) <= room) count += 1;
  if (count === 0) return sized();
  // The columns the set widths show whole, the last one's blank past it cut or not: a fit never shows fewer.
  let setCount = 0;
  while (setCount < set.length && prefixEnd(setCount + 1, set) + (setCount + 1 < set.length ? least : 0) <= room) setCount += 1;
  if (count < setCount) return set;
  const shown = set.slice(0, count).map((_, index) => index);
  extra = room - tail(count) - prefixEnd(count);
  const shownCut = cut.filter((index) => index < count);
  extra = growColumns(widths, wants, shownCut, extra);
  if (count === setCount && !cutGrew(shownCut)) return set;
  if (count < set.length) {
    // Kept for the hint's whole form, a last column after them would have that many cells in view, which text
    // shows cut rather than leave to the hint when they reach its label (hasColumnsPastRightEdge). With more
    // columns past it the hint shows anyway.
    const next = set[count]!;
    const nextInView = edgeHint.whole - columnGap - tableColumnLeadGap(sized(), count, columnGap);
    const nextShowsText = count === set.length - 1 && (next.align ?? "left") !== "right" && nextInView >= displayWidth(next.label ?? "");
    const wholeHint = Math.max(0, edgeHint.whole - least);
    if (edgeHint.least > 0 && wholeHint > 0 && extra >= wholeHint && !nextShowsText) extra -= wholeHint;
  }
  growColumns(widths, setWidths, shown, extra);
  return sized();
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
