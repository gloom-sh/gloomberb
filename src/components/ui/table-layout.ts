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
const HIDDEN_COLUMNS = Symbol("hidden table columns");
/** `restorable`: the table's own fit left it out, so its More draws it again; a pane's own choice needs a wider pane. */
type HiddenColumn = { id: string; label: string; restorable?: boolean };
type WithHiddenColumns = { [HIDDEN_COLUMNS]?: readonly HiddenColumn[] };

function hiddenColumnEntries(columns: readonly TableWidthColumn[]): HiddenColumn[] {
  return [...new Map(columns.flatMap((column: TableWidthColumn & WithHiddenColumns) => column[HIDDEN_COLUMNS] ?? [])
    .map((column) => [column.id, column])).values()];
}

export function hiddenTableColumns(columns: readonly TableWidthColumn[]): string[] {
  return hiddenColumnEntries(columns).map(({ label }) => label);
}

export function hiddenTableColumnRows(columns: readonly TableWidthColumn[], itemCount: number): number {
  return itemCount > 0 && columns.some((column: TableWidthColumn & WithHiddenColumns) => column[HIDDEN_COLUMNS]?.length) ? 1 : 0;
}

function hiddenColumnNames(labels: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts].map(([label, count]) => count > 1 ? `${label} ×${count}` : label).join(", ");
}

export function hiddenTableColumnText(columns: readonly TableWidthColumn[]): string | null {
  const hidden = hiddenTableColumns(columns);
  if (!hidden.length) return null;
  return `${hidden.length} hidden · ${hiddenColumnNames(hidden)}`;
}

/**
 * The line a table that offers its left-out columns back writes above its
 * header, in the two parts that come back differently. `restorable` names
 * what the table's own fit left out, which the press on More draws again;
 * `pane` names what the pane itself left out for width, which only a wider
 * pane shows. With both, the pane's part says so ("3 need a wider pane ·
 * AS OF UTC, 1M"), so the words beside More name what More reveals and
 * nothing else. Either alone reads as it always did (`2 hidden · FY2023,
 * FY2022`). Null where nothing is hidden.
 */
export function hiddenTableColumnDisclosure(columns: readonly TableWidthColumn[]): { restorable: string | null; pane: string | null } | null {
  const entries = hiddenColumnEntries(columns);
  if (!entries.length) return null;
  const restorable = entries.filter((entry) => entry.restorable).map(({ label }) => label);
  const pane = entries.filter((entry) => !entry.restorable).map(({ label }) => label);
  const hidden = (labels: readonly string[]) => `${labels.length} hidden · ${hiddenColumnNames(labels)}`;
  return {
    restorable: restorable.length ? hidden(restorable) : null,
    pane: !pane.length ? null : restorable.length ? `${pane.length} need a wider pane · ${hiddenColumnNames(pane)}` : hidden(pane),
  };
}

/**
 * `shown` with the columns of `original` it leaves out named on its first
 * column, after the ones `original` already names. `restorable` marks them as
 * left out by the table's own fit (`fitColumnsToWidth`), which its More draws
 * again; unmarked, they are the pane's own choice for this width.
 */
export function markHiddenTableColumns<C extends TableWidthColumn & { id: string }>(
  original: readonly C[],
  shown: C[],
  { restorable = false }: { restorable?: boolean } = {},
): C[] {
  const hidden = [...hiddenColumnEntries(original), ...original.filter(({ id }) => !shown.some((column) => column.id === id))
    .map(({ id, label }) => ({ id, label: label?.trim() || id, ...(restorable ? { restorable: true } : {}) }))];
  if (!shown[0] || !hidden.length) return shown;
  return [Object.assign({ ...shown[0] }, { [HIDDEN_COLUMNS]: hidden }), ...shown.slice(1)];
}
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

/** `text` cut to `width` cells keeping `keepEnd` whole after the ellipsis, as a table cell's `keepEnd` cuts it. */
export function clipKeepingEnd(text: string, width: number, keepEnd: string | undefined): string {
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
  return markHiddenTableColumns(columns, shown);
}

/** A table's own narrow-pane order: the columns that leave first, least needed first (`dropColumnsToFit`). */
export type TableColumnDropOrder = readonly (string | readonly string[])[];

/** The fewest cells a column set to grow is narrowed to by a fit: under it a name or a sentence reads as nothing. */
const FIT_TEXT_FLOOR = 12;

