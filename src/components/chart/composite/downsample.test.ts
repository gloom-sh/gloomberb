import { describe, expect, test } from "bun:test";
import type { ResolvedSeries, TimeSeriesPoint } from "../../../time-series/types";
import {
  downsampleCompositeChartScene,
  downsampleLttb,
  downsampleOhlcProjectedPoints,
} from "./downsample";
import { applyCompositeChartCursor, buildCompositeChartScene } from "./scene";
import { stackedSeries } from "../static/series";
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

  test("the cursor reads the bar under it, not the thinned plot, and marks a coarser series' value as carried", () => {
    const start = Date.parse("2024-01-01T00:00:00.000Z");
    const daily = series({
      id: "price",
      style: "candles",
      points: Array.from({ length: 900 }, (_, index) => ohlcPoint(new Date(start + index * 86_400_000), index, index + 1, index - 1, index + 0.5)),
    });
    const weekly = series({
      id: "weekly",
      points: Array.from({ length: 129 }, (_, index) => point(new Date(start + index * 7 * 86_400_000), 1_000 + index)),
    });
    const scene = buildCompositeChartScene([daily, weekly], [{ id: "main" }], { width: 80, height: 12 })!;
    // Candles thin to one per two pixels: most bars sit inside another's bucket.
    const thinned = downsampleCompositeChartScene(scene, 120);
    expect(thinned.panels[0]!.series[0]!.points.length).toBeLessThan(100);
    const cursor = applyCompositeChartCursor(thinned, new Date(start + 503 * 86_400_000));
    const value = (id: string) => cursor.cursorValues.find((entry) => entry.seriesId === id);
    expect(value("price")?.value).toBe(503.5);
    expect(value("price")?.carried).toBeUndefined();
    expect(value("weekly")).toMatchObject({ value: 1_071, carried: true });
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

  test("stacked layers thin on the same dates, so each layer's floor stays the top of the one below", () => {
    const start = Date.parse("2024-01-01T00:00:00.000Z");
    const dates = Array.from({ length: 600 }, (_, index) => new Date(start + index * 86_400_000));
    // Layers that peak on different days would each keep their own days if thinned apart.
    const layers = [0, 1, 2].map((layer) => ({
      id: `layer-${layer}`,
      label: `Layer ${layer}`,
      color: "#4dabf7",
      values: dates.map((_, index) => 10 + Math.sin(index / (5 + layer * 3)) * 5 + (index % (41 + layer) === 0 ? 20 : 0)),
    }));
    const stacked = stackedSeries(dates, layers, { calendarSpaced: true });
    expect(stacked[1]!.points[7]).toMatchObject({ low: stacked[0]!.points[7]!.high, rawValue: layers[1]!.values[7] });
    const scene = buildCompositeChartScene(stacked, [{ id: "main" }], { width: 80, height: 12 })!;
    const thinned = downsampleCompositeChartScene(scene, 64).panels[0]!.series;
    const days = (index: number) => thinned[index]!.points.map((point) => point.timestamp);
    expect(days(0).length).toBeLessThan(600);
    expect(days(0)).toEqual(days(2));
    expect(days(1)).toEqual(days(2));
    thinned[1]!.points.forEach((point, index) => expect(point.point.low).toBe(thinned[0]!.points[index]!.point.high!));
  });
});
