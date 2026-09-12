import { expect, test } from "bun:test";
import { buildStaticChartSeries } from "../../../components/chart/static/chart-surface";
import { buildCompositeChartScene } from "../../../components/chart/composite/scene";
import { buildYieldCurveChart } from "./chart";
import { TREASURY_MATURITIES } from "./treasury-data";

test("curve projection preserves maturity distances, including missing tenors", () => {
  const source = TREASURY_MATURITIES.map(({ maturity, years }, index) => ({
    maturity, maturityYears: years, yield: 4 + index / 10,
  }));
  for (const data of [source, source.filter(({ maturity }) => maturity !== "6M")]) {
    const chart = buildYieldCurveChart(data, 62);
    const scene = buildCompositeChartScene(buildStaticChartSeries(chart.points, "line", "green", [], true),
      [{ id: "main" }], { width: 70, height: 12, rightOffsetRatio: 0 })!;
    expect(scene.timeScale.kind).toBe("calendar");
    const projected = scene.panels[0]!.series[0]!.points;
    for (let index = 0; index < data.length; index++) {
      expect(projected[index]!.xRatio).toBeCloseTo((data[index]!.maturityYears - 1 / 12) / (30 - 1 / 12), 10);
      expect(projected[index]!.value).toBe(data[index]!.yield);
    }
    expect(chart.formatCursor(0)).toBe("1.0M");
    expect(chart.formatCursor(1)).toBe("30.0Y");
  }
});

test("partial curve ticks stay in range and readable at narrow widths", () => {
  const source = [{ maturity: "5Y", maturityYears: 5, yield: 4 }, { maturity: "10Y", maturityYears: 10, yield: 4.3 }];
  const chart = buildYieldCurveChart(source, 20);
  expect(chart.ticks).toEqual([{ label: "5Y", ratio: 0 }, { label: "10Y", ratio: 1 }]);
  expect(chart.formatCursor(0.5)).toBe("7.5Y");
  expect(buildYieldCurveChart([], 20).points).toEqual([]);
});
