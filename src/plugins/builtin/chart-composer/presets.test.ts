import { describe, expect, test } from "bun:test";
import { createPaneInstance } from "../../../types/config";
import type { ChartSpec } from "../../../time-series/types";
import { getSelectedBuiltinStudies } from "./studies";
import { chartComposerModule } from "./index";
import { CHART_SPEC_SETTING_KEY } from "./chart-spec";
import {
  buildComparisonChartPreset,
  buildCustomChartPreset,
  buildFundamentalChartPreset,
  buildIntradayPriceChartPreset,
  buildPriceChartPreset,
  buildValuationChartPreset,
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

  // Any fields of one ticker follow a list (GF revenue beside total debt, FRED beside it stays put); a
  // comparison would move only one of its tickers.
  test("a chart of one ticker can follow a list whatever its fields; one of two tickers or none cannot", () => {
    const follower = chartComposerModule.panes![0]!.tickerFollower as (pane: ReturnType<typeof createPaneInstance>) => boolean;
    const canFollow = (spec: ChartSpec) => follower(createPaneInstance("chart-composer", {
      binding: { kind: "fixed", symbol: "AAPL" },
      settings: { [CHART_SPEC_SETTING_KEY]: spec },
    }));
    expect(canFollow(buildPriceChartPreset("AAPL"))).toBe(true);
    expect(canFollow(buildIntradayPriceChartPreset("AAPL"))).toBe(true);
    expect(canFollow(buildFundamentalChartPreset(["AAPL"]))).toBe(true);
    expect(canFollow(buildValuationChartPreset(["AAPL"]))).toBe(true);
    expect(canFollow(buildCustomChartPreset("AAPL:revenue, AAPL:totalDebt, FRED:GDP"))).toBe(true);
    expect(canFollow(buildFundamentalChartPreset(["AAPL", "MSFT"]))).toBe(false);
    expect(canFollow(buildCustomChartPreset("FRED:GDP"))).toBe(false);
    expect(canFollow(buildComparisonChartPreset(["AAPL", "MSFT"]))).toBe(false);
  });
});
