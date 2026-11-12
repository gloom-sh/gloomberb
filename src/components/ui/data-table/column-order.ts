/**
 * Dragging a table's header moves its column, and the pane remembers the
 * order. These are the rules every renderer and the pane's settings share:
 * which leading columns stay put, where a drop lands, how a remembered order
 * applies to the columns a pane passes, and how a move is written back.
 */

/** The pane setting a table's remembered column order is kept under, by table (`columnOrderKey`). */
export const COLUMN_ORDER_SETTING = "columnOrder";

/** How far a press on a header moves before it drags its column rather than sorting: pixels on the desktop and the web. */
export const COLUMN_DRAG_THRESHOLD_PX = 5;
/** The same in the terminal, in cells: a click that wobbles by one cell still sorts. */
export const COLUMN_DRAG_THRESHOLD_CELLS = 2;

/** Narrower than this, a leading column is a mark beside the row's name (a status dot, a star, a rank), not the name. */
const ROW_NAME_MIN_WIDTH = 4;

interface OrderedColumn {
  id: string;
  label: string;
  width: number;
}

/**
 * The leading columns that name the row and stay first: the first column, and
 * with it the narrow unlabeled or rank columns before it, so a selection
 * marker or a rank stays beside the ticker it marks.
 */
export function rowAnchorColumnCount(columns: readonly OrderedColumn[]): number {
  let count = 0;
  for (const column of columns) {
    count += 1;
    if (column.label.trim() !== "" && column.width >= ROW_NAME_MIN_WIDTH) break;
  }
  return count;
}

/**
 * The columns in the remembered order. The anchored columns stay first as the
 * pane gave them; the others follow `saved`, and one it does not name (a
 * column the pane added since) keeps its place after the column before it in
 * the pane's own order. The same array when nothing moves.
 */
export function orderColumns<C extends { id: string }>(
  columns: readonly C[],
  saved: readonly string[] | undefined,
  anchored: number,
): readonly C[] {
  if (!saved || saved.length === 0 || columns.length - anchored < 2) return columns;
  const rank = new Map(saved.map((id, index) => [id, index]));
  const rest = columns.slice(anchored);
  const placed = rest.filter((column) => rank.has(column.id))
    .sort((left, right) => rank.get(left.id)! - rank.get(right.id)!);
  if (placed.length === 0) return columns;
  rest.forEach((column, index) => {
    if (rank.has(column.id)) return;
    let at = 0;
    for (let before = index - 1; before >= 0; before -= 1) {
      const position = placed.indexOf(rest[before]!);
      if (position >= 0) {
        at = position + 1;
        break;
      }
    }
    placed.splice(at, 0, column);
  });
  const ordered = [...columns.slice(0, anchored), ...placed];
  return ordered.every((column, index) => column === columns[index]) ? columns : ordered;
}

/**
 * The gap a dragged column would drop into, for a pointer at `x`: 0 before the
 * first column, `spans.length` after the last, never before the anchored ones.
 * `spans` are the columns' extents in the same units as `x`.
 */
export function columnDropBoundary(
  spans: readonly { start: number; end: number }[],
  x: number,
  anchored: number,
): number {
  let boundary = spans.length;
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index]!;
    if (x < (span.start + span.end) / 2) {
      boundary = index;
      break;
    }
  }
  return Math.max(anchored, boundary);
}

/** The index a column dragged from `from` lands at when dropped into gap `boundary`, or null when it stays where it is. */
export function columnDropIndex(from: number, boundary: number): number | null {
  if (boundary === from || boundary === from + 1) return null;
  return boundary > from ? boundary - 1 : boundary;
}

/** The ids with `columnId` moved to `toIndex`, or null when that is no move (an anchored column, the same place). */
export function moveColumnId(
  ids: readonly string[],
  columnId: string,
  toIndex: number,
  anchored: number,
): string[] | null {
  const from = ids.indexOf(columnId);
  if (from < anchored) return null;
  const to = Math.max(anchored, Math.min(ids.length - 1, toIndex));
  if (to === from) return null;
  const next = ids.filter((id) => id !== columnId);
  next.splice(to, 0, columnId);
  return next;
}

/**
 * The order to remember once a move turns the table's `before` order into
 * `after` (the same ids). The table's ids take the places they held in
 * `saved` in their new order, so a column the table does not show now (one
 * a narrow pane dropped, another view's) keeps its own place. Ids `saved`
 * does not have yet go in after the id before them in `before`.
 */
export function rememberColumnOrder(
  saved: readonly string[] | undefined,
  before: readonly string[],
  after: readonly string[],
): string[] {
  const base = [...(saved ?? [])];
  let last = -1;
  for (const id of before) {
    const at = base.indexOf(id);
    if (at >= 0) {
      last = at;
      continue;
    }
    last += 1;
    base.splice(last, 0, id);
  }
  const shown = new Set(after);
  const slots = base.flatMap((id, index) => shown.has(id) ? [index] : []);
  slots.forEach((slot, index) => {
    base[slot] = after[index]!;
  });
  return base;
}

/** `order` put back in `defaultOrder`'s order; ids it does not list keep their order after those it does. */
export function defaultColumnOrder(order: readonly string[], defaultOrder: readonly string[]): string[] {
  const rank = new Map(defaultOrder.map((id, index) => [id, index]));
  return order
    .map((id, index) => ({ id, index, rank: rank.get(id) ?? Number.POSITIVE_INFINITY }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.id);
}

/** The remembered orders in a pane's settings, by table; anything else there reads as none. */
export function readColumnOrders(value: unknown): Readonly<Record<string, readonly string[]>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const orders: Record<string, readonly string[]> = {};
  for (const [key, ids] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(ids) && ids.every((id) => typeof id === "string")) orders[key] = ids as string[];
  }
  return orders;
}

export function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
