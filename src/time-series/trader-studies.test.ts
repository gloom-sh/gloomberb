import { describe, expect, test } from "bun:test";
import { createTestResolvedSeries } from "../test-support/time-series";
import { resolveStudies, withVwapAnchors } from "./studies";
import { anchoredVwap, averageTrueRange, sessionVwap, volumeProfile, type StudyBar } from "./trader-studies";
import type { ChartStudySpec, ResolvedSeries, TimeSeriesPoint } from "./types";

function bar(time: number, high: number, low: number, close: number, volume: number): StudyBar {
  return { time, high, low, close, volume };
}

describe("session VWAP", () => {
  test("weights the typical price by volume, restarts each session and waits for volume", () => {
    const bars = [
      bar(0, 11, 9, 10, 0),
      bar(1, 11, 9, 10, 100),
      bar(2, 12, 10, 11, 300),
      bar(3, 21, 19, 20, 50),
    ];
    const values = sessionVwap(bars, (entry) => entry.time < 3 ? 1 : 2);
    // No volume yet, no VWAP.
    expect(values.map((value) => value.index)).toEqual([1, 2, 3]);
    expect(values[0]!.value).toBe(10);
    expect(values[1]!.value).toBeCloseTo(10.75, 10);
    // sqrt((100*10^2 + 300*11^2) / 400 - 10.75^2)
    expect(values[1]!.deviation).toBeCloseTo(Math.sqrt(0.1875), 10);
    expect(values[2]).toEqual({ index: 3, value: 20, deviation: 0 });
  });

  test("anchored VWAP starts at the bar holding its anchor and never resets", () => {
    const bars = [bar(0, 11, 9, 10, 100), bar(10, 12, 10, 11, 300), bar(20, 13, 11, 12, 100)];
    const values = anchoredVwap(bars, 5);
    expect(values.map((value) => value.index)).toEqual([1, 2]);
    expect(values[0]!.value).toBe(11);
    expect(values[1]!.value).toBeCloseTo(4500 / 400, 10);
    // Ten-unit bars: the bar from 0 to 10 holds the anchor at 5.
    expect(anchoredVwap(bars, 5, 10).map((value) => value.index)).toEqual([0, 1, 2]);
    expect(anchoredVwap(bars, 10, 10).map((value) => value.index)).toEqual([1, 2]);
  });
});

test("average true range seeds with the mean range and then smooths by 1/period", () => {
  const bars = [
    bar(0, 10, 8, 9, 1),
    bar(1, 11, 9, 10, 1),
    bar(2, 12, 9, 11, 1),
    bar(3, 11, 10, 10.5, 1),
    // A gap up: the range from the previous close is the true range.
    bar(4, 15, 14, 14.5, 1),
  ];
  const values = averageTrueRange(bars, 3);
  expect(values.map((value) => value.index)).toEqual([2, 3, 4]);
  expect(values[0]!.value).toBeCloseTo(7 / 3, 10);
  expect(values[1]!.value).toBeCloseTo(17 / 9, 10);
  expect(values[2]!.value).toBeCloseTo(74.5 / 27, 10);
  expect(averageTrueRange(bars.slice(0, 2), 3)).toEqual([]);
});

test("volume profile spreads each bar over its range and grows the value area from the point of control", () => {
  const profile = volumeProfile([
    bar(0, 104, 100, 102, 400),
    bar(1, 102, 101, 101.5, 300),
    // No range: all of it lands at the close.
    bar(2, 103.5, 103.5, 103.5, 50),
    bar(3, 103, 101, 102, 0),
  ], 4, 0.7)!;
  expect(profile.rows.map((row) => row.volume)).toEqual([100, 400, 100, 150]);
  expect(profile.pocIndex).toBe(1);
  expect(profile.poc).toBe(101.5);
  expect(profile.totalVolume).toBe(750);
  // 400, then the tie between 100 below and 100 above goes up, then 150 above.
  expect(profile.rows.map((row) => row.valueArea)).toEqual([false, true, true, true]);
  expect(profile.rows[0]).toMatchObject({ low: 100, high: 101 });
  expect(volumeProfile([bar(0, 10, 9, 9.5, 0)], 4)).toBeNull();
});

const NASDAQ_5M = {
  historyResolution: "5m" as const,
  observationKind: "market" as const,
  dataShape: "ohlcv" as const,
  timeBasis: { kind: "market" as const, timeZone: "America/New_York", exchange: "NASDAQ", cadenceMs: 300_000 },
};

