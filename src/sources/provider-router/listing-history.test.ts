import { afterEach, expect, setSystemTime, test } from "bun:test";
import { apiClient } from "../../api-client";
import { AppPersistence } from "../../data/app-persistence";
import { buildComparisonChartPreset } from "../../plugins/builtin/chart-composer/presets";
import { loadChartPaneModel } from "../../plugins/builtin/chart-composer/headless";
import { createDefaultConfig } from "../../types/config";
import type { CachedFinancialsTarget } from "../../types/data-provider";
import type { PricePoint } from "../../types/financials";
import { GloomberbCloudProvider } from "../gloomberb-cloud";
import { hasCircleOfferingPriceHistory } from "../listing-history";
import { AssetDataRouter } from "./index";
import { cacheRouterResource } from "./cache";
import { createTestFinancials, createTestQuote, fallbackProvider } from "../../test-support/data-provider";

const originalHistory = apiClient.getCloudHistory;
const originalQuote = apiClient.getCloudQuote;
afterEach(() => { apiClient.getCloudHistory = originalHistory; apiClient.getCloudQuote = originalQuote; setSystemTime(); });
// Captured 2026-09-16: June 4 is the issuer's $31 offering, not a traded session.
const offer: PricePoint = { date: new Date("2025-06-04"), open: 31, high: 31, low: 31, close: 31, volume: 0 };
const first: PricePoint = { date: new Date("2025-06-05"), open: 69, high: 103.75, low: 64, close: 83.23, volume: 47192000 };
const next: PricePoint = { date: new Date("2025-06-06"), open: 96.39, high: 123.515, low: 92.95, close: 107.7, volume: 60706300 };
const month: PricePoint = { date: new Date("2025-06-01"), open: 31, high: 298.98999, low: 31, close: 181.28999, volume: 828616800 };
const correctMonth: PricePoint = { ...month, open: 69, low: 64 };
const policy = { staleMs: 60_000, expireMs: 600_000 };
const equal = (a: unknown, b: unknown) => expect(JSON.stringify(a)).toBe(JSON.stringify(b));

function cloudHistory(points: PricePoint[]) {
  apiClient.getCloudHistory = async () => ({ status: "success", data: points.map(point => ({ ...point, date: point.date.toISOString() })) });
  return new GloomberbCloudProvider();
}

test("Cloud rejects the attested daily offer and contaminated inception aggregate as whole windows, accepting corrected bars", async () => {
  for (const points of [[offer, first, next], [{ ...offer, date: new Date("2025-06-05T13:40:00Z") }, first, next], [month, { ...month, date: new Date("2025-07-01"), open: 184.67, low: 171.5 }]]) {
    const cloud = cloudHistory(points);
    await expect(cloud.getPriceHistory("CRCL:XNYS", "", "ALL")).rejects.toThrow("IPO offer price");
    await expect(cloud.getPriceHistory("CRCL", "", "ALL")).rejects.toThrow("IPO offer price");
    await expect(cloud.getPriceHistoryForResolution("CRCL", "NYSE", "5Y", "1mo")).rejects.toThrow("IPO offer price");
    await expect(cloud.getDetailedPriceHistory("CRCL", "NYSE", new Date("2025-06-01"), new Date("2025-07-01"), "1d")).rejects.toThrow("IPO offer price");
  }
  for (const points of [[first, next], [correctMonth], [{ ...first, volume: 0 }], [{ ...offer, date: new Date("2025-06-06") }]]) {
    equal(await cloudHistory(points).getPriceHistory("CRCL", "NYSE", "ALL"), points);
  }
  for (const target of [{ symbol: "OTHER", exchange: "NYSE" }, { symbol: "CRCL", exchange: "LSE" }]) {
    expect(hasCircleOfferingPriceHistory([offer], target, "provider:gloomberb-cloud")).toBe(false);
  }
  for (const source of ["provider:yahoo", "provider:independent", "broker:fixture:account"]) {
    expect(hasCircleOfferingPriceHistory([offer], { symbol: "CRCL", exchange: "NYSE" }, source)).toBe(false);
  }
});

test("poisoned exact and broader Cloud caches recover from a valid alternate, then survive a new router", async () => {
  for (const mode of ["range", "resolution", "detail", "intraday"] as const) {
    const store = new AppPersistence(":memory:");
    try {
      const detailed = mode === "detail" || mode === "intraday";
      const bar = mode === "intraday" ? "5m" : "1d";
      const valid = mode === "intraday" ? [
        { ...first, date: new Date("2025-06-05T16:35:00Z"), high: 75.9, close: 75.9, volume: 6067069 },
        { date: new Date("2025-06-05T16:40:00Z"), open: 75.9, high: 88.88, low: 75.9, close: 88.88, volume: 2370973 },
      ] : [first, next];
      const bad = [mode === "intraday" ? { ...offer, date: new Date("2025-06-05T13:40:00Z") } : offer, ...valid];
      const kind = detailed ? "detailed-price-history" : "price-history";
      const variant = detailed ? `exchange=NYSE;start=2025-06-01;end=2025-06-10;bar=${bar};version=5`
        : mode === "resolution" ? "exchange=NYSE;range=ALL;resolution=1d;version=5;granularity=1"
          : "exchange=NYSE;range=ALL;version=5;calendar=1;granularity=1";
      store.resources.set({ namespace: "market", kind, entityKey: "CRCL", variantKey: variant, sourceKey: "provider:gloomberb-cloud" }, bad, { cachePolicy: policy });
      let calls = 0;
      const load = async () => { calls++; return valid; };
      const alternate = { ...fallbackProvider, id: "yahoo", getPriceHistory: load, getPriceHistoryForResolution: load, getDetailedPriceHistory: load };
      const cloud = cloudHistory(bad);
      const read = (router: AssetDataRouter) => mode === "range" ? router.getPriceHistory("CRCL", "NYSE", "ALL")
        : mode === "resolution" ? router.getPriceHistoryForResolution("CRCL", "NYSE", "5Y", "1d")
          : router.getDetailedPriceHistory("CRCL", "NYSE", new Date("2025-06-01"), new Date("2025-06-10"), bar);
      equal(await read(new AssetDataRouter(cloud, [alternate], store.resources)), valid);
      expect(calls).toBe(1);
      equal(await read(new AssetDataRouter(cloud, [alternate], store.resources)), valid);
      expect(calls).toBe(1);
    } finally { store.close(); }
  }
});

