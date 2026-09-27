export type SortDirection = "asc" | "desc";
export type SortComparableValue = string | number | null | undefined;

export function compareSortValues(
  left: SortComparableValue,
  right: SortComparableValue,
  direction: SortDirection,
): number {
  if (typeof left === "number" && !Number.isFinite(left)) left = null;
  if (typeof right === "number" && !Number.isFinite(right)) right = null;
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;

  const comparison = typeof left === "string" && typeof right === "string"
    ? left.localeCompare(right)
    : Number(left) - Number(right);
  return direction === "asc" ? comparison : -comparison;
}

export interface SortPreference<Id extends string> {
  columnId: Id | null;
  direction: SortDirection;
}

export interface HeaderSortOptions<Id extends string, Reset = SortPreference<Id>> {
  /** Direction a newly clicked column starts in. Defaults to ascending. */
  firstDirection?: SortDirection | ((columnId: Id) => SortDirection);
  /**
   * State a third click on the same column returns to, such as the table's
   * default sort or `{ columnId: null }` for unsorted. Without it the column
   * keeps flipping between directions.
   */
  resetTo?: Reset;
}

/**
 * Sort state after a column header click. A new column starts in its first
 * direction and a second click flips it; the next click either flips back or,
 * with `resetTo`, returns to that state.
 */
export function nextHeaderSort<Id extends string, Reset extends SortPreference<string> = never>(
  current: { readonly columnId: Id | null; readonly direction: SortDirection },
  columnId: Id,
  options: HeaderSortOptions<Id, Reset> = {},
): { columnId: Id; direction: SortDirection } | NoInfer<Reset> {
  const { firstDirection = "asc", resetTo } = options;
  const first = typeof firstDirection === "function" ? firstDirection(columnId) : firstDirection;
  if (current.columnId !== columnId) return { columnId, direction: first };
  if (resetTo !== undefined && current.direction !== first) return resetTo;
  return { columnId, direction: current.direction === "asc" ? "desc" : "asc" };
}

/**
 * Keyboard equivalent of clicking column headers: walks every sort state the
 * mouse can reach (each column ascending then descending, plus the unsorted
 * state when the table has one) so sorting is not mouse-only.
 */
export function cycleSortPreference<Id extends string>(
  columnIds: readonly Id[],
  current: SortPreference<Id>,
  step: 1 | -1,
  options?: { allowUnsorted?: boolean },
): SortPreference<Id> {
  const states: SortPreference<Id>[] = options?.allowUnsorted
    ? [{ columnId: null, direction: "asc" }]
    : [];
  for (const columnId of columnIds) {
    states.push({ columnId, direction: "asc" }, { columnId, direction: "desc" });
  }
  if (states.length === 0) return current;

  const index = states.findIndex(
    (state) => state.columnId === current.columnId && state.direction === current.direction,
  );
  const next = (index < 0 ? 0 : index + step + states.length) % states.length;
  return states[next]!;
}
