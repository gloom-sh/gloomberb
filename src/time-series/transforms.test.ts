import { describe, expect, test } from "bun:test";
import { alignTimeSeries, effectiveTimeSeriesPointTime } from "./alignment";
import { extractPriceSeries } from "./market";
import { applySeriesTransform } from "./transforms";
import type { ResolvedSeries, TimeSeriesPoint } from "./types";

function point(date: string, value: number, availableAt?: string): TimeSeriesPoint {
  const observedAt = new Date(`${date}T00:00:00Z`);
  return {
    date: observedAt,
    observedAt,
    availableAt: availableAt ? new Date(`${availableAt}T00:00:00Z`) : undefined,
    value,
  };
}

function series(id: string, points: TimeSeriesPoint[], interpolation: ResolvedSeries["interpolation"]): ResolvedSeries {
  return {
    id,
    label: id,
    color: "#fff",
    unit: "value",
    unitGroup: "value",
    nativeFrequency: "quarterly",
    dataShape: "scalar",
    style: "line",
    transform: "raw",
    axis: "left",
    panelId: "main",
    interpolation,
    points,
  };
}

describe("series transformations", () => {
  test("normalizes to percent and index 100 from the first nonzero observation", () => {
    const points = [point("2024-01-01", 10), point("2024-02-01", 15), point("2024-03-01", 20)];
    expect(applySeriesTransform(points, "percent").map(({ value }) => value)).toEqual([0, 50, 100]);
    expect(applySeriesTransform(points, "index100").map(({ value }) => value)).toEqual([100, 150, 200]);
    expect(points.map(({ value }) => value)).toEqual([10, 15, 20]);
  });

  test("matches QoQ and YoY by observation calendar instead of adjacent array position", () => {
    const points = [
      point("2023-03-31", 80),
      point("2023-12-31", 100),
      point("2024-03-31", 120),
      point("2024-12-31", 150),
    ];
    expect(applySeriesTransform(points, "qoq").map(({ value }) => value)).toEqual([null, null, 20, null]);
    expect(applySeriesTransform(points, "yoy").map(({ value }) => value)).toEqual([null, null, 50, 50]);
  });

  test("log transform leaves nonpositive values as gaps", () => {
    const values = applySeriesTransform([
      point("2024-01-01", -1),
      point("2024-02-01", 1),
      point("2024-03-01", Math.E),
    ], "log").map(({ value }) => value);
    expect(values[0]).toBeNull();
    expect(values[1]).toBe(0);
    expect(values[2]).toBeCloseTo(1, 12);
  });

  test("binary reference lookup matches the prior linear scan", () => {
    const start = Date.parse("2021-01-01T00:00:00Z");
    const points = Array.from({ length: 800 }, (_, index) => (
      point(new Date(start + index * 3 * 86_400_000).toISOString().slice(0, 10), index + 10)
    ));
    const expected = points.map((current, currentIndex) => {
      const target = new Date(current.observedAt);
      const originalDay = target.getUTCDate();
      target.setUTCDate(1);
      target.setUTCMonth(target.getUTCMonth() - 12);
      target.setUTCDate(Math.min(originalDay, new Date(Date.UTC(
        target.getUTCFullYear(),
        target.getUTCMonth() + 1,
        0,
      )).getUTCDate()));
      const reference = points.slice(0, currentIndex)
        .map((candidate, index) => ({
          candidate,
          index,
          distance: Math.abs(candidate.observedAt.getTime() - target.getTime()),
        }))
        .filter(({ candidate, distance }) => (
          candidate.observedAt < current.observedAt && distance <= 62 * 86_400_000
        ))
        .sort((left, right) => (
          left.distance - right.distance
          || right.candidate.observedAt.getTime() - left.candidate.observedAt.getTime()
          || left.index - right.index
        ))[0]?.candidate;
      return reference ? ((current.value! - reference.value!) / Math.abs(reference.value!)) * 100 : null;
    });

    expect(applySeriesTransform(points, "yoy").map(({ value }) => value)).toEqual(expected);
  });

  test("preserves point-in-time lookup when publication order differs from observation order", () => {
    const points = [
      { ...point("2023-01-01", 100), date: new Date("2023-03-01T00:00:00Z") },
      { ...point("2020-01-01", 50), date: new Date("2023-04-01T00:00:00Z") },
      { ...point("2024-01-01", 200), date: new Date("2024-03-01T00:00:00Z") },
    ];

    expect(applySeriesTransform(points, "yoy").at(-1)?.value).toBe(100);
  });
});

