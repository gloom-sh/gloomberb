import { describe, expect, test } from "bun:test";
import type { ResolvedSeries, TimeSeriesPoint } from "../../../time-series/types";
import {
  renderCompositePanelBitmap,
  resolveCompositeColumnWidth,
  resolveCompositeOhlcWidth,
} from "./rasterizer";
import { buildCompositeColumnLayout } from "./column-layout";
import { buildCompositeChartScene } from "./scene";
import {
  renderCompositePanelText,
  resolveCompositeTextOhlcWidth,
} from "./text-renderer";

function point(date: string, value: number): TimeSeriesPoint {
  const observedAt = new Date(`${date}T00:00:00.000Z`);
  return { date: observedAt, observedAt, value };
}

function series(
  id: string,
  style: ResolvedSeries["style"],
  values: number[],
  axis: ResolvedSeries["axis"],
  color = axis === "left" ? "#00ff66" : "#ffaa00",
): ResolvedSeries {
  return {
    id,
    label: id,
    color,
    unit: axis === "left" ? "USD" : "%",
    unitGroup: axis === "left" ? "currency" : "percent",
    nativeFrequency: "daily",
    dataShape: "scalar",
    style,
    transform: "raw",
    axis,
    panelId: "main",
    interpolation: style === "step" ? "step-after" : "none",
    points: values.map((value, index) => point(`2025-01-0${index + 1}`, value)),
  };
}

function periodSeries(
  id: string,
  nativeFrequency: "annual" | "quarterly",
  observations: Array<{ date: string; periodLabel: string; value?: number }>,
  color = "#00ff66",
): ResolvedSeries {
  return {
    ...series(id, "columns", [], "left", color),
    nativeFrequency,
    points: observations.map(({ date, periodLabel, value = 5 }) => ({
      ...point(date, value),
      periodLabel,
    })),
  };
}

