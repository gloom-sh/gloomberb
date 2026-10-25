import { expect, test } from "bun:test";
import { fitTableCellText, getTableWidth, tableColumnWidth } from "../../../components/ui/table-layout";
import { changeColumns, changeReason, memberColumns, memberRows, membersFeed, percent, sortMembers } from "./model";
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

test("a Pro account's members are live only while the regular session trades, and the close it ended at otherwise", () => {
  const feed = (access: "realtime" | "delayed" | undefined, at: string) => membersFeed(access, Date.parse(at));
  const close = (date: string, label: string) => ({ kind: "close" as const, date, label, closedAt: expect.any(Number) });
  expect(feed("realtime", "2026-10-23T15:00:00Z")).toEqual({ kind: "live" });
  expect(feed("realtime", "2026-10-23T19:59:00Z")).toEqual({ kind: "live" });
  // The close, the evening after it, a Saturday, and before Monday's open.
  for (const at of ["2026-10-23T20:00:00Z", "2026-10-24T01:00:00Z", "2026-10-24T14:00:00Z", "2026-10-26T13:29:00Z"]) expect(feed("realtime", at)).toEqual(close("2026-10-23", "Fri 23 Oct close"));
  expect(feed("realtime", "2026-10-26T13:30:00Z")).toEqual({ kind: "live" });
  // Thanksgiving is a holiday, so Wednesday's close stands; the day after trades until its 13:00 early close.
  expect(feed("realtime", "2026-11-26T15:00:00Z")).toEqual(close("2026-11-25", "Wed 25 Nov close"));
  expect(feed("realtime", "2026-11-27T17:30:00Z")).toEqual({ kind: "live" });
  expect(feed("realtime", "2026-11-27T18:00:00Z")).toEqual({ ...close("2026-11-27", "Fri 27 Nov close"), closedAt: Date.parse("2026-11-27T18:00:00Z") });
  // A delayed account's, and an older server's, are 15 minutes behind whatever the clock says.
  expect(feed("delayed", "2026-10-24T14:00:00Z")).toEqual({ kind: "delayed" });
  expect(feed(undefined, "2026-10-23T15:00:00Z")).toEqual({ kind: "delayed" });
});

test("a move that rounds to zero prints unsigned, as every other change cell does", () => {
  expect([1.234, -0.27, 0.004, -0.004, 0, null].map((value) => percent(value))).toEqual(["+1.23%", "-0.27%", "0.00%", "0.00%", "0.00%", "--"]);
  expect(percent(-0.0004, "", 3)).toBe("0.000");
  expect(percent(0.0004, " pp", 3)).toBe("0.000 pp");
});
