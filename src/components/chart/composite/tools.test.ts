import { describe, expect, it } from "bun:test";
import {
  buildChartToolVectors,
  CHART_DRAWING_COLORS,
  countMeasureBars,
  drawChartToolOverlay,
  hitTestDrawings,
  nextDrawingColor,
  shiftDrawing,
  formatMeasureSpan,
  resolveChartToolKind,
  resolveDrawingFromDrag,
  resolveZoomBoxRange,
  summarizeMeasure,
} from "./tools";
import type {
  CompositeAxisDomain,
  CompositeChartScene,
  CompositePanelScene,
} from "./types";

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
      path: [],
    }, DAY)).toBeNull();
  });

  it("orders a right-to-left drag", () => {
    const range = resolveZoomBoxRange(scene, {
      kind: "zoom",
      startXRatio: 0.8,
      startYRatio: 0,
      endXRatio: 0.2,
      endYRatio: 1,
      path: [],
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
      path: [],
    }, DAY);
    expect(range).not.toBeNull();
    expect(range!.end.getTime() - range!.start.getTime()).toBe(DAY);
    expect((range!.start.getTime() + range!.end.getTime()) / 2).toBe(START + 5.1 * DAY);
  });
});

describe("chart drawings", () => {
  const panel: CompositePanelScene = {
    id: "main",
    height: 10,
    scale: "linear",
    axes: { left: { ...domain, side: "left" } },
    series: [{
      source: { id: "a", axis: "left" } as never,
      points: [],
    }],
  };

  it("anchors a drawing to the data under the drag, not to the pixels", () => {
    const scene = calendarScene(10 * DAY);
    const drawing = resolveDrawingFromDrag(scene, panel, {
      kind: "line",
      startXRatio: 0.2,
      startYRatio: 0.25,
      endXRatio: 0.8,
      endYRatio: 0.75,
      path: [],
    }, "#ffcc00", "d1");

    expect(drawing?.points[0]?.time).toBe(START + 2 * DAY);
    expect(drawing?.points[1]?.time).toBe(START + 8 * DAY);
    // yRatio runs top-down, so 0.25 is three quarters up a 0..200 axis.
    expect(drawing?.points[0]?.value).toBeCloseTo(150, 6);
    expect(drawing?.points[1]?.value).toBeCloseTo(50, 6);
  });

  it("redraws a stored line through the current viewport", () => {
    const scene = calendarScene(10 * DAY);
    const drawing = resolveDrawingFromDrag(scene, panel, {
      kind: "line",
      startXRatio: 0,
      startYRatio: 0.5,
      endXRatio: 1,
      endYRatio: 0.5,
      path: [],
    }, "#ffcc00", "d1")!;
    const base = {
      width: 21,
      height: 11,
      pixels: new Uint8Array(21 * 11 * 4),
    };
    const painted = drawChartToolOverlay(base, null, {
      positive: "#00ff00",
      negative: "#ff0000",
      zoom: "#8888ff",
      draw: "#ffcc00",
    }, "up", { scene, panel, items: [drawing] });
    const alphaAt = (x: number, y: number) => painted.pixels[(y * 21 + x) * 4 + 3]!;

    // A flat line at the middle value paints the middle row and nothing else.
    expect(alphaAt(10, 5)).toBeGreaterThan(0);
    expect(alphaAt(10, 0)).toBe(0);

    // Halving the visible span pushes the same anchors off both edges.
    const zoomed: CompositeChartScene = {
      ...scene,
      startTime: START + 2 * DAY,
      endTime: START + 7 * DAY,
      timeScale: { kind: "calendar", startTime: START + 2 * DAY, endTime: START + 7 * DAY },
    };
    const rezoomed = drawChartToolOverlay(base, null, {
      positive: "#00ff00",
      negative: "#ff0000",
      zoom: "#8888ff",
      draw: "#ffcc00",
    }, "up", { scene: zoomed, panel, items: [drawing] });
    expect(rezoomed.pixels[(5 * 21 + 10) * 4 + 3]!).toBeGreaterThan(0);
  });
});

