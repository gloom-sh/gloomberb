import { describe, expect, test } from "bun:test";
import type { ResolvedSeries, TimeSeriesPoint } from "../../../time-series/types";
import {
  compositeViewportHasObservations,
  panCompositeViewport,
  resolveCompositeChartInteraction,
  resolveCompositeMinimumSpanMs,
  resolveCompositeNavigationBounds,
  resolveCompositeWheelPanRatio,
  shouldResetCompositeViewport,
  zoomCompositeViewport,
  type CompositeViewportRange,
} from "./interactions";
import { buildCompositeTimeScale, projectCompositeTimestamp } from "./time-scale";
const DAY_MS = 24 * 60 * 60 * 1000;

function point(day: number): TimeSeriesPoint {
  const date = new Date(Date.UTC(2025, 0, day));
  return { date, observedAt: date, value: day };
}

function series(days: number[]): ResolvedSeries {
  return {
    id: "price",
    label: "Price",
    color: "#00ff66",
    unit: "USD",
    unitGroup: "currency",
    nativeFrequency: "daily",
    dataShape: "scalar",
    style: "line",
    transform: "raw",
    axis: "left",
    panelId: "main",
    interpolation: "none",
    points: days.map(point),
  };
}

function viewport(startDay: number, endDay: number): CompositeViewportRange {
  return {
    start: new Date(Date.UTC(2025, 0, startDay)),
    end: new Date(Date.UTC(2025, 0, endDay)),
  };
}

function intradayMarketSeries(): ResolvedSeries {
  const points: TimeSeriesPoint[] = [];
  for (const day of [2, 3]) {
    const sessionStart = Date.UTC(2025, 0, day, 13, 30);
    for (let index = 0; index < 78; index += 1) {
      const date = new Date(sessionStart + index * 5 * 60_000);
      points.push({ date, observedAt: date, value: 100 + points.length });
    }
  }
  return {
    ...series([]),
    nativeFrequency: "intraday",
    timeBasis: {
      kind: "market",
      timeZone: "America/New_York",
      cadenceMs: 5 * 60_000,
    },
    points,
  };
}

function marketSlotSpan(
  data: ResolvedSeries,
  bounds: CompositeViewportRange,
  view: CompositeViewportRange,
): number {
  const scale = buildCompositeTimeScale([data], bounds.start.getTime(), bounds.end.getTime());
  const start = projectCompositeTimestamp(scale, view.start.getTime())!.ratio;
  const end = projectCompositeTimestamp(scale, view.end.getTime())!.ratio;
  const positions = scale.kind === "market" ? scale.endPosition - scale.startPosition : 1;
  return (end - start) * positions;
}

