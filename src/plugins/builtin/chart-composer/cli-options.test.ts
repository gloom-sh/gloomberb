import { describe, expect, test } from "bun:test";
import { applyChartComposerCapabilityOptions, yearToDateWindow } from "./cli-options";
import { applySeriesTimestampMode } from "./chart-spec-edit";
import { buildComparisonChartPreset, buildCustomChartPreset, buildPriceChartPreset, buildValuationChartPreset } from "./presets";

describe("chart composer CLI options", () => {
  test("a reporting-period override works independently of the metric and daily can be restored", () => {
    const daily = buildValuationChartPreset(["AAPL", "MSFT"]);
    const annual = applyChartComposerCapabilityOptions(daily, "valuation-series", { period: "annual" });
    expect(annual.series.map((series) => series.source)).toEqual(daily.series.map((series) => ({ ...series.source, period: "annual" })));
    const restored = applyChartComposerCapabilityOptions(annual, "valuation-series", { period: "daily", metric: "evSales" });
    expect(restored.series.map((series) => series.source)).toEqual(daily.series.map((series) => ({ ...series.source, fieldId: "valuation.evSales" })));
  });
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

    // YTD is a year of bars shown from the prior year's last close, the one YTD returns are measured from.
    const ytd = applyChartComposerCapabilityOptions(
      buildComparisonChartPreset(["LMT", "RTX"]),
      "price-comparison",
      { rangePreset: "YTD" },
    );
    const today = new Date().toISOString().slice(0, 10);
    expect(ytd.viewport).toMatchObject({ range: "1Y", dateWindow: { start: yearToDateWindow(ytd).start, end: today } });
    expect(yearToDateWindow(ytd, Date.parse("2026-10-20T16:00:00Z"))).toEqual({ start: "2025-12-31", end: "2026-10-20" });
    expect(yearToDateWindow(ytd, Date.parse("2023-02-01T16:00:00Z")).start).toBe("2022-12-30");

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
