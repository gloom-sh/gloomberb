import { describe, expect, test } from "bun:test";
import {
  buildTableGridTemplateColumns,
  dropColumnsToFit,
  fitTableCellText,
  fitTableColumns,
  fitTableHeaderText,
  getTableWidth,
  hasMeaningfulTableHorizontalOverflow,
  tableColumnStarts,
  tableColumnWidth,
  tableRevealLeft,
} from "./table-layout";

describe("table layout", () => {
  test("detects only meaningful horizontal table overflow", () => {
    const tableWidth = getTableWidth([
      { width: 12 },
      { width: 8 },
    ]);

    expect(hasMeaningfulTableHorizontalOverflow(tableWidth, 0)).toBe(false);
    expect(hasMeaningfulTableHorizontalOverflow(tableWidth, tableWidth)).toBe(false);
    expect(hasMeaningfulTableHorizontalOverflow(tableWidth, tableWidth - 1)).toBe(false);
    expect(hasMeaningfulTableHorizontalOverflow(tableWidth, tableWidth - 2)).toBe(true);
  });

  test("supports tables without inter-column gaps", () => {
    const tableWidth = getTableWidth([
      { width: 12 },
      { width: 8 },
    ], 0);
    const noPaddingWidth = getTableWidth([
      { width: 12 },
      { width: 8 },
    ], 0, 0);

    expect(tableWidth).toBe(22);
    expect(noPaddingWidth).toBe(20);
    expect(hasMeaningfulTableHorizontalOverflow(tableWidth, tableWidth, 0)).toBe(false);
    expect(hasMeaningfulTableHorizontalOverflow(tableWidth, tableWidth - 1, 0)).toBe(true);
  });

  test("widens a column that cannot fit its own header plus the sort indicator", () => {
    expect(tableColumnWidth({ width: 4, label: "Time" })).toBe(6);
    expect(tableColumnWidth({ width: 4, label: "AS OF" })).toBe(7);
    expect(tableColumnWidth({ width: 12, label: "SECTOR" })).toBe(12);
    expect(getTableWidth([{ width: 2, label: "OI" }, { width: 4, label: "ENDS" }], 1, 0)).toBe(12);
  });

  test("budgets an extra gap where a right-aligned column meets a left-aligned one", () => {
    const columns = [
      { width: 4, align: "right" },
      { width: 6, align: "left" },
      { width: 3 },
      { width: 5, align: "right" },
      { width: 5, align: "right" },
    ];
    // Only the right-to-left seam gets the extra cell; right-to-right does not.
    expect(getTableWidth(columns, 1, 0)).toBe(4 + 1 + 1 + 6 + 1 + 3 + 1 + 5 + 1 + 5 + 1);
    expect(tableColumnStarts(columns, 1)).toEqual([0, 6, 13, 17, 23]);
    // Tables packed without gaps stay packed.
    expect(getTableWidth(columns, 0, 0)).toBe(23);
  });

  test("drops columns in order until the rest fit, an entry with several ids all at once", () => {
    const columns = ["a", "b", "c", "d", "e"].map((id) => ({ id, width: 8, align: "right" }));
    const ids = (width: number, order: Parameters<typeof dropColumnsToFit>[2]) =>
      dropColumnsToFit(columns, width, order).map((column) => column.id).join("");
    const fits = (count: number) => getTableWidth(columns.slice(0, count));

    expect(ids(fits(5), ["a", "b"])).toBe("abcde");
    expect(ids(fits(4), ["a", "b"])).toBe("bcde");
    expect(ids(fits(3), ["a", "b", "c"])).toBe("cde");
    // A pair leaves together, even when dropping the first alone would have fit.
    expect(ids(fits(4), [["a", "b"], "c"])).toBe("cde");
    // Columns not in the order stay, so the table can still overflow.
    expect(ids(fits(1), ["a"])).toBe("bcde");
  });

  test("a terminal table gives up the blank past its text before it cuts a name or pushes a column past the edge", () => {
    const widths = (columns: { width: number }[]) => columns.map((column) => column.width);
    const hint = { least: 3, whole: 8 };
    // A watchlist: TICKER 12, LAST 9, CHG% 8, MCAP 12, VOL 10, each holding less than it is set to.
    const board = [
      { id: "ticker", label: "TICKER", width: 12 },
      { id: "last", label: "LAST", width: 9, align: "right" },
      { id: "change", label: "CHG%", width: 8, align: "right" },
      { id: "cap", label: "MCAP", width: 12, align: "right" },
      { id: "volume", label: "VOL", width: 10, align: "right" },
    ];
    const held = [6, 6, 6, 5, 6];
    // Wide enough for every column as set: as the pane set them.
    expect(widths(fitTableColumns(board, held, getTableWidth(board), 1, 1, hint))).toEqual([12, 9, 8, 12, 10]);
    // 36 cells held TICKER, LAST and CHG% as set. Down to their text and headers MCAP shows too, beside "⇧→";
    // the three cells left go back to the first columns (too few for "more ⇧→") and VOL waits past the edge.
    const narrow = fitTableColumns(board, held, 36, 1, 1, hint);
    expect(widths(narrow)).toEqual([9, 7, 7, 6, 6]);
    expect(tableColumnStarts(narrow)[3]! + 1 + 6 + hint.least).toBe(36);
    // All five fit at 45, what is left given back a cell at a time from the left.
    expect(widths(fitTableColumns(board, held, 45, 1, 1, hint))).toEqual([10, 7, 7, 7, 7]);

    // A name cut while the figures beside it hold blank takes that blank first.
    const movers = [
      { id: "symbol", label: "TICKER", width: 10 },
      { id: "name", label: "NAME", width: 6 },
      { id: "last", label: "LAST", width: 10, align: "right" },
      { id: "change", label: "CHG%", width: 8, align: "right" },
    ];
    expect(widths(fitTableColumns(movers, [4, 30, 6, 7], 38, 1, 1, hint))).toEqual([8, 11, 6, 7]);
    // A drawn cell that gives no width (null) keeps its column as set, and the name gets less.
    expect(widths(fitTableColumns(movers, [null, 30, 6, 7], 38, 1, 1, hint))).toEqual([10, 9, 6, 7]);
    // An empty table is as wide as its headers, so it never says there are more columns.
    expect(getTableWidth(fitTableColumns(board, [0, 0, 0, 0, 0], 40, 1, 1, hint))).toBeLessThanOrEqual(40);
  });

  test("a last text column the hint's whole form would leave a few cells of is pushed out by the shown columns", () => {
    // The volatility board at 34 cells: INDEX, LEVEL, 1D % and AS OF, which cannot show whole.
    const columns = [
      { id: "id", label: "INDEX", width: 8 },
      { id: "value", label: "LEVEL", width: 9, align: "right" },
      { id: "change", label: "1D %", width: 9, align: "right" },
      { id: "date", label: "AS OF", width: 12 },
    ];
    const fitted = fitTableColumns(columns, [5, 6, 6, 10], 34, 1, 1, { least: 3, whole: 8 });
    expect(fitted.map((column) => column.width)).toEqual([8, 9, 9, 10]);
    // AS OF starts three cells from the edge: fewer than its label, so the rows leave them blank beside "⇧→".
    expect(34 - tableColumnStarts(fitted)[3]! - 1).toBeLessThan("AS OF".length);
  });

  test("scrolls a wide table to centre one column, stopping at a column edge past a frozen first column", () => {
    // A tenor column and nine moneyness columns, ATM the sixth, in a 40-cell pane.
    const columns = [{ id: "tenor", width: 10 }, ...Array.from({ length: 9 }, (_, index) => ({ id: String(index), width: 7 }))];
    const shared = { columns, columnIndex: 5, viewportWidth: 40, maxLeft: 44 };
    expect(tableRevealLeft({ ...shared, frozenFirstColumn: true })).toBe(24);
    expect(tableRevealLeft(shared)).toBe(28);
    // Past the right end it stops at the last scroll position; a table that fits does not move.
    expect(tableRevealLeft({ ...shared, columnIndex: 9 })).toBe(44);
    expect(tableRevealLeft({ ...shared, maxLeft: 0 })).toBe(0);
  });

  test("marks clipped cells so a cut number cannot read as a smaller value", () => {
    expect(fitTableCellText("2026-08-17", 9, "right")).toBe("2026-08-\u2026");
    expect(fitTableCellText("globenewswire", 10)).toBe("globenews\u2026");
    expect(fitTableCellText("12.5", 6, "right")).toBe("  12.5");
  });

  test("keeps a blank cell between adjacent headers without shortening a label", () => {
    expect(fitTableHeaderText("OI", 4, "right")).toBe(" OI ");
    expect(fitTableHeaderText("ENDS", 6, "left")).toBe("ENDS  ");
    // A header that already fills its column keeps every character.
    expect(fitTableHeaderText("WEIGHT \u25bc", 8, "right")).toBe("WEIGHT \u25bc");
    expect(fitTableHeaderText("ALLOCATION", 10, "left", false)).toBe("ALLOCATION");
  });

  test("keeps non-flex web table columns fixed", () => {
    const template = buildTableGridTemplateColumns([
      { width: 4, align: "right" },
      { width: 40, flexGrow: 1 },
      { width: 24 },
      { width: 5, align: "right" },
    ]);

    expect(template).toBe(
      // The flexible column follows a right-aligned one, so its track carries the extra gap cell.
      "minmax(calc(4 * var(--cell-w)), calc(4 * var(--cell-w))) minmax(calc(15 * var(--cell-w)), 41fr) minmax(calc(8 * var(--cell-w)), calc(24 * var(--cell-w))) minmax(calc(5 * var(--cell-w)), calc(5 * var(--cell-w)))",
    );
  });

  test("keeps proportional web table columns when no column is flexible", () => {
    const template = buildTableGridTemplateColumns([
      { width: 12 },
      { width: 8, align: "right" },
    ]);

    expect(template).toBe("minmax(calc(8 * var(--cell-w)), 12fr) minmax(calc(8 * var(--cell-w)), 8fr)");
  });

  test("keeps fixed web table columns when fill width is disabled", () => {
    const template = buildTableGridTemplateColumns([
      { width: 12 },
      { width: 8, align: "right" },
    ], false);

    expect(template).toBe("minmax(calc(8 * var(--cell-w)), calc(12 * var(--cell-w))) minmax(calc(8 * var(--cell-w)), calc(8 * var(--cell-w)))");
  });
});
