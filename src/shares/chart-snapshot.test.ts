import { describe, expect, test } from "bun:test";
import type { ResolvedSeries } from "../time-series/types";
import { buildChartShareData } from "./chart-snapshot";

function series(pointCount: number): ResolvedSeries {
  return {
    id: "price",
    label: "AAPL",
    color: "#fff",
    unit: "USD",
    unitGroup: "currency:USD",
    nativeFrequency: "daily",
    dataShape: "scalar",
    style: "line",
    transform: "raw",
    axis: "left",
    panelId: "main",
    interpolation: "none",
    points: Array.from({ length: pointCount }, (_, index) => ({
      date: new Date(Date.UTC(2025, 0, index + 1)),
      observedAt: new Date(Date.UTC(2025, 0, index + 1)),
      value: index,
    })),
  };
}

describe("chart share snapshots", () => {
  test("keeps endpoints while bounding shared chart points", () => {
    const shared = buildChartShareData([series(1_000)]);
    expect(shared?.series[0]?.points).toHaveLength(500);
    expect(shared?.series[0]?.points[0]?.y).toBe(0);
    expect(shared?.series[0]?.points.at(-1)?.y).toBe(999);
  });
})
