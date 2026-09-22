import { expect, test } from "bun:test";
import { buildCurveChart } from "../../../components/chart/curve/model";
import { buildCompositeChartScene } from "../../../components/chart/composite/scene";
import { buildYieldCurveSeries } from "./chart";

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
