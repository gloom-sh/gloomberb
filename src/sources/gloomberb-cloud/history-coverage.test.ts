import { afterEach, expect, test } from "bun:test";
import { apiClient } from "../../api-client";
import { resolveChartSpecData } from "../../time-series/resolve";
import type { ChartSpec } from "../../time-series/types";
import type { PricePoint } from "../../types/financials";
import { AssetDataRouter } from "../provider-router";
import { fallbackProvider } from "../provider-router/test-support";
import { HistoryCoverageError } from "../history-coverage";
import { GloomberbCloudProvider } from "./index";
import { mapPricePoint } from "./normalizers";

const originalHistory = apiClient.getCloudHistory;
const originalQuote = apiClient.getCloudQuote;
afterEach(() => { apiClient.getCloudHistory = originalHistory; apiClient.getCloudQuote = originalQuote; });
const baseCoverage = { source: "yahoo" as const, reasonCode: "UNVERIFIED_PREDECESSOR_LINEAGE" as const,
  verifiedLineageStart: "2005-07-21" as const, sourceUrl: "https://www.shell.com/investors/information-for-shareholders/share-prices.html",
  firstBarDate: null, lastBarDate: null, barCount: 0 };
const baseSource = { provider: "yahoo" as const, symbol: "SHEL" as const, exchange: "LSE" as const, currency: "GBP" as const, verifiedLineageStart: "2005-07-21" as const };
const spec = (start: string, end: string): ChartSpec => ({ version: 2,
  viewport: { range: "ALL", resolution: "1d", dateWindow: { start, end } }, panels: [{ id: "main" }], studies: [],
  series: [{ id: "shell", label: "Shell London", source: { kind: "security", instrument: { symbol: "SHEL", exchange: "LSE" }, fieldId: "market.close" },
    style: "line", transform: "raw", axis: "left", panelId: "main", interpolation: "none" }],
});
const sources = (router: AssetDataRouter) => ({ dataProvider: router, now: new Date("2026-09-11T12:00:00Z"),
  loadFredSeries: async () => { throw Error("No FRED source belongs to this fixture"); } });
const cloud = () => {
  apiClient.getCloudQuote = async () => ({ status: "success", data: { symbol: "SHEL", price: 35.33, currency: "GBP", change: 0,
    changePercent: 0, lastUpdated: Date.now(), providerId: "gloomberb-cloud", instrumentType: "EQUITY", listingExchangeName: "LSE" } });
  return new GloomberbCloudProvider();
};

for (const [provider, displayName] of [["yahoo", "Yahoo"], ["twelvedata", "Twelve Data"]] as const) {
const coverage = { ...baseCoverage, source: provider };
const source = { ...baseSource, provider };
test(`${displayName}: empty historical API reason reaches cloud/router/headless`, async () => {
  for (const fullRangeAvailable of [false, true]) {
    const calls: unknown[] = [];
    apiClient.getCloudHistory = async (symbol, exchange, params) => {
      calls.push({ symbol, exchange, params });
      if (fullRangeAvailable && params?.startDate?.startsWith("1976")) return { status: "success", data: [
        { date: "2005-07-25", close: 17.47, historySource: source }, { date: "2026-09-07", close: 35.33, historySource: source },
      ] };
      return { status: "empty", data: null, coverage };
    };
    const router = new AssetDataRouter(cloud());
    const result = await resolveChartSpecData(spec("1997-01-01", "1997-12-31"), sources(router));
    expect(result.errors.join(" ")).toContain(`${displayName} London Shell coverage begins 2005-07-21`);
    expect(result.errors.join(" ")).not.toContain("Choose Auto");
    expect(result.series.flatMap((series) => series.points)).toEqual([]);
    expect(calls.length).toBeGreaterThanOrEqual(2);
  }
});

test(`${displayName}: modern empty windows keep missing-range semantics`, async () => {
  apiClient.getCloudHistory = async () => ({ status: "empty", data: null, coverage });
  const provider = cloud();
  for (const start of ["2026-01-01", "2040-01-01"]) {
    let error: unknown;
    try { await provider.getDetailedPriceHistory("SHEL", "LSE", new Date(start), new Date(start.slice(0, 4) + "-12-31"), "1wk"); }
    catch (value) { error = value; }
    expect(error).not.toBeInstanceOf(HistoryCoverageError);
    const result = await resolveChartSpecData(spec(start, start.slice(0, 4) + "-12-31"), sources(new AssetDataRouter(provider)));
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.join(" ")).not.toContain("lineage");
  }
});

