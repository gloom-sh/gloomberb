import { describe, expect, test } from "bun:test";
import {
  CHART_RESOLUTION_STEP_MS,
  getBestSupportedResolutionForVisibleWindow,
  getExpandedBufferRange,
  getPresetResolution,
  isRangePresetSupported,
  normalizeChartResolution,
  sortChartResolutions,
} from "./resolution";

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
});