/**
 * The cells a column cannot go under in a table fitted to its width
 * (`fitColumnsToWidth`). A column the pane set to grow (`flexGrow`) is the
 * one that takes up a change in the pane's width, so it gives up length
 * first: down to half its set width, never under `FIT_TEXT_FLOOR` cells or
 * its own header. Any other column is drawn at its set width or not at all,
 * since a figure or a date cut short reads as another one.
 */
export function tableColumnFitFloor(column: TableWidthColumn): number {
  const width = tableColumnWidth(column);
  if (!((column.flexGrow ?? 0) > 0)) return width;
  const header = column.label ? displayWidth(column.label) + HEADER_RESERVED_WIDTH : 0;
  return Math.min(width, Math.max(header, FIT_TEXT_FLOOR, Math.ceil(width / 2)));
}

/**
 * A column headed "As of": the date the row's figures are good for, which a
 * figure is misread without. A fit gives it up after the table's other
 * columns unless the pane's own order names it.
 */
export function isAsOfColumn(column: TableWidthColumn): boolean {
  return /^as of\b/i.test(column.label?.trim() ?? "");
}

/**
 * `columns` with the ones set to grow narrowed until the table is `width`
 * cells wide or each is at its floor: each gives up its share of what is
 * over, in whole cells, by how much it has to give.
 */
function narrowColumnsToWidth<C extends TableWidthColumn>(columns: readonly C[], width: number, columnGap: number, horizontalPadding: number): C[] {
  const over = getTableWidth(columns, columnGap, horizontalPadding) - width;
  const set = columns.map(tableColumnWidth);
  const slack = columns.map((column, index) => set[index]! - tableColumnFitFloor(column));
  const total = slack.reduce((sum, cells) => sum + cells, 0);
  if (over <= 0 || total <= 0) return [...columns];
  const take = Math.min(over, total);
  const cut = slack.map((cells) => Math.floor(cells * take / total));
  let left = take - cut.reduce((sum, cells) => sum + cells, 0);
  // The cells a rounding left over come off the columns with the most still to give.
  for (const index of slack.map((_, at) => at).sort((a, b) => (slack[b]! - cut[b]!) - (slack[a]! - cut[a]!))) {
    if (left <= 0) break;
    if (slack[index]! > cut[index]!) { cut[index]! += 1; left -= 1; }
  }
  return columns.map((column, index) => cut[index] ? { ...column, width: set[index]! - cut[index]! } : column);
}

/**
 * The columns a table `width` cells wide draws, where it cuts a column at its
 * edge rather than fit what the column holds (the desktop and the web): none
 * is drawn cut or past the edge. The columns set to grow narrow first, to
 * their floor (`tableColumnFitFloor`); where that is not enough whole columns
 * leave until the rest fit. `dropOrder` goes first, least needed first; then
 * the columns it does not list, from the last one back, so a table that names
 * no order gives up its trailing columns, the date its figures are as of
 * after the others (`asOf`, else the ones headed so: `isAsOfColumn`).
 *
 * What a row means is kept, by column id, wherever the reader moved the
 * columns:
 *
 * - The `identifier` columns, which say what each row is, and the `sorted`
 *   one never leave.
 * - An entry of several ids in `dropOrder` is a set that means little apart
 *   (a call's field and the put's, a figure and the date it is as of): it
 *   leaves whole, and stays whole while one of it is kept. A set is the
 *   columns of it the table has, and sets that share one of those are one
 *   set, whether or not any of it is kept: two figures that each name the
 *   date they share leave with it or stay with it, and neither is left
 *   beside another figure's date. It takes the place of its first entry.
 * - A row is never left with its identifier alone or beside nothing but a
 *   date: the last figure stays.
 *
 * Where what is kept does not fit either, nothing is left out: the same
 * array, and the table scrolls sideways with every column as it did. The same
 * array too when everything fits as set, by the table's own measure of an
 * overflow (`hasMeaningfulTableHorizontalOverflow`). The columns that left
 * are marked hidden as the fit's own, so the table names them and its More
 * draws them again (`hiddenTableColumnDisclosure`).
 */
