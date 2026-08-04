import { describe, expect, test } from "bun:test";
import { resolveDataTableVisibleRange } from "./visible-range";

describe("data table visible range", () => {
  test("includes partially visible desktop rows without counting the sticky header", () => {
    expect(resolveDataTableVisibleRange({
      itemCount: 100,
      rowSize: 20,
      scrollOffset: 10,
      viewportSize: 180,
    })).toEqual({ start: 0, end: 10 });

    expect(resolveDataTableVisibleRange({
      itemCount: 100,
      rowSize: 20,
      scrollOffset: 30,
      viewportSize: 180,
    })).toEqual({ start: 1, end: 11 });
  });

  test("clamps a terminal range to the available rows", () => {
    expect(resolveDataTableVisibleRange({
      itemCount: 8,
      rowSize: 1,
      scrollOffset: 6,
      viewportSize: 5,
    })).toEqual({ start: 6, end: 8 });
  });
});
