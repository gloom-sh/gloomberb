export type SortDirection = "asc" | "desc";
export type SortComparableValue = string | number | null | undefined;

export function compareSortValues(
  left: SortComparableValue,
  right: SortComparableValue,
  direction: SortDirection,
): number {
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
