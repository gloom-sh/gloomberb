import { expect, test } from "bun:test";
import { createTestResolvedSeries, createTestSeriesPoint as point } from "../../../test-support/time-series";
import { compositeRangeStatistics, compositeRangeStatisticsLevels } from "./range-statistics";
import { projectLevels } from "./levels";
import { buildCompositeChartScene } from "./scene";

const viewport = { start: new Date("2025-01-02"), end: new Date("2025-01-05") };

test("range statistics include the boundary days, omit gaps and non-finite values, and ignore the history buffer", () => {
  const points = [
    point("2025-01-01", 1000), point("2025-01-02", 20), point("2025-01-03", null),
    point("2025-01-03", NaN),
    point("2025-01-03", Infinity), point(new Date(NaN), 500),
    point("2025-01-04", 30), point("2025-01-05", 40), point("2025-01-06", 1000),
  ];
  const statistics = compositeRangeStatistics(points, viewport)!;
  expect(statistics.count).toBe(3);
  expect(statistics.mean).toBe(30);
  // Population standard deviation: the visible observations are the population.
  expect(statistics.standardDeviation).toBeCloseTo(Math.sqrt(200 / 3), 12);
  expect(compositeRangeStatistics(points, { start: new Date("2025-01-04"), end: viewport.end })).toEqual({
    count: 2, mean: 35, standardDeviation: 5,
  });
  expect(compositeRangeStatistics(points, { start: new Date("2025-01-03"), end: new Date("2025-01-03") })).toBeNull();
});

test("small dispersion around a large value remains accurate", () => {
  const statistics = compositeRangeStatistics([1, 2, 3].map((offset) => point("2025-01-02", 1e12 + offset)), viewport)!;
  expect(statistics.mean).toBe(1e12 + 2);
  expect(statistics.standardDeviation).toBeCloseTo(Math.sqrt(2 / 3), 12);
});

test("guides require 20 valid observations; hidden series and empty windows have none", () => {
  const series = createTestResolvedSeries({ id: "pe", unit: "x", unitGroup: "ratio", points: Array.from({ length: 20 }, () => point("2025-01-02", 25)) });
  expect(compositeRangeStatisticsLevels({ ...series, points: series.points.slice(1) }, viewport, "#808080")).toBeNull();
  const one = compositeRangeStatisticsLevels(series, viewport, "#808080")!;
  expect(one.items).toHaveLength(1);
  expect(one.items[0]!.value).toBe(25);
  expect(compositeRangeStatisticsLevels({ ...series, points: [...series.points, point("2025-01-04", 25)] }, viewport, "#808080")!.items).toHaveLength(1);
  expect(compositeRangeStatisticsLevels({ ...series, hidden: true }, viewport, "#808080")).toBeNull();
  expect(compositeRangeStatisticsLevels(undefined, viewport, "#808080")).toBeNull();
  expect(compositeRangeStatisticsLevels({ ...series, points: [point("2025-01-02", null)] }, viewport, "#808080")).toBeNull();
  expect(compositeRangeStatistics(series.points, { start: new Date(NaN), end: viewport.end })).toBeNull();
  expect(compositeRangeStatistics(series.points, { start: viewport.end, end: viewport.start })).toBeNull();
});

test("auto-scaling keeps a skewed series' sigma guides visible without changing a neighbouring axis", () => {
  const series = createTestResolvedSeries({
    id: "pe", unit: "x", unitGroup: "ratio",
    points: [1, 1, 1, 1, 1, 100].flatMap((value, index) => Array.from({ length: 4 }, () => point(`2025-01-0${index + 1}`, value))),
  });
  const other = createTestResolvedSeries({ id: "other", axis: "right", points: [point("2025-01-01", 1000), point("2025-01-06", 2000)] });
  const window = { start: new Date("2025-01-01"), end: new Date("2025-01-06") };
  const referenceLevels = compositeRangeStatisticsLevels(series, window, "#808080")!;
  const base = buildCompositeChartScene([series, other], [{ id: "main" }], { width: 80, height: 24, viewport: window })!;
  const scene = buildCompositeChartScene([series, other], [{ id: "main" }], { width: 80, height: 24, viewport: window, referenceLevels })!;
  expect(referenceLevels.items.find((level) => level.id.endsWith(":lower"))!.value).toBeLessThan(0);
  expect(projectLevels(referenceLevels.items, scene.panels[0]!.axes.left!, null)).toHaveLength(3);
  expect(scene.panels[0]!.axes.right).toEqual(base.panels[0]!.axes.right);
});
