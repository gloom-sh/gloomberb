import { describe, expect, test } from "bun:test";
import { resolveDataTableScrollTop, resolveDataTableVisibleRange } from "./visible-range";

describe("data table visible range", () => {
  test("includes partially visible desktop rows without counting the sticky header, and says which are whole", () => {
    expect(resolveDataTableVisibleRange({
      itemCount: 100,
      rowSize: 20,
      scrollOffset: 10,
      viewportSize: 180,
    })).toEqual({ start: 0, end: 10, wholeStart: 1, wholeEnd: 9 });

    expect(resolveDataTableVisibleRange({
      itemCount: 100,
      rowSize: 20,
      scrollOffset: 30,
      viewportSize: 180,
    })).toEqual({ start: 1, end: 11, wholeStart: 2, wholeEnd: 10 });

    // Subpixel layout a fraction of a pixel short of a row still shows it whole.
    expect(resolveDataTableVisibleRange({
      itemCount: 100,
      rowSize: 18,
      scrollOffset: 0,
      viewportSize: 18 * 35 - 0.4,
    })).toEqual({ start: 0, end: 35 });
  });

  test("clamps a terminal range to the available rows", () => {
    expect(resolveDataTableVisibleRange({
      itemCount: 8,
      rowSize: 1,
      scrollOffset: 6,
      viewportSize: 5,
    })).toEqual({ start: 6, end: 8 });
  });

  test("widens the range by the buffer without leaving the rows", () => {
    expect(resolveDataTableVisibleRange({
      itemCount: 12,
      rowSize: 1,
      scrollOffset: 2,
      viewportSize: 8,
      buffer: 3,
    })).toEqual({ start: 0, end: 12, wholeStart: 2, wholeEnd: 10 });
  });

  test("scrolls the target index into view without exceeding bounds", () => {
    expect(resolveDataTableScrollTop(12, 0, 5, 20, "nearest")).toBe(8);
    expect(resolveDataTableScrollTop(1, 8, 5, 20, "nearest")).toBe(1);
    expect(resolveDataTableScrollTop(18, 0, 5, 20, "center")).toBe(15);
  });

  test("brings the rows from fromIndex in above the target, as many as fit with the target on screen", () => {
    expect(resolveDataTableScrollTop(6, 5, 5, 20, "nearest", 4)).toBe(4);
    expect(resolveDataTableScrollTop(6, 9, 5, 20, "start", 4)).toBe(4);
    // More rows than fit: the target goes to the bottom edge rather than out of view.
    expect(resolveDataTableScrollTop(12, 12, 5, 20, "nearest", 3)).toBe(8);
    // Already in view, or moving down to the bottom edge: nothing changes.
    expect(resolveDataTableScrollTop(6, 4, 5, 20, "nearest", 4)).toBe(4);
    expect(resolveDataTableScrollTop(12, 0, 5, 20, "nearest", 10)).toBe(8);
    expect(resolveDataTableScrollTop(18, 0, 5, 20, "center", 10)).toBe(15);
  });
});
