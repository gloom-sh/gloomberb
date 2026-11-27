import { expect, test } from "bun:test";
import { buildStaticChartSeries } from "../../../components/chart/static/chart-surface";
import { buildCompositeChartScene } from "../../../components/chart/composite/scene";
import type { BrokerPortfolioPerformance } from "../../../types/trading";
import { buildPerformanceChartPoints, performanceHistoryNote, resolvePerformanceMetric } from "./broker-performance";
import { buildHistoryAxisLabel } from "./pane-model";

test("missing NAV never substitutes a percentage and deposit growth remains a value series", () => {
  const performance: BrokerPortfolioPerformance = { accountId: "test", source: "flex", period: "2026", currency: "USD", fetchedAt: 1, points: [
    { date: "2026-03-01", value: 21000, cumulativeReturn: .1 },
    { date: "2026-01-01", value: 10000, cumulativeReturn: 0 },
    { date: "2026-02-01", cumulativeReturn: .1 },
  ] };
  expect(buildPerformanceChartPoints(performance).map((point) => point.close)).toEqual([10000, Number.NaN, 21000]);
  expect(buildHistoryAxisLabel({ performance })).toBe("Value (USD)");
  expect(performanceHistoryNote(performance)).toContain("1 missing value observation");
});

test("a lone or duplicated NAV cannot change a usable return series into a currency chart", () => {
  const performance: BrokerPortfolioPerformance = { accountId: "test", source: "flex", period: "2026", currency: "USD", fetchedAt: 1, points: [
    { date: "2026-01-01", cumulativeReturn: 0 },
    { date: "2026-02-01", cumulativeReturn: .1 },
    { date: "2026-03-01", value: 21000, cumulativeReturn: .1 },
    { date: "2026-03-01", value: 21000, cumulativeReturn: .1 },
  ] };
  expect(resolvePerformanceMetric(performance)).toBe("cumulativeReturn");
  expect(buildPerformanceChartPoints(performance).map((point) => point.close)).toEqual([0, .1, .1]);
  expect(buildHistoryAxisLabel({ performance })).toBe("Return");
});


test("whole-row corrections decide the metric before gaps are projected", () => {
  const performance: BrokerPortfolioPerformance = { accountId: "test", source: "flex", period: "2026", fetchedAt: 1, points: [
    { date: "2026-01-01", value: 10000, cumulativeReturn: 0 },
    { date: "2026-02-01", value: 11000, cumulativeReturn: .1 },
    { date: "2026-02-01", cumulativeReturn: .1 },
    { date: "invalid", value: 99999 },
  ] };
  expect(resolvePerformanceMetric(performance)).toBe("cumulativeReturn");
  expect(buildPerformanceChartPoints(performance).map((point) => point.close)).toEqual([0, .1]);
  expect(performanceHistoryNote(performance)).toBeNull();
  performance.points.push({ date: "2026-02-01" });
  expect(resolvePerformanceMetric(performance)).toBe("value");
  expect(buildPerformanceChartPoints(performance).map((point) => point.close)).toEqual([10000, Number.NaN]);
  expect(performanceHistoryNote(performance)).toBe("1 missing value observation.");
  expect(buildHistoryAxisLabel({ performance })).toBe("Value (unknown currency)");
});

test("zero and negative account values stay observations while fully missing history stays unavailable", () => {
  const performance: BrokerPortfolioPerformance = { accountId: "test", source: "flex", period: "2026", fetchedAt: 1, points: [
    { date: "2026-01-01", value: 100 },
    { date: "2026-02-01", value: 0 },
    { date: "2026-03-01", value: -50 },
  ] };
  expect(buildPerformanceChartPoints(performance).map((point) => point.close)).toEqual([100, 0, -50]);
  expect(performanceHistoryNote(performance)).toBeNull();
  performance.points = performance.points.map(({ date }) => ({ date }));
  expect(buildPerformanceChartPoints(performance).every((point) => Number.isNaN(point.close))).toBe(true);
  expect(performanceHistoryNote(performance)).toBe("3 missing return observations.");
});


test("account history gaps remain on the calendar and break the rendered line", () => {
  const performance: BrokerPortfolioPerformance = { accountId: "test", source: "flex", period: "2026", fetchedAt: 1, points: [
    { date: "2026-01-01", value: 100 },
    { date: "2026-01-02" },
    { date: "2026-09-10", value: 200 },
    { date: "2026-09-11", value: 210 },
    { date: "2026-09-11" },
  ] };
  const points = buildPerformanceChartPoints(performance);
  const scene = buildCompositeChartScene(buildStaticChartSeries(points, "line", "#fff", [], true),
    [{ id: "main" }], { width: 80, height: 8 })!;
  expect(scene.endTime).toBe(Date.parse("2026-09-11"));
  expect(scene.dateRatios[1]! / scene.dateRatios[2]!).toBeCloseTo(1 / 252, 6);
  expect(scene.panels[0]!.series[0]!.points.map((point) => point.breakBefore)).toEqual([true, true]);
  expect(scene.panels[0]!.series[0]!.points.map((point) => point.value)).toEqual([100, 200]);
});
