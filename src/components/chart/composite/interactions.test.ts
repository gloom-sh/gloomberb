import { describe, expect, test } from "bun:test";
import type { ResolvedSeries, TimeSeriesPoint } from "../../../time-series/types";
import {
  buildCompositeNavigationFrame,
  clampCompositeViewport,
  compositeViewportPositions,
  fitCompositeViewport,
  panCompositeViewport,
  resolveCompositeChartInteraction,
  resolveCompositeWheelPan,
  resolveCompositeWheelZoom,
  shouldResetCompositeViewport,
  zoomCompositeViewport,
  type CompositeNavigationFrame,
  type CompositeViewportRange,
} from "./interactions";
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

function slotSpan(frame: CompositeNavigationFrame, view: CompositeViewportRange): number {
  const positions = compositeViewportPositions(frame, view)!;
  return positions.end - positions.start;
}

function frameFor(
  data: ResolvedSeries,
  options?: { historicalPaddingRatio?: number },
): CompositeNavigationFrame {
  return buildCompositeNavigationFrame([data], [data], options)!;
}

describe("composite chart interactions", () => {
  test("zooms around the right edge and clamps zoom-out to the loaded data", () => {
    const frame = frameFor(series([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]));
    const full = viewport(1, 11);
    const zoomed = zoomCompositeViewport(frame, full, 2, 1);

    expect(zoomed).toEqual(viewport(6, 11));
    expect(zoomCompositeViewport(frame, zoomed, 0.1, 1)).toEqual(full);
  });

  test("pans by positions and stops at the newest observation", () => {
    const frame = frameFor(series([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]));
    const visible = viewport(4, 8);

    const older = panCompositeViewport(frame, visible, 2 * DAY_MS);
    expect(older).toEqual(viewport(2, 6));

    expect(panCompositeViewport(frame, visible, -40 * DAY_MS)).toEqual(viewport(7, 11));
  });

  test("never changes the visible slot count while panning across a closed session", () => {
    const data = intradayMarketSeries();
    const frame = frameFor(data);
    let visible: CompositeViewportRange = {
      start: new Date("2025-01-03T13:30:00.000Z"),
      end: new Date("2025-01-03T17:00:00.000Z"),
    };
    const slots = slotSpan(frame, visible);

    // A wall-clock shift changes how many market slots stay in view, which
    // renders as the plot squeezing shut instead of scrolling sideways.
    for (let step = 0; step < 4; step += 1) {
      visible = panCompositeViewport(frame, visible, slots / 2);
      expect(slotSpan(frame, visible)).toBeCloseTo(slots, 6);
    }
  });

  test("uses the representative cadence, not a stray fine gap, as the zoom floor", () => {
    const frame = frameFor(series([1, 2, 5, 8, 11]));
    expect(frame.minimumSpanMs).toBe(2 * 3 * DAY_MS);

    const tight = zoomCompositeViewport(frame, viewport(1, 11), 1_000, 0.5);
    expect(tight.end.getTime() - tight.start.getTime()).toBe(frame.minimumSpanMs);
  });

  test("lets a backfilling chart pan half a screen before the first observation, never after the last", () => {
    const data = series([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const requested = viewport(5, 9);
    const frame = frameFor(data, { historicalPaddingRatio: 0.5 });

    expect(panCompositeViewport(frame, requested, 100 * DAY_MS)).toEqual(viewport(-1, 3));
    expect(panCompositeViewport(frame, requested, -100 * DAY_MS)).toEqual(viewport(5, 9));
    expect(panCompositeViewport(frameFor(data), requested, 100 * DAY_MS)).toEqual(viewport(1, 5));
  });

  test("enters unloaded history from a full market-session viewport without changing span", () => {
    const data = intradayMarketSeries();
    const requested = {
      start: data.points[0]!.date,
      end: data.points.at(-1)!.date,
    };
    const frame = frameFor(data, { historicalPaddingRatio: 1 });
    const slots = slotSpan(frame, requested);

    const older = panCompositeViewport(frame, requested, slots);
    expect(older).not.toEqual(requested);
    expect(older.end.getTime()).toBe(requested.start.getTime());
    expect(slotSpan(frame, older)).toBeCloseTo(slots, 6);
    expect(panCompositeViewport(frame, older, -slots)).toEqual(requested);
  });

  test("fits an authored window onto the data it overlaps and leaves a disjoint one alone", () => {
    const frame = frameFor(series([1, 2, 3, 4, 5, 6, 7, 8, 9]));

    expect(clampCompositeViewport(frame, viewport(5, 12))).toEqual(viewport(2, 9));
    expect(clampCompositeViewport(frame, viewport(0, 30))).toEqual(viewport(1, 9));
    // An observation-free window keeps its date axis so navigation can bring
    // it back; fitting it to the data would silently teleport the chart.
    expect(clampCompositeViewport(frame, viewport(20, 30))).toEqual(viewport(20, 30));
    expect(fitCompositeViewport(frame, viewport(20, 30))).toEqual(viewport(1, 9));
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

  test("arms chart tools from either shifted key encoding", () => {
    // Kitty keyboard protocol reports the modifier; legacy terminals only send
    // the uppercase letter.
    expect(resolveCompositeChartInteraction({ name: "m", shift: true })).toBe("arm-measure");
    expect(resolveCompositeChartInteraction({ name: "M", sequence: "M" })).toBe("arm-measure");
    expect(resolveCompositeChartInteraction({ name: "z", shift: true })).toBe("arm-zoom");
    expect(resolveCompositeChartInteraction({ name: "Z", sequence: "Z" })).toBe("arm-zoom");
    expect(resolveCompositeChartInteraction({ name: "d", shift: true })).toBe("arm-line");
    expect(resolveCompositeChartInteraction({ name: "P", sequence: "P" })).toBe("arm-pencil");
    expect(resolveCompositeChartInteraction({ name: "backspace" })).toBe("delete-drawing");
    expect(resolveCompositeChartInteraction({ name: "c" })).toBe("cycle-colour");
    // Unshifted m and z stay with the pane that already owns them.
    expect(resolveCompositeChartInteraction({ name: "m" })).toBeNull();
    expect(resolveCompositeChartInteraction({ name: "z" })).toBeNull();
  });

  test("pans by the pixels travelled on pixel hosts and by bounded notches elsewhere", () => {
    // A diagonal swipe sums both axes instead of flickering between them.
    expect(resolveCompositeWheelPan({ direction: "right", delta: 30, deltaX: 30, deltaY: 10 }, 400)).toBe(-0.1);
    expect(resolveCompositeWheelPan({ direction: "up", delta: 20, deltaX: 0, deltaY: -20 }, 400)).toBe(0.05);
    expect(resolveCompositeWheelPan({ direction: "up", delta: 1 }, 400)).toBe(0.005);
    expect(resolveCompositeWheelPan({ direction: "left", delta: 100 }, 400)).toBe(0.04);
    expect(resolveCompositeWheelPan({ direction: "right", delta: 0 }, 400)).toBe(-0.005);
  });

  test("zooms continuously from pinch deltas and by fixed steps from notches", () => {
    expect(resolveCompositeWheelZoom({ direction: "up", delta: 16, deltaX: 0, deltaY: -16 })).toBeCloseTo(Math.exp(0.1), 6);
    expect(resolveCompositeWheelZoom({ direction: "down", delta: 1_000, deltaX: 0, deltaY: 1_000 })).toBeCloseTo(1 / 1.5, 6);
    expect(resolveCompositeWheelZoom({ direction: "up", delta: 4 })).toBeCloseTo(1.16, 6);
    expect(resolveCompositeWheelZoom({ direction: "down", delta: 100 })).toBeCloseTo(1 / 1.32, 6);
  });
});
