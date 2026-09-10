import { expect, test } from "bun:test";
import { buildValuationChartPreset, buildFundamentalChartPreset } from "../plugins/builtin/chart-composer/presets";
import { applyChartComposerCapabilityOptions } from "../plugins/builtin/chart-composer/cli-options";
import { financialPeriodCoverage, limitSeriesObservations } from "./financial-period-coverage";
import type { ResolvedSeries, TimeSeriesPoint } from "./types";

const point = (date: string, value: number | null, periodLabel: string): TimeSeriesPoint => ({ date: new Date(date), observedAt: new Date(date), value, periodLabel });

test("latest quarterly valuation counts usable periods while preserving gaps and excluding the current snapshot", () => {
  const spec = applyChartComposerCapabilityOptions(buildValuationChartPreset(["MSFT"]), "valuation-series", { metric: "trailingPE", period: "quarterly", periods: 3 });
  const series = { id: spec.series[0]!.id, label: "MSFT P/E", nativeFrequency: "quarterly", points: [
    point("2025-03-31", 20, "Q1 2025"), point("2025-06-30", 21, "Q2 2025"),
    point("2025-09-30", null, "Q3 2025"), point("2025-12-31", 22, "Q4 2025"),
    point("2026-03-31", Number.NaN, "Q1 2026"), point("2026-09-10", 25, "Current"),
  ] } as ResolvedSeries;
  const result = limitSeriesObservations(spec, series);
  expect(result.points.map((entry) => entry.value)).toEqual([20, 21, null, 22, Number.NaN]);
  expect(financialPeriodCoverage(spec, [result])).toEqual([expect.objectContaining({ requested: 3, returned: 3, period: "quarterly", complete: true })]);
  const currentOnly = limitSeriesObservations(spec, { ...series, points: [series.points.at(-1)!] });
  expect(currentOnly.points).toEqual([]);
  expect(financialPeriodCoverage(spec, [currentOnly])[0]).toMatchObject({ returned: 0, complete: false });
  spec.viewport.maxPoints = 2;
  const lastTwo = limitSeriesObservations(spec, series);
  expect(lastTwo.points.map((entry) => entry.value)).toEqual([21, null, 22, Number.NaN]);
  expect(financialPeriodCoverage(spec, [lastTwo])[0]).toMatchObject({ returned: 2, complete: true });
});

test("zero-valued financial observations are usable and hidden series do not create coverage deficits", () => {
  const spec = applyChartComposerCapabilityOptions(buildFundamentalChartPreset(["MSFT", "V"]), "fundamental-series", { metric: "operatingMargin", period: "annual", periods: 2 });
  spec.series[1]!.visible = false;
  const result = limitSeriesObservations(spec, { id: spec.series[0]!.id, label: "MSFT Margin", nativeFrequency: "annual", points: [
    point("2024-06-30", 0, "2024"), point("2025-06-30", .4, "2025"),
  ] } as ResolvedSeries);
  expect(result.points.map((entry) => entry.value)).toEqual([0, .4]);
  expect(financialPeriodCoverage(spec, [result])).toHaveLength(1);
  expect(financialPeriodCoverage(spec, [result])[0]?.complete).toBe(true);
});