describe("composite chart interactions", () => {
  test("zooms around the right edge and clamps zoom-out to loaded bounds", () => {
    const bounds = viewport(1, 11);
    const zoomed = zoomCompositeViewport(bounds, bounds, 2, 1, DAY_MS);

    expect(zoomed.start.toISOString()).toBe("2025-01-06T00:00:00.000Z");
    expect(zoomed.end.toISOString()).toBe("2025-01-11T00:00:00.000Z");
    expect(zoomCompositeViewport(zoomed, bounds, 0.1, 1, DAY_MS)).toEqual(bounds);
  });

  test("pans relative to the drag-start window without changing its span", () => {
    const bounds = viewport(1, 11);
    const visible = viewport(4, 8);

    const older = panCompositeViewport(visible, bounds, 0.5);
    expect(older).toEqual(viewport(2, 6));
    expect(older.end.getTime() - older.start.getTime()).toBe(visible.end.getTime() - visible.start.getTime());

    const clampedNewer = panCompositeViewport(visible, bounds, -10);
    expect(clampedNewer).toEqual(viewport(7, 11));
  });

  test("never changes the visible slot count while panning across a closed session", () => {
    const data = intradayMarketSeries();
    const bounds = resolveCompositeNavigationBounds([data])!;
    let visible: CompositeViewportRange = {
      start: new Date("2025-01-03T13:30:00.000Z"),
      end: new Date("2025-01-03T17:00:00.000Z"),
    };
    const slots = marketSlotSpan(data, bounds, visible);

    // A wall-clock shift changes how many market slots stay in view, which
    // renders as the plot squeezing shut instead of scrolling sideways.
    for (let step = 0; step < 4; step += 1) {
      visible = panCompositeViewport(visible, bounds, 0.5, [data]);
      expect(marketSlotSpan(data, bounds, visible)).toBeCloseTo(slots, 6);
    }
  });

  test("uses representative cadence instead of a stray fine gap as the zoom floor", () => {
    const data = series([1, 2, 5, 8, 11]);
    const bounds = resolveCompositeNavigationBounds([data]);
    expect(bounds).toEqual(viewport(1, 11));
    expect(resolveCompositeMinimumSpanMs([data], bounds!)).toBe(3 * DAY_MS);
  });

  test("keeps the selected window separate from wider loaded navigation bounds", () => {
    const data = series([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(resolveCompositeNavigationBounds([data], viewport(5, 9))).toEqual(viewport(1, 9));
  });

  test("reserves an older unloaded window without extending into the future", () => {
    const data = series([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const requested = viewport(5, 9);
    const bounds = resolveCompositeNavigationBounds(
      [data],
      requested,
      { historicalPaddingRatio: 1 },
    );

    expect(bounds).toEqual(viewport(-3, 9));
    expect(panCompositeViewport(requested, bounds!, 1, [data], true))
      .toEqual(viewport(1, 5));
    expect(panCompositeViewport(requested, bounds!, -10, [data], true))
      .toEqual(viewport(5, 9));
  });

  test("enters unloaded history from a full market-session viewport without changing span", () => {
    const data = intradayMarketSeries();
    const requested = {
      start: data.points[0]!.date,
      end: data.points.at(-1)!.date,
    };
    const bounds = resolveCompositeNavigationBounds(
      [data],
      requested,
      { historicalPaddingRatio: 1 },
    )!;

    const older = panCompositeViewport(requested, bounds, 1, [data], true);
    expect(older).not.toEqual(requested);
    expect(older.end.getTime()).toBe(requested.start.getTime());
    expect(marketSlotSpan(data, bounds, older))
      .toBeCloseTo(marketSlotSpan(data, bounds, requested), 6);
    expect(panCompositeViewport(older, bounds, -1, [data], true)).toEqual(requested);
  });

  test("clamps overlapping requested bounds to real data and keeps disjoint ones reachable", () => {
    const data = series([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    expect(resolveCompositeNavigationBounds([data], viewport(5, 12))).toEqual(viewport(1, 9));
    // Bounds equal to an observation-free window would strand pan and zoom
    // inside it, so a disjoint request stays unioned with the loaded data.
    expect(resolveCompositeNavigationBounds([data], viewport(20, 30))).toEqual(viewport(1, 30));
  });

  test("requires distinct renderable observations inside a viewport", () => {
    const data = series([1, 2, 3]);
    const emptyPoint = point(4);
    emptyPoint.value = null;
    data.points.push(emptyPoint);

    expect(compositeViewportHasObservations([data], viewport(1, 2))).toBe(true);
    expect(compositeViewportHasObservations([data], viewport(2, 2))).toBe(false);
    expect(compositeViewportHasObservations([data], viewport(3, 4))).toBe(false);
  });

  test("does not zoom or pan a populated viewport into fewer than two observations", () => {
    const data = series([1, 5, 10, 11]);
    const bounds = viewport(1, 11);
    const populated = viewport(1, 5);

    expect(zoomCompositeViewport(populated, bounds, 2, 0.5, 1, [data])).toEqual(populated);
    expect(panCompositeViewport(populated, bounds, -1, [data])).toEqual(populated);
    expect(panCompositeViewport(populated, bounds, -1.5, [data])).toEqual(viewport(7, 11));
  });

  test("allows zoom-out to recover when refreshed data has already emptied the viewport", () => {
    const data = series([1, 2, 10, 11]);
    const bounds = viewport(1, 11);
    const empty = viewport(5, 6);
    const expanded = zoomCompositeViewport(empty, bounds, 0.5, 0.5, 1, [data]);

    expect(expanded.end.getTime() - expanded.start.getTime()).toBe(2 * DAY_MS);
    expect(compositeViewportHasObservations([data], expanded)).toBe(false);
  });

  test("keeps live viewport drift but resets deliberate range/window changes", () => {
    const original = viewport(1, 11);
    const oneMinuteLater = {
      start: new Date(original.start.getTime() + 1_000),
      end: new Date(original.end.getTime() + 1_000),
    };
    const movedWindow = viewport(3, 13);
    const widerRange = viewport(1, 31);

    expect(shouldResetCompositeViewport(original, oneMinuteLater)).toBe(false);
    expect(shouldResetCompositeViewport(original, movedWindow)).toBe(true);
    expect(shouldResetCompositeViewport(original, widerRange)).toBe(true);
  });

  test("restores legacy keyboard aliases without stealing modified shortcuts", () => {
    expect(resolveCompositeChartInteraction({ name: "=", sequence: "+", shift: true })).toBe("zoom-in");
    expect(resolveCompositeChartInteraction({ name: "minus", sequence: "-", shift: false })).toBe("zoom-out");
    expect(resolveCompositeChartInteraction({ name: "left", shift: true })).toBe("pan-left");
    expect(resolveCompositeChartInteraction({ name: "right", shift: false })).toBe("cursor-right");
    expect(resolveCompositeChartInteraction({ name: "=", sequence: "+", ctrl: true })).toBeNull();
    expect(resolveCompositeChartInteraction({ name: "-", targetEditable: true })).toBeNull();
  });

  test("maps wheel directions to bounded horizontal pan increments", () => {
    expect(resolveCompositeWheelPanRatio("up", 1)).toBe(0.005);
    expect(resolveCompositeWheelPanRatio("left", 100)).toBe(0.04);
    expect(resolveCompositeWheelPanRatio("down", 100)).toBe(-0.04);
    expect(resolveCompositeWheelPanRatio("right", 0)).toBe(-0.005);
  });
});
