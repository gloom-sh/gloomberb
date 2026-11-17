import { expect, test } from "bun:test";
import { createTestDataProvider } from "../test-support/data-provider";
import { resolveChartSpecData } from "./resolve";
import { CHART_SPEC_VERSION, type ChartSpec } from "./types";

const now = new Date("2026-11-17T16:30:00Z");
const bars = (stepMs: number, count: number) => Array.from({ length: count }, (_, index) => ({
  date: new Date(now.getTime() - (count - index) * stepMs), open: 6, high: 6, low: 6, close: 6, volume: 1,
}));

test("a series a source answered in daily bars, beside a chart in 5-minute bars, names its bars", async () => {
  const chart: ChartSpec = {
    version: CHART_SPEC_VERSION, viewport: { range: "1W", resolution: "auto" }, panels: [{ id: "main" }], studies: [],
    series: [["COPX", "ARCA"], ["HG=F", "CMX"]].map(([symbol, exchange]) => ({
      id: symbol!, source: { kind: "security", instrument: { symbol: symbol!, exchange }, fieldId: "market.close" },
      style: "line", transform: "raw", axis: "left", panelId: "main", interpolation: "none",
    })),
  };
  const result = await resolveChartSpecData(chart, {
    now,
    dataProvider: createTestDataProvider({
      getQuote: async (symbol) => ({ symbol, currency: "USD", instrumentType: symbol === "HG=F" ? "FUTURE" : "ETF",
        price: 6, change: 0, changePercent: 0, lastUpdated: now.getTime() }),
      getChartResolutionSupport: async () => [{ resolution: "5m", maxRange: "1M" }, { resolution: "1d", maxRange: "ALL" }],
      // Copper's 5-minute bars time out; the default read that follows answers daily ones.
      getPriceHistoryForResolutionWithMetadata: async (symbol, _exchange, _range, resolution) => {
        if (symbol === "HG=F") throw new Error("Cloud market request timed out after 10000ms");
        return { points: bars(5 * 60_000, 300), resolution };
      },
      getPriceHistoryWithMetadata: async () => ({ points: bars(86_400_000, 22), resolution: "1d" }),
    }),
  });
  expect(result.series.map((series) => series.historyResolution)).toEqual(["5m", "1d"]);
  const copper = result.series.find((series) => series.id === "HG=F")!;
  expect(result.warnings).toContain(`${copper.label}: daily bars, not the chart's 5-minute bars.`);
  // The series in the chart's own bars says nothing.
  expect(result.warnings.filter((warning) => warning.includes("bars, not the chart's"))).toHaveLength(1);
});
