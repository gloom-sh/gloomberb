import { describe, expect, test } from "bun:test";
import type { ResolvedSeries } from "../time-series/types";
import { buildChartShareData } from "./chart-snapshot";
import { parseSharePayload } from "./payload";

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
  test("exports the visible window with its units, gaps and source warnings", () => {
    const input = series(5);
    input.points[2]!.value = null;
    input.warning = "Delayed observations";
    const shared = buildChartShareData([input], { start: input.points[1]!.date, end: input.points[3]!.date });
    expect(shared?.series[0]?.points.map((point) => point.y)).toEqual([1, null, 3]);
    expect(shared?.series[0]?.unit).toBe("USD");
    expect(shared?.viewport).toEqual({ start: "2025-01-02T00:00:00.000Z", end: "2025-01-04T00:00:00.000Z" });
    expect(shared?.warnings).toContain("AAPL: Delayed observations");
    expect(parseSharePayload({ kind: "chart", data: shared })).not.toBeNull();
  });
  test("preserves finite-bucket extremes and missing intervals while bounding a large comparison", () => {
    const input = series(2_000);
    input.points[501]!.value = 50_000;
    input.points[700]!.value = null;
    const sampled = buildChartShareData([input]);
    expect(sampled?.series[0]?.points.some((point) => point.y === 50_000)).toBe(true);
    expect(sampled?.series[0]?.points.some((point) => point.y === null)).toBe(true);
    const large = buildChartShareData(Array.from({ length: 20 }, (_, index) => ({ ...input, label: `${index} ${"長".repeat(110)}` })));
    expect(large?.series.flatMap((entry) => entry.points).length).toBeLessThanOrEqual(1_000);
    expect(new TextEncoder().encode(JSON.stringify(large)).length).toBeLessThan(128 * 1024);
    expect(parseSharePayload({ kind: "chart", data: large })).not.toBeNull();
  });
})

test("dense missing observations keep bounded finite evidence without bridging any original gap", () => {
  const input = series(5_000);
  input.points.forEach((point, index) => { if (index % 10 === 0 || index === 4_999) point.value = null; });
  input.points[501]!.value = 50_000;
  const shared = buildChartShareData([input]);
  expect(shared).not.toBeNull();
  const points = shared!.series[0]!.points;
  expect(points.length).toBeLessThanOrEqual(500);
  expect(points[0]!.y).toBeNull();
  expect(points.at(-1)!.y).toBeNull();
  expect(points.some((point) => point.y === 50_000)).toBe(true);
  expect(points.some((point) => point.y === 1)).toBe(true);
  expect(points.some((point) => point.y === 4_998)).toBe(true);
  const sourceIndex = new Map(input.points.map((point, index) => [point.date.toISOString(), index]));
  for (let index = 1; index < points.length; index++) {
    if (points[index - 1]!.y === null || points[index]!.y === null) continue;
    const start = sourceIndex.get(String(points[index - 1]!.x))!;
    const end = sourceIndex.get(String(points[index]!.x))!;
    expect(input.points.slice(start + 1, end).every((point) => point.value !== null)).toBe(true);
  }
  const large = buildChartShareData(Array.from({ length: 20 }, (_, index) => ({ ...input, label: `Series ${index}` })));
  expect(large!.series.every((entry) => entry.points.some((point) => point.y !== null))).toBe(true);
  expect(large!.series.flatMap((entry) => entry.points).length).toBeLessThanOrEqual(1_000);
  expect(parseSharePayload({ kind: "chart", data: large })).not.toBeNull();
});

test("a step window retains the original preceding observation, and respects an intervening missing value", async () => {
  const { sharedChartGeometry } = await import("../renderers/share/chart");
  const input = series(0);
  input.style = "step";
  input.points = [{ date: new Date("2026-07-26"), value: 4 }, { date: new Date("2026-10-25"), value: 5 }];
  const window = { start: new Date("2026-08-10"), end: new Date("2026-09-10") };
  const shared = buildChartShareData([input], window)!;
  expect(shared.series[0]!.points).toEqual([{ x: "2026-07-26T00:00:00.000Z", y: 4 }]);
  const geometry = sharedChartGeometry(shared);
  expect(geometry.startLabel).toBe("2026-08-10");
  expect(geometry.panels[0]!.series[0]!.segments[0]!.map((point) => point.x)).toEqual([20, 980]);
  expect(geometry.panels[0]!.series[0]!.segments[0]![0]!.label).toContain("2026-07-26");
  input.points.splice(1, 0, { date: new Date("2026-08-01"), value: null });
  expect(buildChartShareData([input], window)).toBeNull();
});

test("a step observation exactly at the opening supersedes the older anchor, including a null", async () => {
  const { sharedChartGeometry } = await import("../renderers/share/chart");
  const window = { start: new Date("2026-08-10"), end: new Date("2026-09-10") };
  for (const value of [4, null]) {
    const input = series(0);
    input.style = "step";
    input.points = [{ date: new Date("2026-07-26"), value: 999 }, { date: window.start, value }];
    const shared = buildChartShareData([input], window);
    if (value === null) expect(shared).toBeNull();
    else expect(shared!.series[0]!.points.map((point) => point.y)).toEqual([4]);
    // Existing/manual payloads can still contain the pre-window context.
    const geometry = sharedChartGeometry({ title: "Boundary", viewport: { start: window.start.toISOString(), end: window.end.toISOString() }, series: [
      { name: "Step", style: "step", points: input.points.map((point) => ({ x: point.date.toISOString(), y: point.value })) },
    ] });
    expect(geometry.panels[0]!.hasValues).toBe(value !== null);
    expect(geometry.panels[0]!.max).toBeLessThan(999);
  }
});

test("market comparisons cannot share fiscal values before their known availability", () => {
  const price = series(0);
  price.timeBasis = { kind: "market", timeZone: "America/New_York" };
  price.points = [{ date: new Date("2026-01-02"), value: 100 }, { date: new Date("2026-01-30"), value: 110 }];
  const fundamental = series(0);
  fundamental.label = "Revenue";
  fundamental.style = "step";
  fundamental.points = [{ date: new Date("2025-12-31"), availableAt: new Date("2026-02-15"), value: 500 }];
  const january = buildChartShareData([price, fundamental], { start: new Date("2026-01-01"), end: new Date("2026-01-31") })!;
  expect(january.series.find((entry) => entry.name === "Revenue")!.points.every((point) => point.y === null)).toBe(true);
  const february = buildChartShareData([price, fundamental], { start: new Date("2026-02-01"), end: new Date("2026-02-28") })!;
  expect(february.series.find((entry) => entry.name === "Revenue")!.points).toEqual([{ x: "2026-02-15T00:00:00.000Z", y: 500 }]);
  expect(february.warnings!.some((note) => note.includes("known availability"))).toBe(true);
  // Pure fiscal-period charts retain their expressly chosen period axis.
  expect(buildChartShareData([fundamental])!.series[0]!.points[0]!.x).toBe("2025-12-31T00:00:00.000Z");
});
