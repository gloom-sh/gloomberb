import { expect, test } from "bun:test";
import { createTestDataProvider } from "../test-support/data-provider";
import { ChartResolveCache, resolveChartSpecData } from "./resolve";
import { CHART_SPEC_VERSION, type ChartSpec } from "./types";

test("calendar windows and counts share extended history while current multiples use a separate default flight", async () => {
 const calls: Array<string | undefined> = [];
 const provider = createTestDataProvider({ async getTickerFinancials(_symbol, _exchange, context) {
  calls.push(context?.statementHistory);
  await new Promise(resolve => setTimeout(resolve, 1));
  return { annualStatements: [{ date: "2025-12-31", totalRevenue: 100 }], quarterlyStatements: [], priceHistory: [] };
 } });
 const spec = (maxPoints?: number): ChartSpec => ({ version: CHART_SPEC_VERSION, viewport: { range: "ALL", resolution: "auto", maxPoints }, panels: [{ id: "main" }], studies: [], series: [{ id: "revenue", style: "line", axis: "left", panelId: "main", transform: "raw", interpolation: "none", source: { kind: "security", instrument: { symbol: "MSFT", exchange: "NASDAQ" }, fieldId: "fundamental.totalRevenue", period: "annual" } }] });
 const cache = new ChartResolveCache();
 const snapshot = spec();
 snapshot.series[0]!.source = { kind: "security", instrument: { symbol: "MSFT", exchange: "NASDAQ" }, fieldId: "valuation.forwardPE" };
 const fiveYear = spec(); fiveYear.viewport.range = "5Y";
 await Promise.all([snapshot, fiveYear, spec(10), spec(20)].map(value => resolveChartSpecData(value, { dataProvider: provider }, cache)));
 expect(calls.sort()).toEqual(["extended", undefined]);
});
