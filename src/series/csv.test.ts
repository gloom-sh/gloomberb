import { describe, expect, test } from "bun:test";
import { inferSeriesFrequency, parseSeriesCsv, parseSeriesCsvDate } from "./csv";

const iso = (value: unknown) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value));

describe("series CSV files", () => {
  test("reads metadata lines, a header, quoted cells and every value column", () => {
    const parsed = parseSeriesCsv([
      "\uFEFF# name: Lemonade stand",
      "# unit: USD",
      "# frequency: weekly",
      "# owner: ignored",
      "week,\"Sales, gross\",Cups",
      "2024-01-05,\"1,250.5\",40",
      "2024-01-12,.,42",
      "not a date,9,9",
      "2024-01-19,1300,",
    ].join("\n"));
    expect(parsed.metadata).toEqual({ name: "Lemonade stand", unit: "USD", frequency: "weekly" });
    expect(parsed.columns.map((column) => column.header)).toEqual(["Sales, gross", "Cups"]);
    // Thousands separators are read as a spreadsheet writes them; a dot is a missing value.
    expect(parsed.columns[0]!.points.map((point) => [iso(point.date), point.value])).toEqual([
      ["2024-01-05", 1250.5], ["2024-01-12", null], ["2024-01-19", 1300],
    ]);
    expect(parsed.columns[1]!.points.map((point) => point.value)).toEqual([40, 42, null]);
  });

  test("takes semicolons and tabs, files without a header, and month or year dates", () => {
    const semicolons = parseSeriesCsv("2024-01;1,5\n2024-02;2\n");
    expect(semicolons.columns).toHaveLength(1);
    expect(semicolons.columns[0]!.points.map((point) => point.value)).toEqual([1.5, 2]);
    expect(semicolons.columns[0]!.header).toBeUndefined();
    expect(semicolons.columns[0]!.points.map((point) => iso(point.date))).toEqual(["2024-01-01", "2024-02-01"]);
    expect(parseSeriesCsv("date\tvalue\n2020\t1\n2021\t2").columns[0]!.points.map((point) => point.value)).toEqual([1, 2]);
    expect(parseSeriesCsvDate("2024-02-30")).toBeNull();
    expect(parseSeriesCsvDate("2024-03-01 14:30")?.toISOString()).toContain("2024-03-01");
  });

  test("the frequency comes from the median spacing of the dates", () => {
    const every = (days: number, count = 6) => Array.from({ length: count }, (_, index) => ({
      date: new Date(Date.UTC(2024, 0, 1) + index * days * 86_400_000),
      value: index,
    }));
    expect(inferSeriesFrequency(every(1))).toBe("daily");
    // Weekdays only: the weekend gap does not make it weekly.
    expect(inferSeriesFrequency([...every(1, 5), ...every(1, 5).map((point) => ({ ...point, date: new Date(point.date.getTime() + 7 * 86_400_000) }))]))
      .toBe("daily");
    expect(inferSeriesFrequency(every(7))).toBe("weekly");
    expect(inferSeriesFrequency(every(30))).toBe("monthly");
    expect(inferSeriesFrequency(every(91))).toBe("quarterly");
    expect(inferSeriesFrequency(every(365))).toBe("annual");
    expect(inferSeriesFrequency(every(1, 1))).toBe("irregular");
  });
});
