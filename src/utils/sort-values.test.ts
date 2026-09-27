import { expect, test } from "bun:test";
import { compareSortValues, nextHeaderSort, type HeaderSortOptions, type SortPreference } from "./sort-values";

test("unavailable FX and nonfinite numeric values sort after valid values in both directions", () => {
  const values = [Number.NaN, 30, null, 10, Number.POSITIVE_INFINITY, 20];
  for (const direction of ["asc", "desc"] as const) {
    const sorted = [...values].sort((left, right) => compareSortValues(left, right, direction));
    expect(sorted.slice(0, 3)).toEqual(direction === "asc" ? [10, 20, 30] : [30, 20, 10]);
    expect(sorted.slice(3).every((value) => value == null || !Number.isFinite(value))).toBe(true);
  }
});

function clickHeaders(
  start: SortPreference<string>,
  columnIds: string[],
  options?: HeaderSortOptions<string>,
): SortPreference<string>[] {
  let current = start;
  return columnIds.map((columnId) => (current = nextHeaderSort(current, columnId, options)));
}

test("header clicks keep flipping a column after its own first direction", () => {
  const firstDirection = (columnId: string) => columnId === "name" ? "asc" : "desc";
  expect(clickHeaders({ columnId: null, direction: "asc" }, ["price", "price", "price", "name"], { firstDirection })).toEqual([
    { columnId: "price", direction: "desc" },
    { columnId: "price", direction: "asc" },
    { columnId: "price", direction: "desc" },
    { columnId: "name", direction: "asc" },
  ]);
});

test("a reset state takes the third click, whichever direction the column starts in", () => {
  const unsorted: SortPreference<string> = { columnId: null, direction: "asc" };
  expect(clickHeaders(unsorted, ["code", "code", "code"], { resetTo: unsorted })).toEqual([
    { columnId: "code", direction: "asc" },
    { columnId: "code", direction: "desc" },
    unsorted,
  ]);

  // Clicking the default column while it is the default flips it, then resets.
  const byDate: SortPreference<string> = { columnId: "date", direction: "desc" };
  expect(clickHeaders(byDate, ["amount", "amount", "amount", "date", "date"], { firstDirection: "desc", resetTo: byDate }))
    .toEqual([
      { columnId: "amount", direction: "desc" },
      { columnId: "amount", direction: "asc" },
      byDate,
      { columnId: "date", direction: "asc" },
      byDate,
    ]);
});
