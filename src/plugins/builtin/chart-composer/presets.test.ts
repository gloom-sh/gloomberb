import { describe, expect, test } from "bun:test";
import { getSelectedBuiltinStudies } from "./studies";
import {
  buildComparisonChartPreset,
  buildCustomChartPreset,
  buildFundamentalChartPreset,
  buildIntradayPriceChartPreset,
  buildPriceChartPreset,
} from "./presets";

describe("chart composer presets", () => {
  test("keeps shortcut presets semantically distinct", () => {
    const intraday = buildIntradayPriceChartPreset("aapl");
    expect(intraday.viewport).toEqual({ range: "1D", resolution: "1m" });
    expect(intraday.series[0]).toMatchObject({ style: "candles", transform: "raw" });
    expect(getSelectedBuiltinStudies(intraday)).toEqual(["volume"]);

    const comparison = buildComparisonChartPreset(["aapl", "msft"]);
    expect(comparison.series.map((series) => ({ style: series.style, transform: series.transform }))).toEqual([
      { style: "line", transform: "percent" },
      { style: "line", transform: "percent" },
    ]);

    const fundamental = buildFundamentalChartPreset(["aapl"]);
    expect(fundamental.series[0]).toMatchObject({
      style: "columns",
      interpolation: "none",
      source: { fieldId: "fundamental.totalRevenue", timestampMode: "period-end" },
    });
  });

  test("includes volume in fresh price and followed-ticker defaults", () => {
    const price = buildPriceChartPreset("AAPL");
    const followed = buildCustomChartPreset("", "AAPL");

    expect(getSelectedBuiltinStudies(price)).toEqual(["volume"]);
    expect(price.panels.find((panel) => panel.id === "volume")).toMatchObject({
      label: "Volume",
      height: 0.24,
    });
    expect(followed).toEqual(price);
  });
});
