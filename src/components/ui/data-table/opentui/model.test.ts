import { describe, expect, test } from "bun:test";
import { tableColumnStarts } from "../../table-layout";
import { resolveDataTableColumnClips, resolveDataTableVisibleWindow } from "./model";

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

  test("a number the viewport cuts is left blank, and cut text is fitted to what shows", () => {
    // CONTRACT 8 (text), EXPIRY 10 (text), LAST 7, SETTLE 7, CHG 6 (numbers) with one-cell gaps and a one-cell inset.
    const widths = [8, 10, 7, 7, 6];
    const aligns = ["left", "left", "right", "right", "right"];
    const columnStarts = tableColumnStarts(widths.map((width) => ({ width })), 1);
    const clips = (scrollLeft: number, viewportWidth: number, frozenFirstColumn = false) => resolveDataTableColumnClips({
      aligns, columnGap: 1, columnStarts, frozenFirstColumn, horizontalPadding: 1, scrollLeft, viewportWidth, widths,
    });
    const blank = { kind: "blank" };
    // LAST ends at cell 28: a 26-cell pane would show "98" of 98.53, so LAST is blank; so is SETTLE, wholly out of view.
    expect(clips(0, 26)).toEqual([null, null, blank, blank, blank]);
    // EXPIRY cut after six of its ten cells shows its date fitted to them, with an ellipsis.
    expect(clips(0, 16)).toEqual([null, { kind: "fit", inset: 0, width: 6 }, blank, blank, blank]);
    // Scrolled four cells, CONTRACT shows its last five cells; the text starts there.
    expect(clips(4, 40)).toEqual([{ kind: "fit", inset: 3, width: 5 }, null, null, null, null]);
    // A frozen first column stays, and EXPIRY sliding under it is cut on the left.
    expect(clips(4, 40, true)).toEqual([null, { kind: "fit", inset: 4, width: 6 }, null, null, null]);
    // Everything fits, nothing is measured yet, or no column fits whole: every column draws as before.
    expect(clips(0, 44)).toBeNull();
    expect(clips(0, 0)).toBeNull();
    expect(clips(0, 5)).toBeNull();
  });
});
