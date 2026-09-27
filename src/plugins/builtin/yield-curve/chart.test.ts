import { expect, test } from "bun:test";
import { buildCurveChart } from "../../../components/chart/curve/model";
import { buildCompositeChartScene } from "../../../components/chart/composite/scene";
import { buildYieldCurveSeries, formatYieldChange, yieldCurveChartSeries, yieldSpreads, yieldTenorRows } from "./chart";

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

test("curve spreads need both tenors from one session, and their day move reads against the session before", () => {
  const curve = (asOf: string, yields: Record<string, number | null>) => Object.entries(yields)
    .map(([maturity, value]) => ({ maturity, maturityYears: 1, yield: value, asOf }));
  const today = curve("2026-09-24", { "3M": 4.2, "2Y": 4.5, "5Y": 4.6, "10Y": 4.4, "30Y": 4.9 });
  const before = [...curve("2026-09-23", { "3M": 4.2, "2Y": 4.45, "10Y": 4.4, "30Y": 4.85 }),
    { maturity: "5Y", maturityYears: 5, yield: 4.5, asOf: "2026-09-22" }];
  const spreads = yieldSpreads(today, { "1D": before });
  // 2s10s is inverted by 10bp, 5bp more than the day before.
  expect(spreads.map((entry) => [entry.id, formatYieldChange(entry.spread!)])).toEqual([["2s10s", "-10bp"], ["3m10y", "+20bp"], ["5s30s", "+30bp"]]);
  expect(formatYieldChange(spreads[0]!.change1d!)).toBe("-5bp");
  expect(formatYieldChange(spreads[1]!.change1d!)).toBe("0bp");
  // The day before's 5Y is from another session, so 5s30s has no day move rather than a mixed one.
  expect(spreads[2]!.change1d).toBeNull();
  expect(yieldSpreads(today.map((point) => point.maturity === "10Y" ? { ...point, asOf: "2026-09-23" } : point))
    .map((entry) => entry.spread)).toEqual([null, null, expect.any(Number)]);
  // A cached tenor still on the session before has not moved yet: no change, not 0bp.
  const lagging = today.map((point) => point.maturity === "2Y" || point.maturity === "10Y"
    ? { ...point, yield: before.find((entry) => entry.maturity === point.maturity)!.yield, asOf: "2026-09-23" } : point);
  expect(yieldSpreads(lagging, { "1D": before })[0]).toMatchObject({ spread: expect.any(Number), change1d: null });
  expect(yieldTenorRows(lagging, { "1D": before }).find((row) => row.id === "2Y")!.change1d).toBeNull();
});
