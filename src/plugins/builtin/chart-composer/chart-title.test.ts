import { describe, expect, test } from "bun:test";
import { chartTitle, retitledChart } from "./chart-title";
import { appendChartSeries } from "./chart-spec-edit";
import { buildComparisonChartPreset, buildCustomChartPreset, buildEmptyChartPreset } from "./presets";
import type { ChartSpec } from "../../../time-series/types";

const spy = { kind: "security" as const, symbol: "SPY", fieldId: "market.ohlcv" };
const withSpy = (spec: ChartSpec) => appendChartSeries(spec, spy).spec;

describe("a chart's title follows the series added and removed", () => {
  test("a title the series gave the chart names what is added, and counts it past three, as the command would", () => {
    const three = buildComparisonChartPreset(["SMH", "QQQ", "RSP"]);
    expect(retitledChart(chartTitle(three, "CMP"), three, withSpy(three))).toBe("CMP SMH · QQQ · RSP +1");
    expect(chartTitle(buildComparisonChartPreset(["SMH", "QQQ", "RSP", "SPY"]), "CMP")).toBe("CMP SMH · QQQ · RSP +1");

    const two = buildComparisonChartPreset(["SMH", "QQQ"]);
    expect(retitledChart("CMP SMH · QQQ", two, withSpy(two))).toBe("CMP SMH · QQQ · SPY");
    expect(retitledChart("CMP SMH · QQQ · SPY", withSpy(two), two)).toBe("CMP SMH · QQQ");
    expect(retitledChart("Custom Chart", buildEmptyChartPreset(), withSpy(buildEmptyChartPreset()))).toBe("G SPY");
  });

  // CMP TQQQ, SPY is titled before QQQ joins as the index fund TQQQ's daily objective is drawn from.
  test("a title naming some of the chart's series is still the series'", () => {
    const leveraged = buildComparisonChartPreset(["TQQQ", "SPY", "QQQ"]);
    expect(retitledChart("CMP TQQQ · SPY", leveraged, appendChartSeries(leveraged, { ...spy, symbol: "NVDA" }).spec))
      .toBe("CMP TQQQ · SPY · QQQ +1");
  });

  test("a title the user gave the pane, or a command's own, stays, and so does any title while the series do", () => {
    const two = buildComparisonChartPreset(["SMH", "QQQ"]);
    expect(retitledChart("Semis vs the market", two, withSpy(two))).toBeNull();
    expect(retitledChart("CMP semis", two, withSpy(two))).toBeNull();
    expect(retitledChart("RV SMH · QQQ", two, withSpy(two))).toBeNull();
    expect(retitledChart(undefined, two, withSpy(two))).toBeNull();
    const transits = buildCustomChartPreset("GEO:SUEZ");
    expect(retitledChart("G Chokepoint transits", transits, withSpy(transits))).toBeNull();
    const restyled = { ...two, series: two.series.map((series) => ({ ...series, transform: "index100" as const })) };
    expect(retitledChart("CMP SMH · QQQ", two, restyled)).toBeNull();
  });
});
