import { describe, expect, test } from "bun:test";
import type { ResolvedSeries } from "../../../time-series/types";
import { createTestResolvedSeries, createTestSeriesPoint as point } from "../../../test-support/time-series";
import { renderCompositePanelBitmap } from "./rasterizer";
import { buildCompositeChartScene } from "./scene";
import { assignSeriesLineCues } from "./series-cues";

function line(id: string, values: number[], style: ResolvedSeries["style"] = "line", color = "#ff0000"): ResolvedSeries {
  return createTestResolvedSeries({
    id,
    style,
    color,
    points: values.map((value, index) => point(new Date(Date.UTC(2025, 0, 1 + index)), value)),
  });
}

describe("series line cues", () => {
  test("only a chart with two or more lines gets cues, counted in legend order with hidden lines", () => {
    expect(assignSeriesLineCues([line("price", [1, 2]), line("volume", [1, 2], "columns")]).size).toBe(0);

    const cues = assignSeriesLineCues([
      line("volume", [1, 2], "columns"),
      line("iv30", [1, 2]),
      line("live", [1, 2], "points"),
      { ...line("iv90", [1, 2]), hidden: true },
      line("hv", [1, 2], "area"),
    ]);
    expect([...cues].map(([id, cue]) => [id, cue.id])).toEqual([["iv30", "solid"], ["iv90", "dashed"], ["hv", "dotted"]]);
  });

  test("dashes run on along the line across many short segments", () => {
    // A dense flat series: segments of a pixel or two, far shorter than one dash.
    const values = Array.from({ length: 400 }, () => 10);
    const scene = buildCompositeChartScene(
      [line("solid", values, "line", "#ff0000"), { ...line("dashed", values.map(() => 0), "line", "#0000ff") }],
      [{ id: "main" }],
      { width: 1, height: 1, rightOffsetRatio: 0 },
    )!;
    const panel = { ...scene.panels[0]!, lineCues: assignSeriesLineCues(scene.panels[0]!.series.map((entry) => entry.source)) };
    const bitmap = renderCompositePanelBitmap(panel, {
      pixelWidth: 400,
      pixelHeight: 40,
      colors: { background: "#000000", grid: "#000000", crosshair: "#000000", text: "#000000", textDim: "#000000", negative: "#000000" },
    });
    const inkRow = (channel: 0 | 2) => {
      let bestRow = 0;
      let bestCount = -1;
      for (let y = 0; y < bitmap.height; y += 1) {
        let count = 0;
        for (let x = 0; x < bitmap.width; x += 1) if (bitmap.pixels[(y * bitmap.width + x) * 4 + channel]! > 128) count += 1;
        if (count > bestCount) [bestRow, bestCount] = [y, count];
      }
      return Array.from({ length: bitmap.width - 20 }, (_, index) => bitmap.pixels[(bestRow * bitmap.width + index + 10) * 4 + channel]! > 128);
    };
    const runs = (row: boolean[]) => row.reduce((count, on, index) => count + (on !== row[index - 1] && index > 0 ? 1 : 0), 0);

    expect(inkRow(0).every(Boolean)).toBe(true);
    const dashed = inkRow(2);
    const ink = dashed.filter(Boolean).length / dashed.length;
    // 7 on and 6 off, less what the round ends take back: well over a few dozen breaks, about half inked.
    expect(runs(dashed)).toBeGreaterThan(40);
    expect(ink).toBeGreaterThan(0.4);
    expect(ink).toBeLessThan(0.8);
  });
});
