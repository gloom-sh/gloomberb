import { describe, expect, test } from "bun:test";
import { coneChartSeries, realizedChartSeries } from "./chart-model";

describe("realized-vol chart inputs", () => {
  test("preserves rejected windows as gaps and dates current IV exactly once", () => {
    const dates = [1, 2, 3].map((day) => new Date(Date.UTC(2026, 8, day)));
    const ivDate = new Date("2026-09-04T14:30:00Z");
    const result = realizedChartSeries({ history: [], rolling: dates.map((date, i) => ({ date, values: { 30: i === 1 ? null : 0.2 } })),
      windows: [30], currency: "USD", iv: { value: 0.3, date: ivDate, label: "ATM 30d" } }, ["#123456"]);
    expect(result[0]!.points.map((point) => point.value)).toEqual([20, null, 20]);
    expect(result[1]!.points).toEqual([{ date: ivDate, observedAt: ivDate, value: 30 }]);
    expect(result[1]!.style).toBe("points");
    expect(result[0]!.panelId).not.toBe(result[2]!.panelId);
  });

  test("cone spacing follows session windows and unavailable statistics stay gaps", () => {
    const rows = [10, 30, 260].map((window) => ({ window, min: 0.1, max: 0.4, mean: 0.2,
      current: window === 30 ? null : 0.25, median: 0.2, percentile: 60, sampleSize: 200 }));
    const series = coneChartSeries(rows, ["a", "b", "c", "d"]);
    expect(series[3]!.points.map((point) => point.value)).toEqual([25, null, 25]);
    expect(series[0]!.timeBasis).toBeUndefined();
    expect(series[0]!.points[2]!.date.getTime() - series[0]!.points[1]!.date.getTime()).toBe(230 * 86_400_000);
  });
});