export function fitColumnsToWidth<C extends TableWidthColumn & { id: string }>(
  columns: readonly C[],
  width: number,
  { dropOrder = [], identifier = [], sorted = null, asOf, columnGap = TABLE_COLUMN_GAP, horizontalPadding = 1 }: {
    dropOrder?: TableColumnDropOrder;
    /** The columns that say what each row is. */
    identifier?: readonly string[];
    /** The column the rows are sorted by. */
    sorted?: string | null;
    /** The date columns, where `columns` carry a label that no longer says so (a translated header). */
    asOf?: readonly string[];
    columnGap?: number;
    horizontalPadding?: number;
  } = {},
): C[] {
  const overflows = (shown: readonly TableWidthColumn[]) => hasMeaningfulTableHorizontalOverflow(getTableWidth(shown, columnGap, horizontalPadding), width, columnGap);
  if (width <= 0 || !overflows(columns)) return columns as C[];
  // Whether the columns fit once the ones set to grow are at their floor.
  const fits = (shown: readonly C[]) => !overflows(shown.map((column) => ({ ...column, width: tableColumnFitFloor(column) })));
  const names = new Set(identifier);
  const stays = new Set([...identifier, ...sorted ? [sorted] : []]);
  // The order as sets of the columns this table has. Sets that share one of them are one set, in the place of the
  // first: `named` keeps every id its entries wrote, so a set stays for a column the pane sorts by and does not draw.
  const present = new Set(columns.map((column) => column.id));
  const sets: { ids: string[]; named: string[] }[] = [];
  for (const entry of dropOrder) {
    const named = typeof entry === "string" ? [entry] : [...entry];
    const ids = named.filter((id) => present.has(id));
    if (!ids.length) continue;
    const [first, ...others] = sets.filter((set) => set.ids.some((id) => ids.includes(id)));
    if (!first) { sets.push({ ids, named }); continue; }
    for (const joined of [...others, { ids, named }]) {
      first.ids.push(...joined.ids.filter((id) => !first.ids.includes(id)));
      first.named.push(...joined.named);
    }
    for (const joined of others) sets.splice(sets.indexOf(joined), 1);
  }
  const listed = new Set(dropOrder.flat());
  const unlisted = columns.filter((column) => !listed.has(column.id));
  const dates = new Set(asOf ?? columns.filter(isAsOfColumn).map((column) => column.id));
  const alone = (column: C) => ({ ids: [column.id], named: [column.id] });
  const steps = [
    ...sets,
    ...unlisted.filter((column) => !dates.has(column.id)).map(alone).reverse(),
    ...unlisted.filter((column) => dates.has(column.id)).map(alone).reverse(),
  ];
  const hasFigure = (shown: readonly C[]) => shown.some((column) => !names.has(column.id) && !dates.has(column.id));
  let shown = [...columns];
  for (const step of steps) {
    if (fits(shown)) break;
    // A set with one column that stays, stays whole.
    if (step.named.some((id) => stays.has(id))) continue;
    const rest = shown.filter((column) => !step.ids.includes(column.id));
    if (rest.length === shown.length || (hasFigure(shown) && !hasFigure(rest))) continue;
    shown = rest;
  }
  // The least worth drawing does not fit: every column, in a table that scrolls sideways.
  if (!fits(shown)) return columns as C[];
  return markHiddenTableColumns(columns, narrowColumnsToWidth(shown, width, columnGap, horizontalPadding), { restorable: true });
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
  edgeHint: {
    least: number;
    whole: number;
    /** How many leading columns these widths show whole beside the hint, as the table draws it. */
    shownWhole?: (columns: readonly C[]) => number;
  } = { least: 0, whole: 0 },
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
  // last its padding, unless the set widths already ran into it: the table runs no further past the edge.
  const lastTail = Math.max(0, Math.min(horizontalPadding, room - prefixEnd(set.length, set)));
  const tail = (count: number) => (count < set.length ? least : lastTail);
  let count = 0;
  while (count < set.length && prefixEnd(count + 1) + tail(count + 1) <= room) count += 1;
  if (count === 0) return sized();
  // The columns the set widths show whole, the last one's blank past it cut or not: a fit never shows fewer.
  const shownWhole = edgeHint.shownWhole ?? ((columns: readonly C[]) => {
    let shown = 0;
    while (shown < set.length && prefixEnd(shown + 1, columns) + (shown + 1 < set.length ? least : 0) <= room) shown += 1;
    return shown;
  });
  const setCount = shownWhole(set);
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
  const fitted = sized();
  return cutGrew(shownCut) || shownWhole(fitted) > setCount ? fitted : set;
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
