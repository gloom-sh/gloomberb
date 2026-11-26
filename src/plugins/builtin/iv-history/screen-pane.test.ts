import { expect, test } from "bun:test";
import { fitDataTableColumns } from "../../../components/ui/data-table/column-fit";
import { VCA_COLUMN_DROP_ORDER, VCA_COLUMNS } from "./screen-pane";

test("a screen sorted by HV20 keeps the figure beside the date it was observed on, at every desktop width", () => {
  // Realized volatility observed on another day than the IV: the pane draws HV's own date beside it.
  const columns = VCA_COLUMNS.filter((column) => column.id !== "skewDate");
  const drawn = (cells: number, sortColumnId: string) => fitDataTableColumns(columns, cells, { anchoredColumns: 1, sortColumnId, dropOrder: VCA_COLUMN_DROP_ORDER });
  const ids = (shown: readonly { id: string }[]) => shown.map((column) => column.id).join(" ");

  // The sorted column kept alone left a figure dated by the IV's "As of", a day it was not observed on.
  expect(ids(drawn(60, "hv"))).toBe("symbol iv30 date hv hvDate ivHv");
  expect(ids(drawn(40, "hv"))).toBe("symbol hv hvDate ivHv");
  // Too narrow for those three beside the symbol: every column, in a table that scrolls sideways.
  expect(drawn(30, "hv")).toBe(columns);

  for (let cells = 20; cells <= 160; cells += 1) {
    for (const sort of ["hv", "percentile"]) {
      const shown = new Set(drawn(cells, sort).map((column) => column.id));
      expect(shown.has("symbol")).toBe(true);
      expect(shown.has(sort)).toBe(true);
      expect(`${cells} ${sort} ${shown.has("hvDate")}`).toBe(`${cells} ${sort} ${shown.has("hv")}`);
    }
  }
});
