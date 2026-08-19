import { describe, expect, test } from "bun:test";
import {
  buildTableGridTemplateColumns,
  fitTableCellText,
  fitTableHeaderText,
  getTableWidth,
  hasMeaningfulTableHorizontalOverflow,
  tableColumnWidth,
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

  test("marks clipped cells so a cut number cannot read as a smaller value", () => {
    expect(fitTableCellText("2026-08-17", 9, "right")).toBe("2026-0...");
    expect(fitTableCellText("globenewswire", 10)).toBe("globene...");
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
      "minmax(calc(4 * var(--cell-w)), calc(4 * var(--cell-w))) minmax(calc(14 * var(--cell-w)), 40fr) minmax(calc(8 * var(--cell-w)), calc(24 * var(--cell-w))) minmax(calc(5 * var(--cell-w)), calc(5 * var(--cell-w)))",
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