describe("market aggregation", () => {
  test("uses first open, extrema, last close, and summed volume", () => {
    const points = extractPriceSeries([
      { date: new Date("2024-01-02T10:00:00Z"), open: 10, high: 12, low: 9, close: 11, volume: 100 },
      { date: new Date("2024-01-02T16:00:00Z"), open: 11, high: 14, low: 10, close: 13, volume: 250 },
    ], {
      kind: "security",
      instrument: { symbol: "TEST" },
      fieldId: "market.ohlcv",
      period: "daily",
    });
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ open: 10, high: 14, low: 9, close: 13, value: 13, volume: 350 });
  });
});

describe("mixed-frequency alignment", () => {
  test("never carries forward before availability or backward before the first point", () => {
    const sparse = series("fundamental", [
      point("2024-03-31", 40, "2024-05-15"),
    ], "step-after");
    const dates = ["2024-03-01", "2024-03-31", "2024-04-15", "2024-05-15", "2024-06-01"]
      .map((date) => new Date(`${date}T00:00:00Z`));
    const rows = alignTimeSeries([sparse], { timeline: dates });
    expect(rows.map((row) => row.values.fundamental?.value ?? null)).toEqual([null, null, null, 40, 40]);
    expect(rows[3]?.values.fundamental?.carried).toBe(false);
  });

  test("moving carry pointers match a full scan when availability is out of order", () => {
    const points = [
      point("2024-01-01", 1, "2024-01-10"),
      point("2024-01-02", 2, "2024-01-05"),
      point("2024-01-03", 3),
    ];
    const timeline = ["2024-01-01", "2024-01-03", "2024-01-04", "2024-01-05", "2024-01-06", "2024-01-10"]
      .map((date) => new Date(`${date}T00:00:00Z`));
    const rows = alignTimeSeries([series("fundamental", points, "step-after")], { timeline });
    const exact = new Map(points.map((entry) => [effectiveTimeSeriesPointTime(entry), entry]));
    const expected = timeline.map((date) => {
      const time = date.getTime();
      const exactPoint = exact.get(time);
      if (exactPoint) return [exactPoint.value, false];
      const previous = points.reduce<TimeSeriesPoint | null>((best, candidate) => {
        const candidateTime = effectiveTimeSeriesPointTime(candidate);
        return candidateTime <= time
          && (!best || candidateTime >= effectiveTimeSeriesPointTime(best))
          ? candidate
          : best;
      }, null);
      return previous ? [previous.value, true] : [null, null];
    });

    expect(rows.map((row) => {
      const value = row.values.fundamental;
      return value ? [value.value, value.carried] : [null, null];
    })).toEqual(expected);
  });

  test("intersection keeps only timestamps where every series has a usable value", () => {
    const daily = series("price", [
      point("2024-01-01", 10),
      point("2024-01-02", 11),
      point("2024-01-03", 12),
    ], "none");
    const sparse = series("metric", [point("2024-01-02", 5)], "step-after");
    const rows = alignTimeSeries([daily, sparse], { mode: "intersection" });
    expect(rows.map((row) => row.date.toISOString().slice(0, 10))).toEqual(["2024-01-02", "2024-01-03"]);
    expect(rows[1]?.values.metric?.carried).toBe(true);
  });
});
