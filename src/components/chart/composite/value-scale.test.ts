import { describe, expect, test } from "bun:test";
import { buildCompositeChartScene, projectCompositeValue } from "./scene";
import { renderCompositePanelBitmap } from "./rasterizer";
import { renderCompositePanelText } from "./text-renderer";
import {
  clipSegmentToBand,
  panValueRange,
  resolveAxisDragSpanFactor,
  valueScaleSlot,
  zoomValueRange,
  type CompositeValueScales,
} from "./value-scale";
import { createTestResolvedSeries as series, createTestSeriesPoint as point } from "../../../test-support/time-series";

const linear = { min: 100, max: 200 };

/** Where `value` sits down the panel, 0 at the top and 1 at the bottom. */
function heightOf(value: number, range: { min: number; max: number }, scale: "linear" | "log" = "linear"): number {
  return projectCompositeValue(value, { side: "right", ...range, scale, unit: "", unitGroup: "", seriesIds: [] })!;
}

describe("value axis gestures", () => {
  test("a drag up stretches the axis, down squeezes it, and the way back undoes it", () => {
    const stretched = zoomValueRange(linear, "linear", resolveAxisDragSpanFactor(-120), 0.5);
    expect(stretched.max - stretched.min).toBeLessThan(100);
    // Around the middle: the value there stays there.
    expect((stretched.max + stretched.min) / 2).toBeCloseTo(150, 9);
    const squeezed = zoomValueRange(linear, "linear", resolveAxisDragSpanFactor(120), 0.5);
    expect(squeezed.max - squeezed.min).toBeGreaterThan(100);
    const back = zoomValueRange(stretched, "linear", resolveAxisDragSpanFactor(120), 0.5);
    expect(back.min).toBeCloseTo(100, 9);
    expect(back.max).toBeCloseTo(200, 9);
  });

  test("the wheel stretches around the value under the pointer, in log space on a log axis", () => {
    const nearTop = zoomValueRange(linear, "linear", 0.5, 0.2);
    expect(heightOf(180, nearTop)).toBeCloseTo(0.2, 9);
    expect(nearTop.max - nearTop.min).toBeCloseTo(50, 9);

    const log = { min: 10, max: 1000 };
    const zoomed = zoomValueRange(log, "log", 0.5, 0.5);
    // The geometric middle stays put and the axis shows one decade, not half the values.
    expect(Math.sqrt(zoomed.min * zoomed.max)).toBeCloseTo(100, 6);
    expect(zoomed.max / zoomed.min).toBeCloseTo(10, 6);
    expect(heightOf(100, zoomed, "log")).toBeCloseTo(0.5, 9);
  });

  test("a drag on a hand-scaled plot keeps the value under the pointer under it", () => {
    for (const scale of ["linear", "log"] as const) {
      const moved = panValueRange(linear, scale, 0.25);
      // The value at 40% down is now at 65% down: it followed the pointer.
      const before = scale === "log" ? Math.exp(Math.log(200) - (Math.log(200) - Math.log(100)) * 0.4) : 200 - 100 * 0.4;
      expect(heightOf(before, moved, scale)).toBeCloseTo(0.65, 9);
    }
  });

  test("a segment leaving the plot is cut at its edge, along the same line", () => {
    expect(clipSegmentToBand(0, 5, 10, 15, 0, 9)).toEqual([0, 5, 4, 9]);
    expect(clipSegmentToBand(0, -1e9, 10, 5, 0, 9)![2]).toBe(10);
    expect(clipSegmentToBand(0, -5, 10, -1, 0, 9)).toBeNull();
  });
});

describe("a hand-scaled axis in the scene", () => {
  const price = series({
    id: "price",
    label: "ALFA",
    axis: "right",
    timeBasis: { kind: "market", timeZone: "America/New_York" },
    points: [point("2026-01-05", 100), point("2026-01-06", 120), point("2026-01-07", 110)],
  });
  const build = (valueScales?: CompositeValueScales, list = [price]) => buildCompositeChartScene(list, [{ id: "main" }], {
    width: 100, height: 20, valueScales,
  })!;
  const fitted = build();
  const key = fitted.panels[0]!.axes.right!.scaleKey!;

  test("draws in the range set by hand and says so, while the axis plots the same series", () => {
    const scene = build({ [valueScaleSlot("main", "right")]: { key, min: 105, max: 115 } });
    const axis = scene.panels[0]!.axes.right!;
    expect([axis.min, axis.max, axis.manual]).toEqual([105, 115, true]);
    expect(scene.panels[0]!.series[0]!.points.map((entry) => entry.yRatio)).toEqual([1.5, -0.5, 0.5]);
    // The last close (110) is on the axis; the fitted one never says manual.
    expect(scene.panels[0]!.lastPrice?.yRatio).toBe(0.5);
    expect(fitted.panels[0]!.axes.right!.manual).toBeUndefined();

    const another = series({ ...price, id: "other", label: "BRVO" });
    expect(build({ [valueScaleSlot("main", "right")]: { key, min: 105, max: 115 } }, [another]).panels[0]!.axes.right!.manual).toBeUndefined();
  });

  test("fits the data again once the range set by hand holds none of it, and leaves an off-axis last close off", () => {
    const clear = build({ [valueScaleSlot("main", "right")]: { key, min: 500, max: 600 } });
    expect(clear.panels[0]!.axes.right!.manual).toBeUndefined();
    const below = build({ [valueScaleSlot("main", "right")]: { key, min: 112, max: 140 } });
    expect(below.panels[0]!.axes.right!.manual).toBe(true);
    expect(below.panels[0]!.lastPrice).toBeUndefined();
  });

  test("clips lines at the edge instead of flattening them onto it, in pixels and in cells", () => {
    const scene = build({ [valueScaleSlot("main", "right")]: { key, min: 105, max: 115 } });
    const panel = { ...scene.panels[0]!, height: 5, lineCues: undefined };
    const colors = { background: "#000000", grid: "#000000", crosshair: "#ffffff", text: "#ffffff", textDim: "#888888", negative: "#ff0000" };
    const bitmap = renderCompositePanelBitmap(panel, { pixelWidth: 40, pixelHeight: 20, colors });
    const lit = (row: number) => {
      let count = 0;
      for (let x = 0; x < 40; x += 1) if (bitmap.pixels[(row * 40 + x) * 4]! > 40) count += 1;
      return count;
    };
    // 100 and 120 are off the panel: the line crosses each edge once, it does not run along it.
    expect(lit(0)).toBeLessThan(8);
    expect(lit(19)).toBeLessThan(8);
    const text = renderCompositePanelText(panel, 20, null, null);
    expect(text[0]!.replace(/[^•]/g, "").length).toBeLessThan(4);
    expect(text[4]!.replace(/[^•]/g, "").length).toBeLessThan(4);
  });
});
