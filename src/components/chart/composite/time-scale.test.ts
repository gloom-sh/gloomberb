import { describe, expect, test } from "bun:test";
import type { ResolvedSeries } from "../../../time-series/types";
import { createTestResolvedSeries, createTestSeriesPoint } from "../../../test-support/time-series";
import {
  buildCompositeTimeScale,
  projectCompositeTimestamp,
} from "./time-scale";

const HOUR_MS = 60 * 60 * 1_000;

function series(timestamps: string[], market = false): ResolvedSeries {
  return createTestResolvedSeries({
    id: "primary",
    label: "Primary",
    color: "#fff",
    unitGroup: "price",
    dataShape: "ohlcv",
    style: "candles",
    timeBasis: market
      ? { kind: "market", timeZone: "America/New_York", cadenceMs: HOUR_MS }
      : undefined,
    points: timestamps.map((timestamp) => createTestSeriesPoint(timestamp)),
  });
}

describe("composite time scale", () => {
  test("compresses closed sessions while retaining an in-session missing-bar gap", () => {
    const timestamps = [
      "2025-01-03T14:00:00.000Z",
      "2025-01-03T15:00:00.000Z",
      "2025-01-03T16:00:00.000Z",
      "2025-01-06T14:00:00.000Z",
      "2025-01-06T16:00:00.000Z",
    ];
    const scale = buildCompositeTimeScale(
      [series(timestamps, true)],
      Date.parse(timestamps[0]!),
      Date.parse(timestamps.at(-1)!),
    );

    expect(scale.kind).toBe("market");
    if (scale.kind !== "market") return;
    expect(scale.anchors.map(({ position }) => position)).toEqual([0, 1, 2, 3, 5]);
    expect(projectCompositeTimestamp(scale, Date.parse(timestamps[2]!))?.ratio).toBeCloseTo(0.4);
    expect(projectCompositeTimestamp(scale, Date.parse(timestamps[3]!))?.ratio).toBeCloseTo(0.6);
  });

  test("snaps weekend availability forward and leaves calendar-only charts linear", () => {
    const marketTimestamps = [
      "2025-01-03T16:00:00.000Z",
      "2025-01-06T14:00:00.000Z",
      "2025-01-06T15:00:00.000Z",
    ];
    const marketScale = buildCompositeTimeScale(
      [series(marketTimestamps, true)],
      Date.parse(marketTimestamps[0]!),
      Date.parse(marketTimestamps.at(-1)!),
    );
    const weekend = projectCompositeTimestamp(
      marketScale,
      Date.parse("2025-01-04T12:00:00.000Z"),
      "next-market-slot",
    );
    expect(weekend?.xSlot).toBe(1);
    expect(weekend?.ratio).toBeCloseTo(0.5);

    const calendarScale = buildCompositeTimeScale(
      [series([], false)],
      Date.parse("2025-01-04T00:00:00.000Z"),
      Date.parse("2025-01-06T00:00:00.000Z"),
    );
    expect(calendarScale.kind).toBe("calendar");
    expect(projectCompositeTimestamp(
      calendarScale,
      Date.parse("2025-01-05T00:00:00.000Z"),
    )?.ratio).toBe(0.5);
  });
});
