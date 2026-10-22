import { describe, expect, test } from "bun:test";
import { markFromCloses } from "./session-history";

describe("markFromCloses", () => {
  test("uses the last print and the move from the first", () => {
    expect(markFromCloses([100, 110])).toEqual({ last: 110, changePercent: 10 });
  });

  test("has no move when the window holds one print", () => {
    expect(markFromCloses([104.5])).toEqual({ last: 104.5, changePercent: null });
  });

  test("skips a non-finite print and returns nothing when none remain", () => {
    expect(markFromCloses([Number.NaN, 50, 40])).toEqual({ last: 40, changePercent: -20 });
    expect(markFromCloses([Number.NaN])).toBeNull();
    expect(markFromCloses([])).toBeNull();
  });
});
