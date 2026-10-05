import { expect, test } from "bun:test";
import { THEME_PERIODS, type ThemeMember, type ThemeSummary } from "../../../api-client/themes";
import { fitTableCellText, tableColumnWidth } from "../../../components/ui/table-layout";
import { aggregateText, coverageWidth, DEFAULT_SORT, matchTheme, memberColumns, percent, sortMembers, sortThemes, themeColumns } from "./model";

const theme = (id: string, day: number | null, covered = 10): ThemeSummary => ({
  id, name: id, description: "", keywords: [], memberCount: 10, present: 10, stale: false,
  returns: Object.fromEntries(THEME_PERIODS.map((period) => [period, { value: day, covered, total: 10 }])) as ThemeSummary["returns"],
  breadth: { value: 60, covered, total: 10 }, best: null, worst: null,
});
const member = (symbol: string, day: number | null) => ({ symbol, changePercent: day }) as ThemeMember;

test("theme and member sorting keep missing values last in both directions with stable ties", () => {
  const rows = [theme("C", null), theme("B", 2), theme("A", 2), theme("D", -3)];
  expect(sortThemes(rows, DEFAULT_SORT).map((row) => row.id)).toEqual(["A", "B", "D", "C"]);
  expect(sortThemes(rows, { ...DEFAULT_SORT, direction: "asc" }).map((row) => row.id)).toEqual(["D", "A", "B", "C"]);
  expect(sortMembers([member("B", null), member("A", -2), member("C", 5)], DEFAULT_SORT).map((row) => row.symbol)).toEqual(["C", "A", "B"]);
  expect(rows[0]?.id).toBe("C");
});

test("formatting distinguishes zero, missing and partial coverage without negative zero", () => {
  expect(percent(-0.001)).toBe("0.00%");
  expect(percent(-2.345)).toBe("-2.35%");
  expect(aggregateText({ value: 1.2, covered: 10, total: 10 })).toBe("+1.20%");
  expect(aggregateText({ value: 1.2, covered: 9, total: 10 })).toBe("+1.20% 9/10");
  expect(aggregateText({ value: null, covered: 4, total: 10 })).toBe("-- 4/10");
  expect(aggregateText({ value: 0, covered: 10, total: 10 }, true)).toBe("0%");
});

test("narrow columns preserve the daily read and size for partial coverage", () => {
  const rows = [theme("Nuclear", 12.34, 9)];
  const wide = themeColumns(180, rows).map((column) => column.id);
  expect(wide).toContain("best");
  expect(wide).toContain("return3MPercent");
  const narrow = themeColumns(65, rows);
  expect(narrow.map((column) => column.id)).toContain("changePercent");
  expect(narrow.map((column) => column.id)).toContain("breadth");
  expect(narrow.map((column) => column.id)).not.toContain("best");
  expect(narrow.find((column) => column.id === "changePercent")!.width).toBeGreaterThanOrEqual(aggregateText(rows[0]!.returns.changePercent).length);
  expect(memberColumns(45).map((column) => column.id)).toContain("changePercent");
  expect(memberColumns(45).map((column) => column.id)).toContain("symbol");
});

test("command arguments resolve server names and keywords before fuzzy subsequences", () => {
  const rows = [{ ...theme("nuclear", 1), name: "Nuclear & uranium", keywords: ["reactors", "smr"] },
    { ...theme("grid", 2), name: "Power & grid equipment", keywords: ["electrification"] }];
  expect(matchTheme(rows, "nuclear")?.id).toBe("nuclear");
  expect(matchTheme(rows, " REACTORS ")?.id).toBe("nuclear");
  expect(matchTheme(rows, "nclr")?.id).toBe("nuclear");
  expect(matchTheme(rows, "electrification")?.id).toBe("grid");
  expect(matchTheme(rows, "totally absent word")).toBeNull();
});

test("right-aligned headers end over numbers with and without a partial-coverage row", () => {
  for (const width of [90, 250]) {
    for (const covered of [10, 9]) {
      const rows = [theme("Full", 1.23), theme("Partial", -0.27, covered)];
      for (const column of themeColumns(width, rows)) {
        if (!THEME_PERIODS.includes(column.id as typeof THEME_PERIODS[number]) && column.id !== "breadth") continue;
        const metrics = rows.map((row) => column.id === "breadth" ? row.breadth : row.returns[column.id as typeof THEME_PERIODS[number]]);
        const noteWidth = coverageWidth(metrics);
        const renderedWidth = tableColumnWidth(column);
        const header = fitTableCellText(column.label, renderedWidth, "right");
        const headerEnd = header.trimEnd().length;
        for (const metric of metrics) {
          const value = column.id === "breadth" ? `${Math.round(metric.value!)}%` : percent(metric.value);
          const note = metric.covered < metric.total ? `${metric.covered}/${metric.total}` : "";
          const cell = fitTableCellText(value + note.padStart(noteWidth), renderedWidth, "right");
          expect(cell.indexOf("%") + 1).toBe(headerEnd);
        }
      }
    }
  }
});