test(`${displayName}: independent nonempty history wins over empty coverage`, async () => {
  apiClient.getCloudHistory = async () => ({ status: "empty", data: null, coverage });
  const independent: PricePoint[] = [{ date: new Date("1997-06-30"), close: 4.095 }, { date: new Date("1997-07-01"), close: 4.315 }];
  const provider = { ...fallbackProvider, id: "independent", getDetailedPriceHistory: async () => independent,
    getPriceHistoryForResolution: async () => independent, getPriceHistory: async () => independent };
  const router = new AssetDataRouter(cloud(), [provider]);
  const result = await resolveChartSpecData(spec("1997-01-01", "1997-12-31"), sources(router));
  expect(result.errors).toEqual([]);
  expect(result.warnings.join(" ")).not.toContain("lineage");
  expect(result.series[0]?.points.map((point) => point.value)).toEqual([4.095, 4.315]);
  // An independent empty source has no affected-provider restriction of its own.
  const empty = new AssetDataRouter({ ...provider, getDetailedPriceHistory: async () => [], getPriceHistoryForResolution: async () => [], getPriceHistory: async () => [] });
  const missing = await resolveChartSpecData(spec("1997-01-01", "1997-12-31"), sources(empty));
  expect(missing.errors.join(" ")).not.toContain("lineage");
});

test(`${displayName}: retained provenance explains ALL and preserves modern windows`, async () => {
  apiClient.getCloudHistory = async () => ({ status: "success", data: [
    { date: "2005-07-25", close: 17.47, historySource: source }, { date: "2026-09-07", close: 35.33, historySource: source },
  ] });
  const router = new AssetDataRouter(cloud());
  const all = spec("1996-01-01", "2026-09-10");
  const result = await resolveChartSpecData(all, sources(router));
  expect(result.errors).toEqual([]);
  expect(result.warnings.join(" ")).toContain("earlier share lineage is unverified");
  expect(result.series[0]?.points.map((point) => point.value)).toEqual([17.47, 35.33]);
  const modern = await resolveChartSpecData(spec("2025-01-01", "2026-09-10"), sources(router));
  expect(modern.warnings.join(" ")).not.toContain("lineage");
  expect(mapPricePoint({ date: "2006-01-03", close: 18.27, historySource: source }).historySource).toEqual(source);
  for (const invalid of [5, ["yahoo"], { ...source, currency: "USD" }, { ...source, verifiedLineageStart: "1997-01-01" }, { ...source, verifiedLineageStart: undefined }]) {
    expect(mapPricePoint({ date: "2006-01-03", close: 18.27, historySource: invalid as never }).historySource).toBeUndefined();
  }
});

test(`${displayName}: Auto retains an earlier restriction after empty default fallback`, async () => {
  const provider = { ...fallbackProvider,
    getDetailedPriceHistory: async () => { throw new HistoryCoverageError(providerName); },
    getPriceHistoryForResolution: async () => { throw new HistoryCoverageError(providerName); },
    getPriceHistory: async (): Promise<PricePoint[]> => [],
  };
  const auto = spec("1997-01-01", "1997-12-31"); auto.viewport.resolution = "auto";
  const providerName = source.provider;
  const result = await resolveChartSpecData(auto, { ...sources(new AssetDataRouter(cloud())), dataProvider: provider });
  expect(result.errors.join(" ")).toContain(`${displayName} London Shell coverage begins`);
  const independent = [{ date: new Date("1997-06-30"), close: 4.095 }, { date: new Date("1997-07-01"), close: 4.315 }];
  const recovered = await resolveChartSpecData(auto, { ...sources(new AssetDataRouter(cloud())),
    dataProvider: { ...provider, getPriceHistory: async () => independent } });
  expect(recovered.errors).toEqual([]);
  expect(recovered.warnings.join(" ")).not.toContain("lineage");
  expect(recovered.series[0]?.points.map((point) => point.value)).toEqual([4.095, 4.315]);
});
}
