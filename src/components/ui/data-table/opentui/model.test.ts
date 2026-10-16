import { describe, expect, test } from "bun:test";
import { fitTableCellText, fitTableHeaderText, tableColumnStarts } from "../../table-layout";
import { cutColumnText, resolveDataTableColumnClips, resolveDataTableVisibleWindow, reuseDataTableColumnClips } from "./model";

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

  test("clips say where the viewport cuts each column", () => {
    // CONTRACT 8 (text), EXPIRY 10 (text), LAST 7, SETTLE 7, CHG 6 (numbers) with one-cell gaps and a one-cell inset.
    const widths = [8, 10, 7, 7, 6];
    const columnStarts = tableColumnStarts(widths.map((width) => ({ width })), 1);
    const clips = (scrollLeft: number, viewportWidth: number, frozenFirstColumn = false) => resolveDataTableColumnClips({
      columnGap: 1, columnStarts, frozenFirstColumn, horizontalPadding: 1, scrollLeft, viewportWidth, widths,
    });
    // A 26-cell pane cuts LAST after its first five cells; SETTLE and CHG are wholly out of view.
    expect(clips(0, 26)).toEqual([null, null, { inset: 0, width: 5 }, { inset: 0, width: 0 }, { inset: 0, width: 0 }]);
    // Scrolled four cells, CONTRACT shows its last five cells.
    expect(clips(4, 40)).toEqual([{ inset: 3, width: 5 }, null, null, null, null]);
    // A frozen first column stays, and EXPIRY sliding under it is cut on the left.
    expect(clips(4, 40, true)).toEqual([null, { inset: 4, width: 6 }, null, null, null]);
    // A pane narrower than any column still cuts them.
    expect(clips(0, 5)).toEqual([{ inset: 0, width: 4 }, { inset: 0, width: 0 }, { inset: 0, width: 0 }, { inset: 0, width: 0 }, { inset: 0, width: 0 }]);
    // Everything fits, or nothing is measured yet: every column draws as before.
    expect(clips(0, 44)).toBeNull();
    expect(clips(0, 0)).toBeNull();
  });

  test("a cut number shows only while the cells in view hold all of it; cut text is fitted to them", () => {
    const cell = (text: string, align: string, width: number, clip: { inset: number; width: number }) => (
      cutColumnText(text, align, width, clip, (value, shown) => fitTableCellText(value, shown, align))
    );
    // 98.53 sits in the last five cells of a twelve-cell column. Two cells hidden on the left leave it whole.
    expect(cell("98.53", "right", 12, { inset: 2, width: 10 })).toBe("     98.53");
    // Hidden further, or cut on the right, part of it would read as another number.
    expect(cell("98.53", "right", 12, { inset: 8, width: 4 })).toBe("    ");
    expect(cell("98.53", "right", 12, { inset: 0, width: 9 })).toBe("         ");
    // A centred value is judged by where it sits.
    expect(cell("OK", "center", 10, { inset: 0, width: 6 })).toBe("    OK");
    expect(cell("OK", "center", 10, { inset: 0, width: 5 })).toBe("     ");
    // Text starts at the visible edge, with an ellipsis when it is longer.
    expect(cell("Definitive agreement", "left", 22, { inset: 4, width: 12 })).toBe("Definitive\u2026 ");
    expect(cell("anything", "right", 12, { inset: 12, width: 0 })).toBe("");
  });

  test("a cut header keeps its label's trailing blank unless the edge is that cell", () => {
    const header = (text: string, align: string, width: number, clip: { inset: number; width: number }) => (
      cutColumnText(text, align, width, clip, (value, shown, cutRight) => fitTableHeaderText(value, shown, align, !cutRight))
    );
    expect(header("LAST", "right", 12, { inset: 2, width: 10 })).toBe("     LAST ");
    expect(header("LAST", "right", 12, { inset: 9, width: 3 })).toBe("   ");
    // Text cut only on the left keeps the blank that separates it from the next label.
    expect(header("EXPIRY", "left", 10, { inset: 3, width: 7 })).toBe("EXPIRY ");
    expect(header("EXPIRY", "left", 10, { inset: 0, width: 6 })).toBe("EXPIRY");
  });

  test("clips that say the same as the last ones keep the last array", () => {
    const previous = [null, { inset: 2, width: 10 }];
    expect(reuseDataTableColumnClips(previous, [null, { inset: 2, width: 10 }])).toBe(previous);
    const moved = [null, { inset: 3, width: 9 }];
    expect(reuseDataTableColumnClips(previous, moved)).toBe(moved);
    expect(reuseDataTableColumnClips(previous, null)).toBeNull();
  });
});