describe("editing drawings", () => {
  const panel: CompositePanelScene = {
    id: "main",
    height: 10,
    scale: "linear",
    axes: { left: { ...domain, side: "left" } },
    series: [{ source: { id: "a", axis: "left" } as never, points: [] }],
  };
  const scene = calendarScene(10 * DAY);
  const line = {
    id: "line-1",
    panelId: "main",
    color: CHART_DRAWING_COLORS[0],
    points: [
      { time: START + 2 * DAY, value: 150 },
      { time: START + 8 * DAY, value: 50 },
    ],
  };

  it("grabs an endpoint before the body, and misses outside the slack", () => {
    expect(hitTestDrawings([line], scene, panel, { xRatio: 0.2, yRatio: 0.25 }))
      .toMatchObject({ pointIndex: 0 });
    expect(hitTestDrawings([line], scene, panel, { xRatio: 0.5, yRatio: 0.5 }))
      .toMatchObject({ pointIndex: null });
    expect(hitTestDrawings([line], scene, panel, { xRatio: 0.5, yRatio: 0.9 })).toBeNull();
  });

  it("leaves drawings that belong to another panel alone", () => {
    const other = { ...line, panelId: "volume" };
    expect(hitTestDrawings([other], scene, panel, { xRatio: 0.2, yRatio: 0.25 })).toBeNull();
  });

  it("moves a whole shape, or just the grabbed end", () => {
    const moved = shiftDrawing(line, scene, panel, 0.1, 0, null);
    expect(moved.points[0]!.time).toBe(START + 3 * DAY);
    expect(moved.points[1]!.time).toBe(START + 9 * DAY);

    const reshaped = shiftDrawing(line, scene, panel, 0, 0.25, 1);
    expect(reshaped.points[0]!.value).toBeCloseTo(150, 6);
    expect(reshaped.points[1]!.value).toBeCloseTo(0, 6);
  });

  it("cycles colours and wraps", () => {
    expect(nextDrawingColor(CHART_DRAWING_COLORS[0])).toBe(CHART_DRAWING_COLORS[1]);
    expect(nextDrawingColor(CHART_DRAWING_COLORS.at(-1)!)).toBe(CHART_DRAWING_COLORS[0]);
    expect(nextDrawingColor("#000000")).toBe(CHART_DRAWING_COLORS[0]);
  });
});

describe("vector overlays", () => {
  const panel: CompositePanelScene = {
    id: "main",
    height: 10,
    scale: "linear",
    axes: { left: { ...domain, side: "left" } },
    series: [{ source: { id: "a", axis: "left" } as never, points: [] }],
  };
  const scene = calendarScene(10 * DAY);
  const colors = { positive: "#0f0", negative: "#f00", zoom: "#00f", draw: "#ff0" };

  it("spans the full height for a zoom selection and boxes a measurement", () => {
    const zoom = buildChartToolVectors({
      scene,
      panel,
      drawings: [],
      selectedId: null,
      colors,
      direction: "up",
      drag: { kind: "zoom", startXRatio: 0.2, startYRatio: 0.4, endXRatio: 0.6, endYRatio: 0.9, path: [] },
    });
    expect(zoom[0]).toMatchObject({ box: true, points: [{ x: 0.2, y: 0 }, { x: 0.6, y: 1 }] });

    const measure = buildChartToolVectors({
      scene,
      panel,
      drawings: [],
      selectedId: null,
      colors,
      direction: "down",
      drag: { kind: "measure", startXRatio: 0.2, startYRatio: 0.4, endXRatio: 0.6, endYRatio: 0.9, path: [] },
    });
    expect(measure[0]).toMatchObject({ box: true, color: "#f00" });
    expect(measure[1]!.points).toEqual([{ x: 0.2, y: 0.4 }, { x: 0.6, y: 0.9 }]);
  });

  it("gives handles to the selected line only", () => {
    const line = {
      id: "line-1",
      panelId: "main",
      color: "#ff0",
      points: [
        { time: START + 2 * DAY, value: 150 },
        { time: START + 8 * DAY, value: 50 },
      ],
    };
    const [unselected] = buildChartToolVectors({
      scene, panel, drawings: [line], selectedId: null, colors, direction: "up", drag: null,
    });
    const [selected] = buildChartToolVectors({
      scene, panel, drawings: [line], selectedId: "line-1", colors, direction: "up", drag: null,
    });
    expect(unselected?.handles).toBe(false);
    expect(selected?.handles).toBe(true);
    expect(selected?.points).toEqual([{ x: 0.2, y: 0.25 }, { x: 0.8, y: 0.75 }]);
  });
});
