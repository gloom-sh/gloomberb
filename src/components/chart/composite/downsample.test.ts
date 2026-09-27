import { describe, expect, test } from "bun:test";
import type { ResolvedSeries, TimeSeriesPoint } from "../../../time-series/types";
import {
  downsampleCompositeChartScene,
  downsampleLttb,
  downsampleOhlcProjectedPoints,
} from "./downsample";
import { buildCompositeChartScene } from "./scene";
import { createTestResolvedSeries as series, createTestSeriesPoint as point } from "../../../test-support/time-series";

function ohlcPoint(
  date: Date,
  open: number,
  high: number,
  low: number,
  close: number,
): TimeSeriesPoint {
  return {
    date,
    observedAt: date,
    value: close,
    open,
    high,
    low,
    close,
    volume: 1,
  };
}

function denseLineSeries(count: number): ResolvedSeries {
  const start = Date.parse("2024-01-01T00:00:00.000Z");
  return series({
    id: "price",
    points: Array.from({ length: count }, (_, index) => {
      const date = new Date(start + index * 86_400_000);
      const value = 100 + Math.sin(index / 8) * 20 + (index % 37 === 0 ? 40 : 0);
      return { date, observedAt: date, value };
    }),
  });
}

describe("composite downsample", () => {
  test("caps line series to the pixel width and keeps the shared date list", () => {
    const scene = buildCompositeChartScene(
      [denseLineSeries(400)],
      [{ id: "main" }],
      { width: 80, height: 12 },
    );
    expect(scene).not.toBeNull();
    expect(scene!.panels[0]!.series[0]!.points.length).toBe(400);

    const downsampled = downsampleCompositeChartScene(scene!, 64);
    expect(downsampled.dates).toBe(scene!.dates);
    expect(downsampled.dateRatios).toBe(scene!.dateRatios);
    expect(downsampled.dates).toHaveLength(400);
    expect(downsampled.panels[0]!.series[0]!.points.length).toBeLessThanOrEqual(64);
    expect(downsampled.panels[0]!.series[0]!.points.length).toBeGreaterThan(2);
  });

  test("LTTB never exceeds the requested point budget", () => {
    const scene = buildCompositeChartScene(
      [denseLineSeries(250)],
      [{ id: "main" }],
      { width: 120, height: 10 },
    )!;
    const points = scene.panels[0]!.series[0]!.points;
    expect(downsampleLttb(points, 40)).toHaveLength(40);
    expect(downsampleLttb(points, points.length)).toBe(points);
  });

  test("OHLC buckets preserve the viewport high and low", () => {
    const start = Date.parse("2024-01-01T00:00:00.000Z");
    const candles = series({
      id: "ohlc",
      dataShape: "ohlcv",
      style: "candles",
      points: Array.from({ length: 180 }, (_, index) => {
        const date = new Date(start + index * 86_400_000);
        const close = 50 + index;
        const high = index === 41 ? 900 : close + 1;
        const low = index === 117 ? 2 : close - 1;
        return ohlcPoint(date, close - 0.5, high, low, close);
      }),
    });
    const scene = buildCompositeChartScene(
      [candles],
      [{ id: "main" }],
      { width: 80, height: 12 },
    )!;
    const source = scene.panels[0]!.series[0]!.points;
    const buckets = downsampleOhlcProjectedPoints(source, 40);
    expect(buckets.length).toBeLessThanOrEqual(40);
    expect(Math.max(...buckets.map((entry) => entry.point.high ?? entry.value))).toBe(900);
    expect(Math.min(...buckets.map((entry) => entry.point.low ?? entry.value))).toBe(2);
  });

  test("does not downsample when the series already fits the budget", () => {
    const scene = buildCompositeChartScene(
      [series({
        id: "short",
        points: [point("2025-01-01", 10), point("2025-01-02", 12), point("2025-01-03", 11)],
      })],
      [{ id: "main" }],
      { width: 80, height: 8 },
    )!;
    const downsampled = downsampleCompositeChartScene(scene, 64);
    expect(downsampled.panels[0]!.series[0]!.points).toBe(scene.panels[0]!.series[0]!.points);
  });
});
