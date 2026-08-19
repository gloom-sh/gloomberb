interface StackSortPreference<C extends string> {
  columnId: C;
  direction: "asc" | "desc";
}

/**
 * Cycles a table's sort preference when a header is clicked: toggles direction
 * on the active column, otherwise switches to the new column at its default
 * direction.
 */
export function nextStackSortPreference<C extends string>(
  current: StackSortPreference<C>,
  columnId: C,
  defaultDirection: "asc" | "desc" = "desc",
): StackSortPreference<C> {
  if (current.columnId === columnId) {
    return { columnId, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { columnId, direction: defaultDirection };
}