function ohlcv(iso: string, high: number, low: number, close: number, volume: number): TimeSeriesPoint {
  const date = new Date(iso);
  return { date, observedAt: date, value: close, open: close, high, low, close, volume };
}

function price(points: TimeSeriesPoint[], overrides: Partial<ResolvedSeries> = {}): ResolvedSeries {
  return createTestResolvedSeries({ id: "px", unitGroup: "price:USD", ...NASDAQ_5M, ...overrides, points });
}

function study(kind: ChartStudySpec["kind"], parameters: ChartStudySpec["parameters"] = {}): ChartStudySpec {
  return { id: kind, kind, inputSeriesIds: ["px"], parameters, panelId: "main", axis: "auto" };
}

const TWO_SESSIONS = [
  ohlcv("2026-09-29T13:30:00Z", 11, 9, 10, 100),
  ohlcv("2026-09-29T13:35:00Z", 12, 10, 11, 300),
  // 08:00 New York, before the next regular open: still the previous session.
  ohlcv("2026-09-30T12:00:00Z", 13, 11, 12, 100),
  ohlcv("2026-09-30T13:30:00Z", 21, 19, 20, 50),
];

describe("VWAP study", () => {
  test("resets at the regular open, not at midnight or the first pre-market bar", () => {
    const [vwap] = resolveStudies([price(TWO_SESSIONS)], [study("vwap")]).series;
    expect(vwap!.points.map((point) => point.value)).toEqual([10, 10.75, 11, 20]);
  });

  test("leaves out a first session whose open is before the loaded bars", () => {
    const [vwap] = resolveStudies([price(TWO_SESSIONS.slice(1))], [study("vwap")]).series;
    expect(vwap!.points.map((point) => point.date.toISOString())).toEqual(["2026-09-30T13:30:00.000Z"]);
  });

  test("adds bands at the chosen number of deviations", () => {
    const outputs = resolveStudies([price(TWO_SESSIONS)], [study("vwap", { bands: 2 })]).series;
    expect(outputs.map((output) => output.label)).toEqual(["VWAP", "VWAP +2σ", "VWAP -2σ"]);
    expect(outputs[1]!.points[1]!.value).toBeCloseTo(10.75 + 2 * Math.sqrt(0.1875), 10);
  });

  test("draws nothing on daily bars and says why", () => {
    const result = resolveStudies([price(TWO_SESSIONS, { historyResolution: "1d" })], [study("vwap")]);
    expect(result.series).toEqual([]);
    expect(result.warnings).toEqual(["VWAP needs intraday bars: choose 1D or 1W, or a minute timeframe."]);
  });
});

test("anchored VWAP draws one line per anchor and skips an anchor before the loaded history", () => {
  const anchors = [
    Date.parse("2026-09-29T13:35:00Z"),
    Date.parse("2026-09-30T13:30:00Z"),
    Date.parse("2026-09-28T15:00:00Z"),
  ];
  const result = resolveStudies([price(TWO_SESSIONS)], [study("anchored-vwap", withVwapAnchors({}, anchors))]);
  expect(result.series.map((output) => output.label)).toEqual(["AVWAP Sep 29 09:35", "AVWAP Sep 30 09:30"]);
  const [first, second] = result.series;
  expect(first!.points.map((point) => point.value)).toEqual([11, 11.25, 5500 / 450]);
  expect(second!.points.map((point) => point.value)).toEqual([20]);
  expect(result.warnings).toEqual(["AVWAP Sep 28 11:00 starts before the loaded history; choose a longer range."]);

  // Daily bars are stamped at midnight UTC: an anchor picked on the 09:35 bar
  // still starts on its own day.
  const daily = price([
    ohlcv("2026-09-28T00:00:00Z", 11, 9, 10, 100),
    ohlcv("2026-09-29T00:00:00Z", 12, 10, 11, 300),
    ohlcv("2026-09-30T00:00:00Z", 13, 11, 12, 100),
  ], { historyResolution: "1d", timeBasis: { ...NASDAQ_5M.timeBasis, cadenceMs: 86_400_000 } });
  const [onDaily] = resolveStudies([daily], [study("anchored-vwap", withVwapAnchors({}, [anchors[0]!]))]).series;
  expect(onDaily!.label).toBe("AVWAP Sep 29 2026");
  expect(onDaily!.points.map((point) => point.value)).toEqual([11, 11.25]);
});
