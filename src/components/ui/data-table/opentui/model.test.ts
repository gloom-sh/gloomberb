import { describe, expect, test } from "bun:test";
import {
  dataTableTopRow,
  resolveDataTableScrollTop,
  resolveDataTableVisibleWindow,
} from "./model";

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

  test("a taller row halves the rows that fit and the rows scrolled past", () => {
    // The scroll box reports cells. At two cells per row, a scroll offset of 8
    // has passed 4 rows, not 8, and a 6-cell viewport shows 3 rows, not 6.
    const window = resolveDataTableVisibleWindow({
      appViewportHeight: 30,
      items: Array.from({ length: 20 }, (_, index) => index),
      measuredViewportHeight: 6,
      overscan: 1,
      scrollTop: 8,
      virtualize: true,
      rowHeight: 2,
    });

    expect(window.viewportHeight).toBe(3);
    expect(window.startIndex).toBe(3);
    expect(window.endIndex).toBe(8);
  });

  test("row height of one keeps the old cell-equals-row behaviour", () => {
    const taller = resolveDataTableVisibleWindow({
      appViewportHeight: 30,
      items: Array.from({ length: 20 }, (_, index) => index),
      measuredViewportHeight: 5,
      overscan: 2,
      scrollTop: 8,
      virtualize: true,
      rowHeight: 1,
    });
    const implicit = resolveDataTableVisibleWindow({
      appViewportHeight: 30,
      items: Array.from({ length: 20 }, (_, index) => index),
      measuredViewportHeight: 5,
      overscan: 2,
      scrollTop: 8,
      virtualize: true,
    });
    expect(taller).toEqual(implicit);
  });

  test("converts a cell offset to a row index", () => {
    expect(dataTableTopRow(0, 2)).toBe(0);
    expect(dataTableTopRow(1, 2)).toBe(0);
    expect(dataTableTopRow(2, 2)).toBe(1);
    expect(dataTableTopRow(9, 2)).toBe(4);
    expect(dataTableTopRow(-5, 2)).toBe(0);
    expect(dataTableTopRow(7, 0)).toBe(7);
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

  test("scrolls the target index into view without exceeding bounds", () => {
    expect(resolveDataTableScrollTop(12, 0, 5, 20, "nearest")).toBe(8);
    expect(resolveDataTableScrollTop(1, 8, 5, 20, "nearest")).toBe(1);
    expect(resolveDataTableScrollTop(18, 0, 5, 20, "center")).toBe(15);
  });
});
