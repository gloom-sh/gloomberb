import { expect, test } from "bun:test";
import { compareSortValues } from "./sort-values";

test("unavailable FX and nonfinite numeric values sort after valid values in both directions", () => {
  const values = [Number.NaN, 30, null, 10, Number.POSITIVE_INFINITY, 20];
  for (const direction of ["asc", "desc"] as const) {
    const sorted = [...values].sort((left, right) => compareSortValues(left, right, direction));
    expect(sorted.slice(0, 3)).toEqual(direction === "asc" ? [10, 20, 30] : [30, 20, 10]);
    expect(sorted.slice(3).every((value) => value == null || !Number.isFinite(value))).toBe(true);
  }
});
