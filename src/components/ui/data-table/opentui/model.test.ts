import { describe, expect, test } from "bun:test";
import { tableColumnStarts } from "../../table-layout";
import { isDataTableColumnShown, resolveDataTableVisibleWindow, resolveDataTableWholeColumns } from "./model";

describe("OpenTUI data table model", () => {
  test("resolves the virtualized window with overscan around the scroll top", () => {
    const window = resolveDataTableVisibleWindow({
      appViewportHeight: 30,
      items: Array.from({ length: 20 }, (_, index) => index),
      measuredViewportHeight: 5,
      overscan: 2,
      scrollTop: 8,
      virtualize: true,
    });

    expect(window.startIndex).toBe(6);
    expect(window.endIndex).toBe(15);
    expect(window.viewportHeight).toBe(5);
    expect(window.visibleItems).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });

  test("uses all rows when virtualization is disabled", () => {
    const window = resolveDataTableVisibleWindow({
      appViewportHeight: 3,
      items: ["AAPL", "MSFT", "NVDA"],
      measuredViewportHeight: 1,
      overscan: 2,
      scrollTop: 20,
      virtualize: false,
    });

    expect(window).toEqual({
      startIndex: 0,
      endIndex: 3,
      viewportHeight: 3,
      visibleItems: ["AAPL", "MSFT", "NVDA"],
    });
  });

  test("draws only the columns the viewport shows whole, so a number is never cut to its first digits", () => {
    // CONTRACT 8, EXPIRY 10, LAST 7, SETTLE 7, CHG 6 with one-cell gaps and a one-cell inset.
    const widths = [8, 10, 7, 7, 6];
    const columnStarts = tableColumnStarts(widths.map((width) => ({ width })), 1);
    const whole = (scrollLeft: number, viewportWidth: number, frozenFirstColumn = false) => resolveDataTableWholeColumns({
      columnGap: 1, columnStarts, frozenFirstColumn, horizontalPadding: 1, scrollLeft, viewportWidth, widths,
    });
    // LAST ends at cell 28: a 28-cell pane shows it whole and leaves SETTLE and CHG blank, not "98".
    expect(whole(0, 28)).toEqual({ from: 0, to: 2 });
    expect(whole(0, 27)).toEqual({ from: 0, to: 1 });
    // Scrolled two cells, CONTRACT is cut on the left and blank; SETTLE now fits.
    expect(whole(2, 34)).toEqual({ from: 1, to: 3 });
    // A frozen first column stays, and what slides under it counts as cut.
    expect(whole(10, 33, true)).toEqual({ from: 2, to: 4 });
    expect(isDataTableColumnShown(whole(10, 33, true), 0, true)).toBe(true);
    expect(isDataTableColumnShown(whole(10, 33, true), 1, true)).toBe(false);
    // Everything fits, nothing is measured yet, or no column fits whole: every column draws as before.
    expect(whole(0, 44)).toBeNull();
    expect(whole(0, 0)).toBeNull();
    expect(whole(0, 5)).toBeNull();
    expect(isDataTableColumnShown(null, 4, false)).toBe(true);
  });
});