test("unavailable fallback cannot turn a mixed inception window into a later comparison baseline", async () => {
  const cloud = cloudHistory([offer, first, next]);
  apiClient.getCloudQuote = async symbol => ({ status: "success", data: createTestQuote({ symbol, listingExchangeName: symbol === "CRCL" ? "NYSE" : "ARCA" }) });
  const router = new AssetDataRouter(cloud);
  const spec = buildComparisonChartPreset(["CRCL:XNYS", "SPY:ARCX"]);
  spec.viewport = { range: "5Y", resolution: "1d", dateWindow: { start: "2025-06-01", end: "2025-06-10" } };
  const result = await loadChartPaneModel(spec, { marketData: router, apiClient, config: createDefaultConfig("/tmp/listing-history-unused"), signal: new AbortController().signal });
  expect(result.errors?.join(" ")).toContain("IPO offer price");
  expect(result.unavailableSymbols).toContain("CRCL:XNYS");
  expect(result.metadata?.priceComparison).toMatchObject({ start: null, end: null });
  expect(result.series.every(series => series.points.length === 0)).toBe(true);
});

test("cached and refreshed financial histories exclude affected offers while preserving statements and corrected history", async () => {
  const store = new AppPersistence(":memory:");
  try {
    let points = [offer, first, next];
    const financials = () => createTestFinancials({ quote: createTestQuote({ symbol: "CRCL", listingExchangeName: "NYSE", providerId: "gloomberb-cloud" }), annualStatements: [{ date: "2024-12-31", totalRevenue: 100 }], profile: { description: "Issuer" }, priceHistory: points });
    cacheRouterResource(store.resources, "financials", "CRCL", "exchange=NYSE", "provider:gloomberb-cloud", financials(), policy);
    const provider = { ...fallbackProvider, id: "gloomberb-cloud", getTickerFinancials: async () => financials() };
    const router = new AssetDataRouter(provider, [], store.resources);
    const cached = router.getCachedFinancialsForTargets([{ symbol: "CRCL", exchange: "NYSE" }]).get("CRCL");
    expect(cached?.priceHistory).toEqual([]);
    expect(cached?.annualStatements).toEqual(financials().annualStatements);
    const refreshed = await router.getTickerFinancials("CRCL", "NYSE", { statementHistory: "extended", cacheMode: "refresh" });
    expect(refreshed.priceHistory).toEqual([]);
    expect(refreshed.profile).toEqual({ description: "Issuer" });
    points = [first, next];
    equal((await router.getTickerFinancials("CRCL", "NYSE", { cacheMode: "refresh" })).priceHistory, points);
  } finally { store.close(); }
});


test("fresh financial batches sanitize both immediate deep results and retained fallbacks after a failed single fetch", async () => {
  // This exercises batch history routing, independently of extended-hours quote requirements.
  setSystemTime(new Date("2026-09-16T14:00:00Z"));
  for (const deep of [true, false]) {
    const store = new AppPersistence(":memory:");
    try {
      let singleCalls = 0;
      const financials = createTestFinancials({ quote: createTestQuote({ symbol: "CRCL", listingExchangeName: "NYSE", providerId: "gloomberb-cloud" }),
        profile: { description: "Issuer" },
        annualStatements: deep ? Array.from({ length: 5 }, (_, index) => ({ date: `${2020 + index}-12-31`, inventory: 100 })) : [],
        priceHistory: [offer, first, next] });
      const provider = { ...fallbackProvider, id: "gloomberb-cloud",
        getTickerFinancialsBatch: async (targets: CachedFinancialsTarget[]) => targets.map(target => ({ target, financials })),
        getTickerFinancials: async () => { singleCalls++; throw Error("controlled single-request failure"); },
      };
      const router = new AssetDataRouter(provider, [], store.resources);
      const result = await router.getTickerFinancialsBatch([{ symbol: "CRCL", exchange: "NYSE" }], { forceRefresh: true });
      expect(result[0]?.financials?.priceHistory).toEqual([]);
      expect(result[0]?.financials?.annualStatements).toEqual(financials.annualStatements);
      expect(singleCalls).toBe(deep ? 0 : 1);
      expect(router.getCachedFinancialsForTargets([{ symbol: "CRCL", exchange: "NYSE" }]).get("CRCL")?.priceHistory).toEqual([]);
      expect(financials.priceHistory).toEqual([offer, first, next]);
    } finally { store.close(); }
  }
});
