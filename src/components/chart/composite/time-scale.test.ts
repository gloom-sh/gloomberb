import { describe, expect, test } from "bun:test";
import type { ResolvedSeries, TimeSeriesPoint } from "../../../time-series/types";
import { createTestResolvedSeries, createTestSeriesPoint } from "../../../test-support/time-series";
import {
  buildCompositeTimeScale,
  compositeTimeProjector,
  projectCompositeTimestamp,
} from "./time-scale";

const HOUR_MS = 60 * 60 * 1_000;

const at = (timestamp: string | number) => createTestSeriesPoint(typeof timestamp === "number" ? new Date(timestamp) : timestamp);

/** A market series. With no cadence given, the bars' own spacing sets it. */
function marketSeries(points: TimeSeriesPoint[], basis: { timeZone?: string; cadenceMs?: number } = {}): ResolvedSeries {
  return createTestResolvedSeries({
    id: "primary",
    points,
    dataShape: "ohlcv",
    style: "candles",
    timeBasis: { kind: "market", timeZone: basis.timeZone ?? "America/New_York", ...(basis.cadenceMs ? { cadenceMs: basis.cadenceMs } : {}) },
  });
}

/** The same bars, copied, so no earlier build over the same history is there to patch. */
const afresh = (points: readonly TimeSeriesPoint[], basis?: { timeZone?: string; cadenceMs?: number }) => (
  marketSeries(points.map((point) => ({ ...point })), basis)
);

function layout(entry: ResolvedSeries) {
  const times = entry.points.map((point) => point.date.getTime());
  const scale = buildCompositeTimeScale([entry], Math.min(...times), Math.max(...times));
  if (scale.kind !== "market") throw new Error("expected a market scale");
  return { anchors: scale.anchors, cadenceMs: scale.cadenceMs, historyMsPerSlot: scale.historyMsPerSlot };
}

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

  // A live chart builds its scene again on every tick, over a new series that
  // shares its history with the last one: the anchors are patched from the
  // last build, and must come out as building them afresh does.
  test("a tick that moves or adds the last bar lays the anchors out as building them afresh does", () => {
    const history = [
      at("2025-01-03T14:30:00.000Z"),
      at("2025-01-03T15:00:00.000Z"),
      at("2025-01-03T16:00:00.000Z"),
      at("2025-01-06T14:30:00.000Z"),
    ];
    layout(marketSeries(history));
    for (const points of [
      // A bar in the session.
      [...history, at("2025-01-06T15:00:00.000Z")],
      // That bar moves: the bars' spacing, and with it the cadence, change.
      [...history, at("2025-01-06T15:10:00.000Z")],
      // The next session opens.
      [...history, at("2025-01-06T15:10:00.000Z"), at("2025-01-07T14:30:00.000Z")],
      // A bar goes.
      history.slice(0, 3),
    ]) {
      expect(layout(marketSeries(points))).toEqual(layout(afresh(points)));
    }
    // A live tick that moves the last bar on the series it already drew.
    const live = marketSeries([...history, at("2025-01-06T15:00:00.000Z")]);
    layout(live);
    live.points[live.points.length - 1] = at("2025-01-06T15:20:00.000Z");
    expect(layout(live)).toEqual(layout(afresh(live.points)));
    // Daily bars, each its own session, and a live point at the quote's time.
    const days = ["2025-01-02", "2025-01-03", "2025-01-06", "2025-01-07"].map((day) => at(`${day}T21:00:00.000Z`));
    layout(marketSeries(days));
    for (const quoteTime of ["2025-01-08T15:00:00.000Z", "2025-01-08T15:00:05.000Z", "2025-01-08T20:00:00.000Z"]) {
      const points = [...days, at(quoteTime)];
      expect(layout(marketSeries(points))).toEqual(layout(afresh(points)));
    }
  });

  // What the patch keeps holds only for the same zone and cadence, and is
  // not worth keeping when most of the bars changed; bars out of order are
  // put in order first.
  test("a tick past what a patch is worth, in another zone or cadence, or over bars out of order lays the anchors out afresh", () => {
    // Three sessions of half-hour bars from the New York open.
    const history = ["2025-01-06", "2025-01-07", "2025-01-08"].flatMap((day) => Array.from(
      { length: 13 },
      (_, index) => at(Date.parse(`${day}T14:30:00.000Z`) + index * 30 * 60_000),
    ));
    const tick = [...history, at("2025-01-08T21:00:00.000Z")];
    layout(marketSeries(history));
    // The last two sessions move by ten minutes: more bars than a patch is worth.
    const shifted = [...history.slice(0, 13), ...history.slice(13).map((point) => at(point.date.getTime() + 10 * 60_000))];
    expect(layout(marketSeries(shifted))).toEqual(layout(afresh(shifted)));
    // Read in Tokyo, each New York session spans two dates.
    layout(marketSeries(history));
    expect(layout(marketSeries(tick, { timeZone: "Asia/Tokyo" }))).toEqual(layout(afresh(tick, { timeZone: "Asia/Tokyo" })));
    // A cadence set where the bars' spacing set it before.
    layout(marketSeries(history));
    expect(layout(marketSeries(tick, { cadenceMs: 15 * 60_000 }))).toEqual(layout(afresh(tick, { cadenceMs: 15 * 60_000 })));
    // Bars out of order, one of them twice, lay out as the bars in order, and so does a tick over them.
    const shuffled = [history[2]!, history[0]!, history[1]!, history[1]!, ...history.slice(3)];
    expect(layout(marketSeries(shuffled))).toEqual(layout(afresh(history)));
    expect(layout(marketSeries([...shuffled, tick.at(-1)!]))).toEqual(layout(afresh(tick)));
  });

  test("projecting a run of times, in order or out of it, places each where projecting it alone does", () => {
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
    const times = [
      Date.parse("2025-01-03T12:00:00.000Z"),
      ...timestamps.map(Date.parse),
      Date.parse("2025-01-03T14:30:00.000Z"),
      Date.parse("2025-01-04T12:00:00.000Z"),
      Date.parse("2025-01-06T15:00:00.000Z"),
      Date.parse("2025-01-07T12:00:00.000Z"),
    ].sort((left, right) => left - right);
    for (const placement of ["timestamp", "next-market-slot"] as const) {
      for (const run of [times, [...times].reverse()]) {
        const project = compositeTimeProjector(scale, placement);
        for (const time of run) expect(project(time)).toEqual(projectCompositeTimestamp(scale, time, placement));
      }
    }
  });
});
