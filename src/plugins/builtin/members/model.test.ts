import { expect, test } from "bun:test";
import { fitTableCellText, getTableWidth, tableColumnWidth } from "../../../components/ui/table-layout";
import { changeColumns, changeReason, memberColumns, memberRows, percent, sortMembers } from "./model";
import { changes, member } from "./test-fixture";
test("sorting keeps gaps last in either direction and movers separate positive and negative contributions", () => {
  const rows = [member("A", null), member("B", -4), member("C", 2), member("D", 0)];
  expect(sortMembers(rows, { columnId: "changePercent", direction: "desc" }).map((row) => row.id)).toEqual(["C", "D", "B", "A"]);
  expect(sortMembers(rows, { columnId: "changePercent", direction: "asc" }).map((row) => row.id)).toEqual(["B", "D", "C", "A"]);
  expect(memberRows(rows, "movers", "", { columnId: "weight", direction: "desc" }).map((row) => row.key)).toEqual(["section:Contributors", "C", "section:Detractors", "B"]);
  expect(rows[0]?.id).toBe("A");
});
test("narrow columns retain weight and daily move; missing observations do not shift numeric edges", () => {
  for (const width of [39, 55, 90, 165, 250]) for (const movers of [false, true]) {
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
test("narrow changes preserve the countdown and both actions without overflowing", () => {
  for (const width of [39, 48, 55, 90, 165]) {
    const columns = changeColumns(width);
    expect(getTableWidth(columns)).toBeLessThanOrEqual(width);
    for (const id of ["effectiveDate", "daysToGo", "added", "removed"]) expect(columns.some((column) => column.id === id)).toBe(true);
  }
});
test("parsed actions shorten repeated release headlines while unknown changes retain them", () => {
  const headline = "Vylor Added to the S&P 500; Twilio Set to Join S&P 500; Others to Join S&P MidCap 400 and S&P SmallCap 600";
  const row = { ...changes.changes[0]!, headline, reason: headline, added: "VYLR", removed: null };
  expect(changeReason(row)).toBe("Index addition");
  expect(changeReason({ ...row, added: null, removed: "CTVA" })).toBe("Index deletion");
  expect(changeReason({ ...row, added: null })).toBe(headline);
  expect(changeReason({ ...row, reason: "Market capitalization changes." })).toBe("Market capitalization changes.");
});
