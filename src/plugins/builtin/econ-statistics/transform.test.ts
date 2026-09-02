import { describe, expect, test } from "bun:test";
import { applyTransform, periodsPerYear } from "./transform";

function monthly(values: number[], startYear = 2020): Array<{ date: string; value: number }> {
  return values.map((value, index) => {
    const month = (index % 12) + 1;
    const year = startYear + Math.floor(index / 12);
    return { date: `${year}-${String(month).padStart(2, "0")}-01`, value };
  });
}

describe("periodsPerYear", () => {
  test("reads cadence off the gaps rather than being told", () => {
    expect(periodsPerYear(monthly([1, 2, 3, 4, 5]))).toBe(12);
    expect(periodsPerYear([
      { date: "2024-01-01", value: 1 },
      { date: "2024-04-01", value: 2 },
      { date: "2024-07-01", value: 3 },
      { date: "2024-10-01", value: 4 },
    ])).toBe(4);
    expect(periodsPerYear([
      { date: "2024-01-06", value: 1 },
      { date: "2024-01-13", value: 2 },
      { date: "2024-01-20", value: 3 },
      { date: "2024-01-27", value: 4 },
    ])).toBe(52);
  });
});

describe("applyTransform", () => {
  test("year over year looks back a whole cadence, not one print", () => {
    // 13 monthly points where the index rises 10% across the year.
    const points = monthly([100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 110]);
    const yoy = applyTransform(points, "yoy");
    expect(yoy).toHaveLength(1);
    expect(yoy[0]!.date).toBe("2021-01-01");
    expect(yoy[0]!.value).toBeCloseTo(10, 6);
  });

  test("month over month uses the previous print", () => {
    const mom = applyTransform(monthly([100, 101]), "mom");
    expect(mom).toHaveLength(1);
    expect(mom[0]!.value).toBeCloseTo(1, 6);
  });

  test("a quarterly move is stated at the annual rate it implies", () => {
    // Cadence is inferred from the gaps, so it takes a few prints to see quarterly.
    const quarterly = [
      { date: "2024-01-01", value: 100 },
      { date: "2024-04-01", value: 100 },
      { date: "2024-07-01", value: 100 },
      { date: "2024-10-01", value: 101 },
    ];
    // 1% in a quarter compounds to about 4.06% a year, not 4%.
    const value = applyTransform(quarterly, "qoq-annualized").at(-1)!.value;
    expect(value).toBeCloseTo((Math.pow(1.01, 4) - 1) * 100, 6);
    expect(value).toBeGreaterThan(4);
  });

  test("too few prints to infer cadence falls back to monthly", () => {
    // Two points cannot show a gap pattern, so a year-over-year lag is unknowable.
    expect(applyTransform([
      { date: "2024-01-01", value: 100 },
      { date: "2024-04-01", value: 101 },
    ], "yoy")).toHaveLength(0);
  });

  test("change is a difference, so it keeps the series' own units", () => {
    const change = applyTransform(monthly([150_000, 150_120]), "change");
    expect(change[0]!.value).toBeCloseTo(120, 6);
  });

  test("levels pass through and gaps are dropped, not interpolated", () => {
    const level = applyTransform([
      { date: "2024-03-01", value: 2 },
      { date: "2024-01-01", value: null },
      { date: "2024-02-01", value: 1 },
    ], "level");
    // Sorted ascending, with the null month absent rather than filled in.
    expect(level.map((point) => point.date)).toEqual(["2024-02-01", "2024-03-01"]);
  });

  test("a zero base cannot produce a percent change", () => {
    expect(applyTransform(monthly([0, 5]), "mom")).toHaveLength(0);
  });
});
