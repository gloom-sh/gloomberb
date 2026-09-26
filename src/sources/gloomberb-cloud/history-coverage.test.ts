import { afterEach, expect, test } from "bun:test";
import { apiClient } from "../../api-client";
import type { CloudHistoryCoverage } from "../../api-client/types";
import { resolveChartSpecData } from "../../time-series/resolve";
import type { ChartSpec } from "../../time-series/types";
import type { PricePoint } from "../../types/financials";
import { AssetDataRouter } from "../provider-router";
import { fallbackProvider } from "../../test-support/data-provider";
import { HistoryCoverageError } from "../history-coverage";
import { GloomberbCloudProvider } from "./index";

const originalHistory = apiClient.getCloudHistory;
const originalQuote = apiClient.getCloudQuote;
afterEach(() => { apiClient.getCloudHistory = originalHistory; apiClient.getCloudQuote = originalQuote; });
// A source can vouch for prices from a boundary date for any reason; no symbol is special.
const described = { source: "fixture", sourceUrl: "https://example.com/coverage", firstBarDate: null, lastBarDate: null, barCount: 0 };
const boundaries: CloudHistoryCoverage[] = [
  { ...described, reasonCode: "UNVERIFIED_PREDECESSOR_LINEAGE", verifiedLineageStart: "2005-07-21" },
  { ...described, inceptionDate: "2005-07-21", firstAllowedBarDate: "2005-07-21" },
];
const notice = "Verified price history starts 2005-07-21";
const spec = (start: string, end: string): ChartSpec => ({ version: 2,
  viewport: { range: "ALL", resolution: "1d", dateWindow: { start, end } }, panels: [{ id: "main" }], studies: [],
  series: [{ id: "acme", label: "Acme", source: { kind: "security", instrument: { symbol: "ACME", exchange: "LSE" }, fieldId: "market.close" },
    style: "line", transform: "raw", axis: "left", panelId: "main", interpolation: "none" }],
});
const sources = (router: AssetDataRouter) => ({ dataProvider: router, now: new Date("2026-09-11T12:00:00Z"),
  loadFredSeries: async () => { throw Error("No FRED source belongs to this fixture"); } });
const cloud = () => {
  apiClient.getCloudQuote = async () => ({ status: "success", data: { symbol: "ACME", price: 35.33, currency: "GBP", change: 0,
    changePercent: 0, lastUpdated: Date.now(), providerId: "gloomberb-cloud", instrumentType: "EQUITY", listingExchangeName: "LSE" } });
  return new GloomberbCloudProvider();
};
const served = [{ date: "2005-07-25", close: 17.47 }, { date: "2026-09-07", close: 35.33 }];

test("an empty window before a declared boundary explains itself through cloud, router and chart", async () => {
  for (const coverage of boundaries) for (const fullRangeAvailable of [false, true]) {
    const calls: unknown[] = [];
    apiClient.getCloudHistory = async (symbol, exchange, params) => {
      calls.push({ symbol, exchange, params });
      if (fullRangeAvailable && params?.startDate?.startsWith("1976")) return { status: "success", data: served, coverage };
      return { status: "empty", data: null, coverage };
    };
    const result = await resolveChartSpecData(spec("1997-01-01", "1997-12-31"), sources(new AssetDataRouter(cloud())));
    expect(result.errors.join(" ")).toContain(notice);
    expect(result.errors.join(" ")).not.toContain("Choose Auto");
    expect(result.series.flatMap((series) => series.points)).toEqual([]);
    expect(calls.length).toBeGreaterThanOrEqual(2);
  }
});

test("empty windows after the boundary, or with an unreadable boundary, stay ordinary misses", async () => {
  for (const [coverage, start] of [[boundaries[0], "2026-01-01"], [boundaries[1], "2040-01-01"],
    [{ verifiedLineageStart: "July 2005" }, "1997-01-01"], [{ firstAllowedBarDate: 20050721 }, "1997-01-01"]] as const) {
    apiClient.getCloudHistory = async () => ({ status: "empty", data: null, coverage: coverage as CloudHistoryCoverage });
    const provider = cloud();
    let error: unknown;
    try { await provider.getDetailedPriceHistory("ACME", "LSE", new Date(start), new Date(start.slice(0, 4) + "-12-31"), "1wk"); }
    catch (value) { error = value; }
    expect(error).not.toBeInstanceOf(HistoryCoverageError);
    const result = await resolveChartSpecData(spec(start, start.slice(0, 4) + "-12-31"), sources(new AssetDataRouter(provider)));
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.join(" ")).not.toContain("Verified price history");
  }
});

test("independent nonempty history wins over an empty covered response", async () => {
  apiClient.getCloudHistory = async () => ({ status: "empty", data: null, coverage: boundaries[0] });
  const independent: PricePoint[] = [{ date: new Date("1997-06-30"), close: 4.095 }, { date: new Date("1997-07-01"), close: 4.315 }];
  const provider = { ...fallbackProvider, id: "independent", getDetailedPriceHistory: async () => independent,
    getPriceHistoryForResolution: async () => independent, getPriceHistory: async () => independent };
  const result = await resolveChartSpecData(spec("1997-01-01", "1997-12-31"), sources(new AssetDataRouter(cloud(), [provider])));
  expect(result.errors).toEqual([]);
  expect(result.warnings.join(" ")).not.toContain(notice);
  expect(result.series[0]?.points.map((point) => point.value)).toEqual([4.095, 4.315]);
});

test("a served boundary warns only while the visible window starts before it", async () => {
  for (const coverage of boundaries) {
    apiClient.getCloudHistory = async () => ({ status: "success", data: served, coverage });
    const router = new AssetDataRouter(cloud());
    const all = await resolveChartSpecData(spec("1996-01-01", "2026-09-10"), sources(router));
    expect(all.errors).toEqual([]);
    expect(all.warnings.join(" ")).toContain(notice);
    expect(all.series[0]?.points.map((point) => point.value)).toEqual([17.47, 35.33]);
    const modern = await resolveChartSpecData(spec("2025-01-01", "2026-09-10"), sources(router));
    expect(modern.warnings.join(" ")).not.toContain(notice);
  }
});

test("Auto keeps an earlier boundary after an empty default fallback", async () => {
  const provider = { ...fallbackProvider,
    getDetailedPriceHistory: async () => { throw new HistoryCoverageError("2005-07-21"); },
    getPriceHistoryForResolution: async () => { throw new HistoryCoverageError("2005-07-21"); },
    getPriceHistory: async (): Promise<PricePoint[]> => [],
  };
  const auto = spec("1997-01-01", "1997-12-31"); auto.viewport.resolution = "auto";
  const result = await resolveChartSpecData(auto, { ...sources(new AssetDataRouter(cloud())), dataProvider: provider });
  expect(result.errors.join(" ")).toContain(notice);
  const independent = [{ date: new Date("1997-06-30"), close: 4.095 }, { date: new Date("1997-07-01"), close: 4.315 }];
  const recovered = await resolveChartSpecData(auto, { ...sources(new AssetDataRouter(cloud())),
    dataProvider: { ...provider, getPriceHistory: async () => independent } });
  expect(recovered.errors).toEqual([]);
  expect(recovered.warnings.join(" ")).not.toContain(notice);
  expect(recovered.series[0]?.points.map((point) => point.value)).toEqual([4.095, 4.315]);
});
