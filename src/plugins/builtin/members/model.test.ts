import { expect, test } from "bun:test";
import { fitTableCellText, getTableWidth, tableColumnWidth } from "../../../components/ui/table-layout";
import { memberColumns, memberRows, percent, sortMembers } from "./model";
import { member } from "./test-fixture";
test("sorting keeps gaps last in either direction and movers separate positive and negative contributions", () => {
  const rows = [member("A", null), member("B", -4), member("C", 2), member("D", 0)];
  expect(sortMembers(rows, { columnId: "changePercent", direction: "desc" }).map((row) => row.id)).toEqual(["C", "D", "B", "A"]);
  expect(sortMembers(rows, { columnId: "changePercent", direction: "asc" }).map((row) => row.id)).toEqual(["B", "D", "C", "A"]);
  expect(memberRows(rows, "movers", "", { columnId: "weight", direction: "desc" }).map((row) => row.key)).toEqual(["section:Contributors", "C", "section:Detractors", "B"]);
  expect(rows[0]?.id).toBe("A");
});
test("narrow columns retain weight and daily move; missing observations do not shift numeric edges", () => {
  for (const width of [55, 90, 165, 250]) for (const movers of [false, true]) {
    const columns = memberColumns(width, movers);
    expect(getTableWidth(columns)).toBeLessThanOrEqual(width);
    expect(columns.map((col) => col.id)).toContain("weight");
    expect(columns.map((col) => col.id)).toContain("changePercent");
    if (movers) expect(columns.map((col) => col.id)).toContain("contribution");
    const col = columns.find((col) => col.id === "changePercent")!;
    const edge = fitTableCellText(col.label, tableColumnWidth(col), "right").trimEnd().length;
    for (const value of [1.23, -0.27, null]) {
      expect(fitTableCellText(percent(value), tableColumnWidth(col), "right").trimEnd().length).toBe(edge);
    }
  }
});
