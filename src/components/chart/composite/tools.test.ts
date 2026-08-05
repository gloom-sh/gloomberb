import { describe, expect, it } from "bun:test";
import {
  countMeasureBars,
  formatMeasureSpan,
  resolveChartToolKind,
  resolveZoomBoxRange,
  summarizeMeasure,
} from "./tools";
import type { CompositeAxisDomain, CompositeChartScene } from "./types";

const domain: CompositeAxisDomain = {
  side: "right",
  min: 0,
  max: 200,
  scale: "linear",
  unit: "USD",
  unitGroup: "currency",
  seriesIds: ["a"],
};

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 0, 1);

function calendarScene(spanMs: number): CompositeChartScene {
  return {
    width: 100,
    height: 20,
    startTime: START,
    endTime: START + spanMs,
    timeScale: { kind: "calendar", startTime: START, endTime: START + spanMs },
    dates: [],
    dateRatios: [],
    panels: [],
    cursorDate: null,
    cursorXRatio: null,
    cursorValues: [],
  };
}

describe("resolveChartToolKind", () => {
  it("leaves plain and ctrl drags to pan and wheel zoom", () => {
    expect(resolveChartToolKind({ shift: false, alt: false, ctrl: false })).toBeNull();
    expect(resolveChartToolKind({ shift: true, alt: false, ctrl: true })).toBeNull();
  });

  it("maps shift to zoom and alt to measure", () => {
    expect(resolveChartToolKind({ shift: true, alt: false, ctrl: false })).toBe("zoom");
    expect(resolveChartToolKind({ shift: false, alt: true, ctrl: false })).toBe("measure");
    expect(resolveChartToolKind({ shift: true, alt: true, ctrl: false })).toBe("zoom");
  });
});

describe("summarizeMeasure", () => {
  it("reports signed change, percent, bars, and span", () => {
    expect(summarizeMeasure({
      startValue: 100,
      endValue: 110,
      startTime: START,
      endTime: START + 3 * DAY,
      bars: 3,
      domain,
    })).toBe("Δ +$10.0 (+10.00%) · 3 bars · 3d");
  });

  it("keeps the percentage signed when measuring downward", () => {
    expect(summarizeMeasure({
      startValue: 110,
      endValue: 99,
      startTime: START,
      endTime: START + DAY,
      bars: 1,
      domain,
    })).toBe("Δ -$11.0 (-10.00%) · 1 bar · 1d");
  });

  it("drops the percentage when the baseline is zero or flips sign", () => {
    const fromZero = summarizeMeasure({
      startValue: 0,
      endValue: 5,
      startTime: START,
      endTime: START + DAY,
      bars: 0,
      domain,
    });
    expect(fromZero).toBe("Δ +$5.00 · 1d");
    const acrossZero = summarizeMeasure({
      startValue: -4,
      endValue: 6,
      startTime: START,
      endTime: START + DAY,
      bars: 0,
      domain,
    });
    expect(acrossZero).not.toContain("%");
  });

  it("reports a percentage relative to the magnitude of a negative baseline", () => {
    const summary = summarizeMeasure({
      startValue: -100,
      endValue: -80,
      startTime: START,
      endTime: START + DAY,
      bars: 0,
      domain,
    });
    expect(summary).toContain("(+20.00%)");
  });
});

describe("formatMeasureSpan", () => {
  it("scales the unit to the span", () => {
    expect(formatMeasureSpan(45_000)).toBe("45s");
    expect(formatMeasureSpan(90 * 60_000)).toBe("1h 30m");
    expect(formatMeasureSpan(2 * DAY + 3 * 60 * 60_000)).toBe("2d 3h");
    expect(formatMeasureSpan(30 * DAY)).toBe("30d");
  });
});

describe("countMeasureBars", () => {
  it("counts observations inside the drag regardless of direction", () => {
    const dates = [0, 1, 2, 3, 4].map((day) => new Date(START + day * DAY));
    expect(countMeasureBars(dates, START, START + 2 * DAY)).toBe(3);
    expect(countMeasureBars(dates, START + 2 * DAY, START)).toBe(3);
  });
});

describe("resolveZoomBoxRange", () => {
  const scene = calendarScene(10 * DAY);

  it("ignores a modifier-held click", () => {
    expect(resolveZoomBoxRange(scene, {
      kind: "zoom",
      startXRatio: 0.5,
      startYRatio: 0.5,
      endXRatio: 0.501,
      endYRatio: 0.5,
    }, DAY)).toBeNull();
  });

  it("orders a right-to-left drag", () => {
    const range = resolveZoomBoxRange(scene, {
      kind: "zoom",
      startXRatio: 0.8,
      startYRatio: 0,
      endXRatio: 0.2,
      endYRatio: 1,
    }, DAY);
    expect(range?.start.getTime()).toBe(START + 2 * DAY);
    expect(range?.end.getTime()).toBe(START + 8 * DAY);
  });

  it("widens a selection below the smallest resolvable span", () => {
    const range = resolveZoomBoxRange(scene, {
      kind: "zoom",
      startXRatio: 0.5,
      startYRatio: 0,
      endXRatio: 0.52,
      endYRatio: 1,
    }, DAY);
    expect(range).not.toBeNull();
    expect(range!.end.getTime() - range!.start.getTime()).toBe(DAY);
    expect((range!.start.getTime() + range!.end.getTime()) / 2).toBe(START + 5.1 * DAY);
  });
});
