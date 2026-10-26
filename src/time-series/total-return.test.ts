import { describe, expect, test } from "bun:test";
import { reinvestDistributions } from "./total-return";
import type { TimeSeriesPoint } from "./types";

const bar = (day: string, close: number): TimeSeriesPoint => ({
  date: new Date(`${day}T00:00:00Z`), observedAt: new Date(`${day}T00:00:00Z`), value: close, close, open: close, high: close, low: close, volume: 1_000,
});
const options = { dayOf: (point: TimeSeriesPoint) => point.date.toISOString().slice(0, 10), cashPrice: (price: number) => price };

describe("reinvestDistributions", () => {
  test("moves a series by (close + cash) over the bar before, at the ex-date close", () => {
    const { points, applied } = reinvestDistributions(
      [bar("2026-01-02", 10), bar("2026-01-05", 10), bar("2026-01-06", 9.5), bar("2026-01-07", 9.5)],
      [{ exDate: "2026-01-06", amount: 0.5 }], options);
    expect(applied).toBe(1);
    // 9.5 + 0.5 over the 10 before it: flat, not the 5% the price lost.
    expect(points.map((point) => point.close!.toFixed(6))).toEqual(["10.000000", "10.000000", "10.000000", "10.000000"]);
    // Each price field is scaled by the shares the cash bought; volume is not.
    expect(points[2]).toMatchObject({ value: points[2]!.close, open: points[2]!.close, high: points[2]!.close, volume: 1_000 });
  });

  test("compounds across distributions and lands an ex-date with no session on the next bar", () => {
    const { points } = reinvestDistributions(
      [bar("2026-01-02", 10), bar("2026-02-02", 10), bar("2026-03-02", 10)],
      [{ exDate: "2026-01-31", amount: 1 }, { exDate: "2026-03-01", amount: 1 }], options);
    expect(points.map((point) => point.close!.toFixed(6))).toEqual(["10.000000", "11.000000", "12.100000"]);
  });

  test("a distribution before the series, after it, or in another currency reinvests nothing", () => {
    const series = [bar("2026-01-05", 10), bar("2026-01-06", 10)];
    const before = reinvestDistributions(series, [{ exDate: "2026-01-05", amount: 1 }, { exDate: "2025-12-01", amount: 1 }, { exDate: "2026-01-09", amount: 1 }], options);
    expect(before.applied).toBe(0);
    expect(before.points).toEqual(series);
    const foreign = reinvestDistributions(series, [{ exDate: "2026-01-06", amount: 1 }], { ...options, cashPrice: () => null });
    expect(foreign.applied).toBe(0);
    expect(foreign.points).toEqual(series);
  });

  test("weekly bars take a distribution into the bar that holds its ex-date", () => {
    const weeks = [bar("2026-01-05", 10), bar("2026-01-12", 10), bar("2026-01-19", 10)];
    const { points } = reinvestDistributions(weeks, [{ exDate: "2026-01-14", amount: 1 }], { ...options, barDays: 7 });
    expect(points.map((point) => point.close)).toEqual([10, 11, 11]);
  });

  test("a distribution after the last bar's period, or after today, is not reinvested into that bar", () => {
    const weeks = [bar("2026-01-05", 10), bar("2026-01-12", 10), bar("2026-01-19", 10)];
    // The last week runs to the 26th: 22 Jan is in it, 2 Feb is an announced date after it.
    const inside = reinvestDistributions(weeks, [{ exDate: "2026-01-22", amount: 1 }], { ...options, barDays: 7, asOf: "2026-01-23" });
    expect(inside.points.map((point) => point.close)).toEqual([10, 10, 11]);
    const after = reinvestDistributions(weeks, [{ exDate: "2026-02-02", amount: 1 }], { ...options, barDays: 7, asOf: "2026-02-10" });
    expect(after.applied).toBe(0);
    expect(after.points).toEqual(weeks);
    // Not gone ex yet, though inside the last bar's week.
    const announced = reinvestDistributions(weeks, [{ exDate: "2026-01-23", amount: 1 }], { ...options, barDays: 7, asOf: "2026-01-20" });
    expect(announced.applied).toBe(0);
    // Monthly bars run to the next month's start.
    const months = [bar("2026-01-02", 10), bar("2026-02-02", 10)];
    const monthly = (exDate: string) => reinvestDistributions(months, [{ exDate, amount: 1 }], { ...options, barDays: 30, asOf: "2026-03-20" }).applied;
    expect([monthly("2026-02-27"), monthly("2026-03-05")]).toEqual([1, 0]);
  });

  test("ignores bad cash and leaves the input alone", () => {
    const series = [bar("2026-01-05", 10), bar("2026-01-06", 10)];
    const { points, applied } = reinvestDistributions(series, [
      { exDate: "2026-01-06", amount: 0 }, { exDate: "2026-01-06", amount: Number.NaN }, { exDate: "not a date", amount: 1 }], options);
    expect(applied).toBe(0);
    expect(points).toEqual(series);
    expect(series[1]!.close).toBe(10);
  });
});
