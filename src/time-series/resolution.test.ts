import { describe, expect, test } from "bun:test";
import {
  CHART_RESOLUTION_STEP_MS,
  getBestSupportedResolutionForVisibleWindow,
  getExpandedBufferRange,
  getPresetResolution,
  getSupportedChartResolutionsForViewport,
  isRangePresetSupported,
  normalizeChartResolution,
  sortChartResolutions,
} from "./resolution";
import { TIME_RANGES } from "./range";

describe("chart-resolution", () => {
  test("maps range presets to their default manual resolutions", () => {
    expect(getPresetResolution("1W")).toBe("5m");
    expect(getPresetResolution("1M")).toBe("15m");
    expect(getPresetResolution("3M")).toBe("1h");
    expect(getPresetResolution("6M")).toBe("1d");
    expect(getPresetResolution("1Y")).toBe("1d");
    expect(getPresetResolution("5Y")).toBe("1wk");
    expect(getPresetResolution("ALL")).toBe("1mo");
  });

  test("checks whether a range preset is supported by the visible capability set", () => {
    expect(isRangePresetSupported("1Y", ["1d", "1wk"])).toBe(true);
    expect(isRangePresetSupported("ALL", ["1d", "1wk"])).toBe(false);
  });

  test("expands buffers only toward wider supported ranges", () => {
    const support = new Map([
      ["1h", "3M"],
      ["1d", "5Y"],
    ] as const);

    expect(getExpandedBufferRange("1Y", "1d", support)).toBe("5Y");
    expect(getExpandedBufferRange("5Y", "1h", support)).toBeNull();
    expect(getExpandedBufferRange("5Y", "auto", support)).toBe("ALL");
  });

  test("normalizes and sorts chart resolution values", () => {
    expect(normalizeChartResolution("1h")).toBe("1h");
    expect(normalizeChartResolution("bogus", "1d")).toBe("1d");
    expect(sortChartResolutions(["1wk", "auto", "15m", "1d"])).toEqual(["auto", "15m", "1d", "1wk"]);
  });

  test("picks a denser supported resolution as the visible window narrows", () => {
    const support = [
      { resolution: "1m", maxRange: "1D" },
      { resolution: "5m", maxRange: "1W" },
      { resolution: "15m", maxRange: "1M" },
      { resolution: "1h", maxRange: "3M" },
      { resolution: "1d", maxRange: "5Y" },
      { resolution: "1wk", maxRange: "ALL" },
    ] as const;

    expect(getBestSupportedResolutionForVisibleWindow({
      start: new Date("2021-01-01T00:00:00Z"),
      end: new Date("2026-01-01T00:00:00Z"),
    }, support, 100)).toBe("1wk");

    expect(getBestSupportedResolutionForVisibleWindow({
      start: new Date("2025-01-01T00:00:00Z"),
      end: new Date("2026-01-01T00:00:00Z"),
    }, support, 100)).toBe("1d");

    expect(getBestSupportedResolutionForVisibleWindow({
      start: new Date("2025-12-01T00:00:00Z"),
      end: new Date("2026-01-01T00:00:00Z"),
    }, support, 100)).toBe("1h");

    expect(getBestSupportedResolutionForVisibleWindow({
      start: new Date("2025-12-25T00:00:00Z"),
      end: new Date("2026-01-01T00:00:00Z"),
    }, support, 100)).toBe("15m");

    expect(getBestSupportedResolutionForVisibleWindow({
      start: new Date("2026-01-01T00:00:00Z"),
      end: new Date("2026-01-02T00:00:00Z"),
    }, support, 100)).toBe("1m");

    expect(CHART_RESOLUTION_STEP_MS["1h"]).toBe(60 * 60_000);
  });

  test("exposes only intervals that can cover and chart the authored viewport", () => {
    const support = [
      { resolution: "1m", maxRange: "1W" },
      { resolution: "15m", maxRange: "3M" },
      { resolution: "30m", maxRange: "6M" },
      { resolution: "1h", maxRange: "1Y" },
      { resolution: "1d", maxRange: "ALL" },
    ] as const;

    expect(getSupportedChartResolutionsForViewport("1M", support))
      .toEqual(["15m", "30m", "1h", "1d"]);
    expect(getSupportedChartResolutionsForViewport("1Y", support))
      .toEqual(["1h", "1d"]);
    expect(getSupportedChartResolutionsForViewport("1M", support, {
      start: "2024-01-01",
      end: "2026-01-01",
    })).toEqual(["1d"]);
  });

  test("hides intervals too coarse to form a chart for the selected range", () => {
    const support = (Object.keys(CHART_RESOLUTION_STEP_MS) as Array<
      keyof typeof CHART_RESOLUTION_STEP_MS
    >).map((resolution) => ({ resolution, maxRange: "ALL" as const }));

    expect(getSupportedChartResolutionsForViewport("1D", support))
      .toEqual(["1m", "5m", "15m", "30m", "45m", "1h"]);
    expect(getSupportedChartResolutionsForViewport("1W", support))
      .toEqual(["1m", "5m", "15m", "30m", "45m", "1h", "1d"]);
    expect(getSupportedChartResolutionsForViewport("1M", support))
      .toEqual(["1m", "5m", "15m", "30m", "45m", "1h", "1d", "1wk"]);
    expect(getSupportedChartResolutionsForViewport("3M", support))
      .toEqual(Object.keys(CHART_RESOLUTION_STEP_MS));
  });

  test("evaluates every range and resolution capability boundary", () => {
    const resolutions = ["1m", "5m", "15m", "30m", "45m", "1h"] as const;
    const support = resolutions.map((resolution, index) => ({
      resolution,
      maxRange: TIME_RANGES[Math.min(index, TIME_RANGES.length - 1)]!,
    }));

    for (const [rangeIndex, range] of TIME_RANGES.entries()) {
      const available = new Set(getSupportedChartResolutionsForViewport(range, support));
      for (const [resolutionIndex, resolution] of resolutions.entries()) {
        expect(available.has(resolution)).toBe(rangeIndex <= resolutionIndex);
      }
    }
  });
});
