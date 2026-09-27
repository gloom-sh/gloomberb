import { expect, test } from "bun:test";
import { buildCurveChart } from "../../../components/chart/curve/model";
import { buildCompositeChartScene } from "../../../components/chart/composite/scene";
import { buildYieldCurveSeries, formatYieldChange, yieldCurveChartSeries, yieldTenorRows } from "./chart";

test("Treasury migration retains missing tenors as gaps and every node's observation date", () => {
  const points = [
    { maturity: "1M", maturityYears: 1 / 12, yield: 4, asOf: "2026-09-21" },
    { maturity: "6M", maturityYears: 0.5, yield: null, asOf: null },
    { maturity: "2Y", maturityYears: 2, yield: 3.5, asOf: "2026-09-21" },
    { maturity: "10Y", maturityYears: 10, yield: 4.5, asOf: "2026-09-21" },
  ];
  const curve = buildYieldCurveSeries(points);
  expect(curve.points[1]?.value).toBeNull();
  expect(curve.points[2]?.asOf).toBe("2026-09-21");
  const chart = buildCurveChart([curve], 70, ["green"]);
  const scene = buildCompositeChartScene(chart.series, [{ id: "main" }], { width: 70, height: 12, rightOffsetRatio: 0 })!;
  expect(scene.timeScale.kind).toBe("calendar");
  const projected = scene.panels[0]!.series[0]!.points;
  expect(projected[1]?.breakBefore).toBe(true);
  expect(projected[1]?.xRatio).toBeCloseTo((2 - 1 / 12) / (10 - 1 / 12), 10);
  expect(buildYieldCurveSeries([...points, { maturity: "30Y", maturityYears: 30, yield: 4.7, asOf: "2026-09-20" }]).asOf).toBeNull();
});

test("tenor rows read each yield's move since the look-backs in basis points", () => {
  const points = [
    { maturity: "10Y", maturityYears: 10, yield: 4.5, asOf: "2026-09-24" },
    { maturity: "2Y", maturityYears: 2, yield: 3.5, asOf: "2026-09-24" },
    { maturity: "6M", maturityYears: 0.5, yield: null, asOf: null },
  ];
  const week = [{ maturity: "2Y", maturityYears: 2, yield: 3.57, asOf: "2026-09-17" }, { maturity: "10Y", maturityYears: 10, yield: null, asOf: null }];
  const rows = yieldTenorRows(points, { "1W": week, "1M": null });
  expect(rows.map((row) => row.id)).toEqual(["6M", "2Y", "10Y"]);
  expect(formatYieldChange(rows[1]!.change1w!)).toBe("-7bp");
  expect(rows[2]!.change1w).toBeNull();
  expect(rows[0]).toMatchObject({ yield: null, change1w: null, change1m: null, asOf: null });
  expect(formatYieldChange(0.004)).toBe("0bp");
  expect(formatYieldChange(-0.004)).toBe("0bp");
  expect(formatYieldChange(0.125)).toBe("+13bp");
});

test("the chart names the curve in the table's words and keeps only look-backs that loaded", () => {
  const points = [{ maturity: "2Y", maturityYears: 2, yield: 3.5, asOf: "2026-09-24" }, { maturity: "10Y", maturityYears: 10, yield: 4.5, asOf: "2026-09-24" }];
  const series = yieldCurveChartSeries(points, { "1W": points.map((point) => ({ ...point, yield: point.yield - 0.1 })), "1M": [] },
    { current: "green", ghosts: { "1W": "gray", "1M": "orange" } });
  expect(series.map((entry) => [entry.id, entry.label, entry.role, entry.color])).toEqual([
    ["yield", "Yield", "primary", "green"], ["1W", "1W", "ghost", "gray"]]);
  expect(series[0]!.asOf).toBeUndefined();
});