describe("composite chart renderers", () => {
  test("groups same-date columns into adjacent terminal cells", () => {
    const scene = buildCompositeChartScene(
      [
        series("first", "columns", [5, 6, 5], "left", "#00ff66"),
        series("second", "columns", [5, 6, 5], "left", "#ff9900"),
      ],
      [{ id: "main" }],
      { width: 31, height: 9 },
    )!;

    const rows = renderCompositePanelText(scene.panels[0]!, scene.width, null, null);
    expect(rows[7]!.slice(0, 2)).toBe("██");
    expect(rows[7]!.slice(15, 17)).toBe("██");
    expect(rows[7]!.slice(-2)).toBe("██");
  });

  test("rasterizes same-date columns as separate colored bars", () => {
    const scene = buildCompositeChartScene(
      [
        series("first", "columns", [5, 6, 5], "left", "#00ff66"),
        series("second", "columns", [5, 6, 5], "left", "#ff9900"),
      ],
      [{ id: "main" }],
      { width: 31, height: 9 },
    )!;
    const bitmap = renderCompositePanelBitmap(scene.panels[0]!, {
      pixelWidth: 61,
      pixelHeight: 29,
      colors: {
        background: "#000000",
        grid: "#000000",
        crosshair: "#ffffff",
        text: "#eeeeee",
        textDim: "#999999",
        negative: "#ff0000",
      },
    });

    const greenXs = new Set<number>();
    const orangeXs = new Set<number>();
    for (let y = 4; y < bitmap.height - 4; y += 1) {
      for (let x = 18; x <= 42; x += 1) {
        const offset = (y * bitmap.width + x) * 4;
        const red = bitmap.pixels[offset]!;
        const green = bitmap.pixels[offset + 1]!;
        const blue = bitmap.pixels[offset + 2]!;
        if (green > red * 1.4 && green > blue * 1.4) greenXs.add(x);
        if (red > green * 1.3 && red > blue * 2) orangeXs.add(x);
      }
    }

    expect(greenXs.size).toBeGreaterThan(0);
    expect(orangeXs.size).toBeGreaterThan(0);
    expect(Math.max(...greenXs)).toBeLessThan(Math.min(...orangeXs));
  });

  test("groups offset annual and quarterly fiscal closes into stable cohort lanes", () => {
    const cases = [
      {
        frequency: "annual" as const,
        first: [
          { date: "2024-01-28", periodLabel: "FY2024" },
          { date: "2025-01-26", periodLabel: "FY2025" },
        ],
        second: [
          { date: "2023-12-31", periodLabel: "FY2023" },
          { date: "2024-12-31", periodLabel: "FY2024" },
        ],
      },
      {
        frequency: "quarterly" as const,
        first: [
          { date: "2024-01-28", periodLabel: "2024 Q1" },
          { date: "2024-04-28", periodLabel: "2024 Q2" },
        ],
        second: [
          { date: "2023-12-31", periodLabel: "2023 Q4" },
          { date: "2024-03-31", periodLabel: "2024 Q1" },
        ],
      },
    ];

    for (const fixture of cases) {
      const scene = buildCompositeChartScene(
        [
          periodSeries("offset-calendar", fixture.frequency, fixture.first),
          periodSeries("calendar", fixture.frequency, fixture.second),
        ],
        [{ id: "main" }],
        {
          width: 61,
          height: 9,
          viewport: {
            start: new Date("2023-10-01T00:00:00.000Z"),
            end: new Date("2025-03-01T00:00:00.000Z"),
          },
        },
      )!;
      const panel = scene.panels[0]!;
      const layout = buildCompositeColumnLayout(panel);
      const firstPoints = panel.series[0]!.points;
      const secondPoints = panel.series[1]!.points;

      for (let index = 0; index < firstPoints.length; index += 1) {
        const firstSlot = layout.groupByPoint.get(firstPoints[index]!)!;
        const secondSlot = layout.groupByPoint.get(secondPoints[index]!)!;
        expect(firstSlot.xRatio).toBe(secondSlot.xRatio);
        expect([firstSlot.index, secondSlot.index]).toEqual([0, 1]);
        expect([firstSlot.count, secondSlot.count]).toEqual([2, 2]);
      }
    }
  });

  test("keeps absent observations as empty lanes instead of widening nearby bars", () => {
    const scene = buildCompositeChartScene(
      [
        periodSeries("partial", "annual", [
          { date: "2024-01-28", periodLabel: "FY2024" },
          { date: "2026-01-25", periodLabel: "FY2026" },
        ]),
        periodSeries("complete", "annual", [
          { date: "2023-12-31", periodLabel: "FY2023" },
          { date: "2024-12-31", periodLabel: "FY2024" },
          { date: "2025-12-31", periodLabel: "FY2025" },
        ]),
      ],
      [{ id: "main" }],
      { width: 81, height: 9 },
    )!;
    const panel = scene.panels[0]!;
    const layout = buildCompositeColumnLayout(panel);
    const completeSlots = panel.series[1]!.points.map((point) => layout.groupByPoint.get(point)!);

    expect(completeSlots.map(({ index }) => index)).toEqual([1, 1, 1]);
    expect(completeSlots.map(({ count }) => count)).toEqual([2, 2, 2]);
  });

  test("keeps availability-timed financial columns on their actual dates", () => {
    const observedAt = new Date("2024-03-31T00:00:00.000Z");
    const firstAvailableAt = new Date("2024-04-15T00:00:00.000Z");
    const secondAvailableAt = new Date("2024-05-01T00:00:00.000Z");
    const first = periodSeries("first-filing", "quarterly", []);
    const second = periodSeries("second-filing", "quarterly", []);
    first.timestampMode = "available-at";
    second.timestampMode = "available-at";
    first.points = [{
      date: firstAvailableAt,
      observedAt,
      availableAt: firstAvailableAt,
      periodLabel: "2024 Q1",
      value: 5,
    }];
    second.points = [{
      date: secondAvailableAt,
      observedAt,
      availableAt: secondAvailableAt,
      periodLabel: "2024 Q1",
      value: 6,
    }];

    const scene = buildCompositeChartScene(
      [first, second],
      [{ id: "main" }],
      {
        width: 61,
        height: 9,
        viewport: {
          start: new Date("2024-03-01T00:00:00.000Z"),
          end: new Date("2024-06-01T00:00:00.000Z"),
        },
      },
    )!;
    const panel = scene.panels[0]!;
    const firstPoint = panel.series[0]!.points[0]!;
    const secondPoint = panel.series[1]!.points[0]!;
    const layout = buildCompositeColumnLayout(panel);
    const firstSlot = layout.groupByPoint.get(firstPoint)!;
    const secondSlot = layout.groupByPoint.get(secondPoint)!;

    expect(firstSlot.xRatio).toBe(firstPoint.xRatio);
    expect(secondSlot.xRatio).toBe(secondPoint.xRatio);
    expect(firstSlot.xRatio).not.toBe(secondSlot.xRatio);
    expect([firstSlot.count, secondSlot.count]).toEqual([1, 1]);
  });

  test("rasterizes offset annual cohorts as non-overlapping equal-width bars", () => {
    const scene = buildCompositeChartScene(
      [
        periodSeries("january-close", "annual", [
          { date: "2024-01-28", periodLabel: "FY2024" },
          { date: "2025-01-26", periodLabel: "FY2025" },
          { date: "2026-01-25", periodLabel: "FY2026" },
        ], "#00ff00"),
        periodSeries("june-close", "annual", [
          { date: "2023-06-30", periodLabel: "FY2023" },
          { date: "2024-06-30", periodLabel: "FY2024" },
          { date: "2025-06-30", periodLabel: "FY2025" },
        ], "#ff0000"),
        periodSeries("december-close", "annual", [
          { date: "2023-12-31", periodLabel: "FY2023" },
          { date: "2024-12-31", periodLabel: "FY2024" },
          { date: "2025-12-31", periodLabel: "FY2025" },
        ], "#0000ff"),
      ],
      [{ id: "main" }],
      {
        width: 101,
        height: 12,
        viewport: {
          start: new Date("2023-01-01T00:00:00.000Z"),
          end: new Date("2026-03-01T00:00:00.000Z"),
        },
      },
    )!;
    const bitmap = renderCompositePanelBitmap(scene.panels[0]!, {
      pixelWidth: 401,
      pixelHeight: 80,
      colors: {
        background: "#000000",
        grid: "#000000",
        crosshair: "#ffffff",
        text: "#eeeeee",
        textDim: "#999999",
        negative: "#ff0000",
      },
    });
    const runsForChannel = (channel: 0 | 1 | 2): Array<{ start: number; end: number }> => {
      const occupied: number[] = [];
      const y = 40;
      for (let x = 0; x < bitmap.width; x += 1) {
        const offset = (y * bitmap.width + x) * 4;
        const value = bitmap.pixels[offset + channel]!;
        const otherChannels = [0, 1, 2].filter((candidate) => candidate !== channel);
        if (otherChannels.every((candidate) => value > bitmap.pixels[offset + candidate]! * 2)) {
          occupied.push(x);
        }
      }
      return occupied.reduce<Array<{ start: number; end: number }>>((runs, x) => {
        const current = runs.at(-1);
        if (current && x === current.end + 1) current.end = x;
        else runs.push({ start: x, end: x });
        return runs;
      }, []);
    };
    const greenRuns = runsForChannel(1);
    const redRuns = runsForChannel(0);
    const blueRuns = runsForChannel(2);

    expect([greenRuns.length, redRuns.length, blueRuns.length]).toEqual([3, 3, 3]);
    for (let index = 0; index < 3; index += 1) {
      const runs = [greenRuns[index]!, redRuns[index]!, blueRuns[index]!];
      expect(runs[0]!.end).toBeLessThan(runs[1]!.start);
      expect(runs[1]!.end).toBeLessThan(runs[2]!.start);
      const widths = runs.map(({ start, end }) => end - start + 1);
      expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
      expect(Math.min(...widths)).toBeGreaterThanOrEqual(3);
    }
  });

  test("keeps six-series annual bars visibly wide without merging their lanes", () => {
    const colors = ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff"];
    const fiscalCloses = [
      ["2024-01-28", "2025-01-26", "2026-01-25"],
      ["2023-06-30", "2024-06-30", "2025-06-30"],
      ["2023-09-30", "2024-09-28", "2025-09-27"],
      ["2023-12-15", "2024-12-15", "2025-12-15"],
      ["2023-12-28", "2024-12-28", "2025-12-27"],
      ["2023-12-31", "2024-12-31", "2025-12-31"],
    ];
    const scene = buildCompositeChartScene(
      fiscalCloses.map((dates, seriesIndex) => periodSeries(
        `series-${seriesIndex}`,
        "annual",
        dates.map((date, periodIndex) => ({
          date,
          periodLabel: `FY${2023 + periodIndex + (seriesIndex === 0 ? 1 : 0)}`,
        })),
        colors[seriesIndex],
      )),
      [{ id: "main" }],
      {
        width: 180,
        height: 12,
        viewport: {
          start: new Date("2023-01-01T00:00:00.000Z"),
          end: new Date("2026-03-01T00:00:00.000Z"),
        },
      },
    )!;
    const bitmap = renderCompositePanelBitmap(scene.panels[0]!, {
      pixelWidth: 2_880,
      pixelHeight: 80,
      colors: {
        background: "#000000",
        grid: "#000000",
        crosshair: "#ffffff",
        text: "#eeeeee",
        textDim: "#999999",
        negative: "#ff0000",
      },
    });
    const y = 40;
    const xsByMask = new Map<number, number[]>();
    for (let x = 0; x < bitmap.width; x += 1) {
      const offset = (y * bitmap.width + x) * 4;
      const mask = [0, 1, 2].reduce((value, channel) => (
        bitmap.pixels[offset + channel]! > 20 ? value | (1 << channel) : value
      ), 0);
      if (mask > 0) {
        const xs = xsByMask.get(mask);
        if (xs) xs.push(x);
        else xsByMask.set(mask, [x]);
      }
    }
    const widths = [1, 2, 4, 3, 5, 6].flatMap((mask) => {
      const runs = (xsByMask.get(mask) ?? []).reduce<Array<{ start: number; end: number }>>(
        (result, x) => {
          const current = result.at(-1);
          if (current && x === current.end + 1) current.end = x;
          else result.push({ start: x, end: x });
          return result;
        },
        [],
      );
      expect(runs).toHaveLength(3);
      return runs.map(({ start, end }) => end - start + 1);
    });

    expect(Math.min(...widths)).toBeGreaterThanOrEqual(16);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  });

  test("keeps a lone column series centered on its observation dates", () => {
    const scene = buildCompositeChartScene(
      [series("only", "columns", [5, 6, 5], "left")],
      [{ id: "main" }],
      { width: 31, height: 9 },
    )!;

    const rows = renderCompositePanelText(scene.panels[0]!, scene.width, null, null);
    const occupied = [...rows[7]!]
      .flatMap((cell, index) => cell === "█" ? [index] : []);
    expect(occupied).toEqual([0, 15, 30]);
  });

  test("does not group columns across independent axes or panels", () => {
    const otherPanel = {
      ...series("other-panel", "columns", [5, 6, 5], "left"),
      panelId: "other",
    };
    const scene = buildCompositeChartScene(
      [
        series("left-axis", "columns", [5, 6, 5], "left"),
        series("right-axis", "columns", [5, 6, 5], "right"),
        otherPanel,
      ],
      [{ id: "main" }, { id: "other" }],
      { width: 31, height: 18 },
    )!;

    for (const panel of scene.panels) {
      const rows = renderCompositePanelText(panel, scene.width, null, null);
      expect(rows.some((row) => row.includes("██"))).toBe(false);
    }
  });

  test("renders distinct mixed-series marks and the shared cursor in text fallback", () => {
    const scene = buildCompositeChartScene(
      [series("price", "line", [100, 105, 103], "left"), series("revenue", "columns", [2, 4, 3], "right")],
      [{ id: "main" }],
      { width: 31, height: 9, cursorDate: new Date("2025-01-02T00:00:00.000Z") },
    )!;

    const output = renderCompositePanelText(
      scene.panels[0]!,
      scene.width,
      scene.cursorXRatio,
      0.5,
    ).join("\n");
    expect(output).toContain("█");
    expect(output).toContain("•");
    expect(output).toMatch(/[│┼]/);
  });

  test("draws columns beneath line marks in the text fallback regardless of authored order", () => {
    const scene = buildCompositeChartScene(
      [
        series("price", "line", [5, 6, 5], "left"),
        series("revenue", "columns", [5, 6, 5], "left"),
      ],
      [{ id: "main" }],
      { width: 31, height: 9 },
    )!;
    const panel = scene.panels[0]!;
    const linePoint = panel.series[0]!.points[1]!;
    const x = Math.round(linePoint.xRatio * (scene.width - 1));
    const y = Math.round(linePoint.yRatio * (panel.height - 1));

    const rows = renderCompositePanelText(panel, scene.width, null, null);

    expect(rows[y]![x]).toBe("•");
  });

  test("renders point series without connecting their observations", () => {
    const scene = buildCompositeChartScene(
      [series("events", "points", [2, 8, 3], "left")],
      [{ id: "main" }],
      { width: 31, height: 9 },
    )!;

    const output = renderCompositePanelText(
      scene.panels[0]!,
      scene.width,
      null,
      null,
    ).join("\n");
    expect(output).toContain("●");
    expect(output).not.toContain("•");
  });

  test("rasterizes a fully opaque native bitmap of the plotted series", () => {
    const scene = buildCompositeChartScene(
      [series("price", "area", [100, 105, 103], "left"), series("revenue", "step", [2, 4, 3], "right")],
      [{ id: "main" }],
      { width: 31, height: 9, cursorDate: new Date("2025-01-02T00:00:00.000Z") },
    )!;
    const bitmap = renderCompositePanelBitmap(scene.panels[0]!, {
      pixelWidth: 62,
      pixelHeight: 36,
      colors: {
        background: "#101010",
        grid: "#303030",
        crosshair: "#ffffff",
        text: "#eeeeee",
        textDim: "#999999",
        negative: "#ff0000",
      },
    });

    expect(bitmap.width).toBe(62);
    expect(bitmap.height).toBe(36);
    expect(bitmap.pixels).toHaveLength(62 * 36 * 4);
    expect(bitmap.pixels.filter((_, index) => index % 4 === 3).every((alpha) => alpha === 255)).toBe(true);
    expect(new Set(bitmap.pixels)).not.toEqual(new Set([16, 255]));
  });

  test("measures column spacing once per series instead of once per observation", () => {
    const denseColumns = {
      ...series("volume", "columns", [], "left"),
      points: Array.from({ length: 512 }, (_, index) => {
        const observedAt = new Date(Date.UTC(2025, 0, index + 1));
        return { date: observedAt, observedAt, value: index + 1 };
      }),
    };
    const scene = buildCompositeChartScene(
      [denseColumns],
      [{ id: "main" }],
      { width: 120, height: 20 },
    )!;
    const originalSort = Array.prototype.sort;
    let sortCalls = 0;
    Array.prototype.sort = function (compareFn) {
      sortCalls += 1;
      return originalSort.call(this, compareFn);
    };
    try {
      renderCompositePanelBitmap(scene.panels[0]!, {
        pixelWidth: 960,
        pixelHeight: 320,
        colors: {
          background: "#101010",
          grid: "#303030",
          crosshair: "#ffffff",
          text: "#eeeeee",
          textDim: "#999999",
          negative: "#ff0000",
        },
      });
    } finally {
      Array.prototype.sort = originalSort;
    }

    expect(sortCalls).toBeLessThanOrEqual(4);
  });

  test("uses the typical observation cadence when one stray gap is much smaller", () => {
    const nearDuplicate = series("revenue", "columns", [], "left");
    nearDuplicate.points = [
      point("2025-01-01", 1),
      point("2025-01-02", 2),
      point("2025-04-01", 3),
      point("2025-07-01", 4),
      point("2025-10-01", 5),
    ];
    const scene = buildCompositeChartScene(
      [nearDuplicate],
      [{ id: "main" }],
      {
        width: 120,
        height: 20,
        viewport: {
          start: new Date("2025-01-01T00:00:00.000Z"),
          end: new Date("2026-01-01T00:00:00.000Z"),
        },
      },
    )!;

    expect(resolveCompositeColumnWidth(
      scene.panels[0]!.series[0]!.points,
      2_000,
    )).toBe(72);
    expect(resolveCompositeOhlcWidth(
      scene.panels[0]!.series[0]!.points,
      2_000,
    )).toBe(36);
  });

  test("widens candle bodies as the visible observation spacing grows", () => {
    const candles = series("price", "candles", [], "left");
    candles.points = Array.from({ length: 100 }, (_, index) => {
      const observedAt = new Date(Date.UTC(2025, 0, index + 1));
      return {
        date: observedAt,
        observedAt,
        value: 10,
        open: 8,
        high: 11,
        low: 7,
        close: 10,
      };
    });
    const fullScene = buildCompositeChartScene(
      [candles],
      [{ id: "main" }],
      { width: 81, height: 9 },
    )!;
    const zoomedScene = buildCompositeChartScene(
      [candles],
      [{ id: "main" }],
      {
        width: 81,
        height: 9,
        viewport: {
          start: new Date(Date.UTC(2025, 0, 98)),
          end: new Date(Date.UTC(2025, 0, 100)),
        },
      },
    )!;
    const fullPoints = fullScene.panels[0]!.series[0]!.points;
    const zoomedPoints = zoomedScene.panels[0]!.series[0]!.points;

    expect(resolveCompositeOhlcWidth(fullPoints, 800)).toBeLessThan(
      resolveCompositeOhlcWidth(zoomedPoints, 800),
    );
    expect(resolveCompositeTextOhlcWidth(fullPoints, 81)).toBe(1);
    expect(resolveCompositeTextOhlcWidth(zoomedPoints, 81)).toBe(5);

    const zoomedText = renderCompositePanelText(zoomedScene.panels[0]!, 81, null, null).join("\n");
    expect(zoomedText).toContain("█████");
  });

  test("marks a standalone line observation without extending it through time", () => {
    const scene = buildCompositeChartScene(
      [series("estimate", "line", [42], "left")],
      [{ id: "main" }],
      {
        width: 31,
        height: 9,
        viewport: {
          start: new Date("2024-12-01T00:00:00.000Z"),
          end: new Date("2025-02-01T00:00:00.000Z"),
        },
      },
    )!;
    expect(scene.panels[0]?.series[0]?.points).toHaveLength(1);

    const bitmap = renderCompositePanelBitmap(scene.panels[0]!, {
      pixelWidth: 62,
      pixelHeight: 36,
      colors: {
        background: "#101010",
        grid: "#303030",
        crosshair: "#ffffff",
        text: "#eeeeee",
        textDim: "#999999",
        negative: "#ff0000",
      },
    });
    const hasGreenSeriesPixel = Array.from({ length: bitmap.width * bitmap.height }, (_, index) => index * 4)
      .some((offset) => (
        bitmap.pixels[offset + 1]! > 100
        && bitmap.pixels[offset + 1]! > bitmap.pixels[offset]! + 50
        && bitmap.pixels[offset + 1]! > bitmap.pixels[offset + 2]! + 50
      ));
    expect(hasGreenSeriesPixel).toBe(true);
  });
});
