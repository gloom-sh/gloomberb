import { describe, expect, test } from "bun:test";
import { fitTableCellText, fitTableHeaderText, tableColumnStarts } from "../../table-layout";
import { cutColumnText, fitColumnCellText, resolveDataTableColumnClips, resolveMoreColumnsHint, resolveDataTableVisibleWindow, reuseDataTableColumnClips } from "./model";

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

  test("a viewport not laid out yet keeps the default window, so a render before the first layout does not shrink it to a row", () => {
    const items = Array.from({ length: 60 }, (_, index) => index);
    const unmeasured = resolveDataTableVisibleWindow({ appViewportHeight: 40, items, measuredViewportHeight: undefined, overscan: 3, scrollTop: 0, virtualize: true });
    const notLaidOut = resolveDataTableVisibleWindow({ appViewportHeight: 40, items, measuredViewportHeight: 0, overscan: 3, scrollTop: 0, virtualize: true });
    expect(notLaidOut.endIndex).toBe(unmeasured.endIndex);
    expect(notLaidOut.endIndex).toBe(22);
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

  test("\"more →\" shows while a column past the right edge shows nothing, in the longest form that fits beside the columns shown", () => {
    // NAME 10 (text), LAST 12 and CHG 10 (figures) with one-cell gaps and a one-cell inset: 1-10, 12-23, 25-34.
    const figures = [
      { width: 10, align: "left", label: "NAME" },
      { width: 12, align: "right", label: "LAST" },
      { width: 10, align: "right", label: "CHG" },
    ];
    const hint = (viewportWidth: number, { scrollLeft = 0, besideHeader = 0, columns = figures } = {}) => resolveMoreColumnsHint({
      columns, columnGap: 1, columnStarts: tableColumnStarts(columns, 1), besideHeader, horizontalPadding: 1, scrollLeft, viewportWidth,
    });
    // CHG is cut, so blank: "more →" follows LAST after a blank, and the rows are blank from that blank on.
    expect(hint(31)).toEqual({ text: " more →", left: 24, reserve: 7 });
    // The blank can be LAST's own: a label shorter than its column keeps one at its end.
    expect(hint(30)).toEqual({ text: " more →", left: 23, reserve: 6 });
    // Narrower, the shorter forms keep LAST whole.
    expect(hint(29)).toEqual({ text: " more", left: 24, reserve: 5 });
    expect(hint(28)).toEqual({ text: " more", left: 23, reserve: 4 });
    expect(hint(27)).toEqual({ text: " →", left: 25, reserve: 2 });
    expect(hint(25)).toEqual({ text: " →", left: 23, reserve: 1 });
    // The header's cell over the body's vertical scrollbar is room for it too.
    expect(hint(27, { besideHeader: 1 })).toEqual({ text: " more", left: 23, reserve: 3 });
    // LAST against the edge: the arrow takes its label's trailing blank and the rows keep every figure.
    expect(hint(24)).toEqual({ text: "→", left: 23, reserve: 0 });
    // A label that fills its column against the edge has no blank to give: no hint rather than a hidden column.
    const full = [figures[0]!, { width: 4, align: "right", label: "LAST" }, figures[2]!];
    expect(hint(16, { columns: full })).toBeNull();
    expect(hint(22)).toEqual({ text: " more →", left: 15, reserve: 7 });
    // Scrolled to the end, too narrow for a column beside the hint, or not measured: no hint.
    expect(hint(31, { scrollLeft: 4 })).toBeNull();
    expect(hint(13)).toBeNull();
    expect(hint(0)).toBeNull();
    // Text cut on the right counts as out of view only while it shows less than its label; then it ends in an ellipsis.
    const text = [{ width: 10, align: "left", label: "NAME" }, { width: 16, align: "left", label: "STAGE" }];
    expect(hint(16, { columns: text })?.text).toBe(" more");
    expect(hint(17, { columns: text })).toBeNull();
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

  test("a cell note fits whole beside its label, otherwise the label keeps its room and ellipsis", () => {
    const note = "front NGX26 3.116";
    expect(fitColumnCellText("NGF27", 24, "left", null, note)).toEqual({ text: "NGF27 ", note, padding: " " });
    expect(fitColumnCellText("NGF27", 23, "left", null, note)).toEqual({ text: "NGF27 ", note, padding: "" });
    expect(fitColumnCellText("NGF27", 22, "left", null, note)).toEqual({ text: "NGF27                 " });
    expect(fitColumnCellText("NGF27", 4, "left", null, note)).toEqual({ text: "NGF…" });
    expect(fitColumnCellText("NGF27", 23, "left", null)).toEqual({ text: fitTableCellText("NGF27", 23, "left") });
    // Terminal cells, not UTF-16 length: the two ideographs occupy four cells.
    expect(fitColumnCellText("天然", 22, "left", null, note)).toEqual({ text: "天然 ", note, padding: "" });
    expect(fitColumnCellText("天然", 21, "left", null, note).note).toBeUndefined();
  });

  test("a note is hidden when the viewport cuts any of it, including an aligned cell's placement", () => {
    const note = "front NGX26 3.116";
    expect(fitColumnCellText("NGF27", 30, "left", { inset: 0, width: 23 }, note).note).toBe(note);
    expect(fitColumnCellText("NGF27", 30, "left", { inset: 0, width: 22 }, note).note).toBeUndefined();
    // The combined value fits 23 cells, but its right-aligned position ends outside them.
    expect(fitColumnCellText("NGF27", 30, "right", { inset: 0, width: 23 }, note)).toEqual({ text: " ".repeat(23) });
    expect(fitColumnCellText("NGF27", 30, "right", { inset: 7, width: 23 }, note)).toEqual({ text: "NGF27 ", note, padding: "" });
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
