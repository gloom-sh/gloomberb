import { describe, expect, test } from "bun:test";
import { applyChartComposerCapabilityOptions } from "./cli-options";
import { applySeriesTimestampMode } from "./chart-spec-edit";
import { buildComparisonChartPreset, buildCustomChartPreset, buildPriceChartPreset } from "./presets";

describe("chart composer CLI options", () => {
  test("applies price and financial options to the persisted spec", () => {
    const candle = applyChartComposerCapabilityOptions(
      buildPriceChartPreset("AAPL"),
      "price-chart",
      { axisMode: "percent" },
    );
    expect(candle.series[0]).toMatchObject({ style: "candles", transform: "raw" });

    const comparison = applyChartComposerCapabilityOptions(
      buildComparisonChartPreset(["AAPL", "MSFT"]),
      "price-comparison",
      { rangePreset: "3M", chartResolution: "1h", axisMode: "price" },
    );
    expect(comparison.viewport).toMatchObject({ range: "3M", resolution: "1h" });
    expect(comparison.series.every((series) => series.transform === "raw")).toBe(true);

    const initialFinancial = buildCustomChartPreset("AAPL:revenue");
    const financial = applyChartComposerCapabilityOptions(
      {
        ...initialFinancial,
        series: [
          applySeriesTimestampMode(initialFinancial.series[0]!, "available-at"),
        ],
      },
      "fundamental-series",
      { metric: "freeCashFlow", period: "annual", periods: 6 },
    );
    expect(financial.viewport.maxPoints).toBe(6);
    expect(financial.series[0]?.source).toMatchObject({
      kind: "security",
      fieldId: "fundamental.freeCashFlow",
      period: "annual",
      timestampMode: "available-at",
    });
  });
});
