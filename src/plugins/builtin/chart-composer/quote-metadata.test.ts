import { expect, test } from "bun:test";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createDefaultConfig } from "../../../types/config";
import type { HeadlessPaneContext } from "../../../types/headless";
import type { QuoteMetadata } from "../../../types/financials";
import { createSnapshotDataProvider } from "../../../market-data/snapshot-provider";
import { AssetDataRouter } from "../../../sources/provider-router";
import { loadChartPaneModel } from "./headless";
import { buildPriceChartPreset } from "./presets";
import { ChartResolveCache, resolveChartSpecData } from "../../../time-series/resolve";
import { AppPersistence } from "../../../data/app-persistence";

test("historical quote metadata survives headless export and snapshot reload without a current price", async () => {
  for (const [symbol, exchange, currency, instrumentType, unit] of [
    ["EURUSD=X", "", "USD", "CURRENCY", "USD"],
    ["USDEUR=X", "CCY", "EUR", "CURRENCY", "EUR"],
    ["JPY=X", "CCY", "JPY", "CURRENCY", "JPY"],
    ["NESN", "SWX", "CHF", "EQUITY", "CHF/share"],
    ["BTC-USD", "CCC", "USD", "CRYPTOCURRENCY", "USD/unit"],
  ] as const) {
    const metadata: QuoteMetadata = { symbol, listingExchangeName: exchange || "CCY", currency, instrumentType,
      source: { providerId: "captured-provider", lastUpdated: Date.parse("2026-01-15"), stale: true } };
    let metadataCalls = 0;
    let quoteCalls = 0;
    const history = [{ date: new Date("2026-01-15"), close: 1.1 }, { date: new Date("2026-01-16"), close: 1.2 }];
    const provider = createTestDataProvider({
      getQuote: async () => { quoteCalls++; throw new Error("Quote explicitly stale"); },
      getQuoteMetadata: async () => { metadataCalls++; return metadata; },
      getTickerFinancials: async () => { throw new Error("Company statements unavailable"); },
      getPriceHistory: async () => history, getPriceHistoryForResolution: async () => history,
      getDetailedPriceHistory: async () => history,
    });
    const routed = new AssetDataRouter(provider);
    const spec = buildPriceChartPreset(exchange ? `${symbol}:${exchange}` : symbol);
    spec.viewport = { range: "1M", resolution: "1d", dateWindow: { start: "2026-01-15", end: "2026-01-16" } };
    const context: HeadlessPaneContext = { marketData: routed, apiClient: {} as HeadlessPaneContext["apiClient"],
      config: createDefaultConfig("/tmp/metadata-test-unused"), signal: new AbortController().signal };
    const model = await loadChartPaneModel(spec, context);
    expect(model.series[0]?.unit).toBe(unit);
    expect(model.series[0]?.points.map(point => point.value)).toEqual([1.1, 1.2]);
    expect(model.snapshot.financials[0]?.[1].quote).toBeUndefined();
    expect(model.snapshot.financials[0]?.[1].quoteMetadata).toEqual(metadata);
    expect(metadataCalls).toBe(1);
    // Revive the exact serialized export; its metadata must win without a live request.
    const exported = JSON.parse(JSON.stringify(model.snapshot), (key, value) => key === "date" ? new Date(value) : value);
    const snapshot = createSnapshotDataProvider(exported, createTestDataProvider({
      getQuote: async () => { throw new Error("Unexpected quote lookup"); },
      getQuoteMetadata: async () => { throw new Error("Unexpected metadata lookup"); },
      getPriceHistory: async () => { throw new Error("Unexpected history lookup"); },
    }));
    const reloaded = await loadChartPaneModel(spec, { ...context, marketData: snapshot });
    expect(reloaded.series[0]?.unit).toBe(unit);
    expect(reloaded.series[0]?.points).toEqual(model.series[0]?.points);
    expect(reloaded.snapshot.financials[0]?.[1].quote).toBeUndefined();
    expect(quoteCalls).toBeLessThanOrEqual(exchange ? 0 : 1);
  }
});

test("metadata routing does not borrow a mismatched listing or fall back to a stale price", async () => {
  const expected: QuoteMetadata = { symbol: "ASML.AS", listingExchangeName: "XAMS", currency: "EUR", instrumentType: "EQUITY", source: { providerId: "matching", stale: true } };
  let quoteCalls = 0;
  const wrong = createTestDataProvider({ id: "wrong", priority: 100,
    getQuoteMetadata: async () => ({ ...expected, symbol: "ASML", listingExchangeName: "NASDAQ", currency: "USD" }),
    getQuote: async () => { quoteCalls++; throw new Error("Stale"); } });
  const matching = createTestDataProvider({ id: "matching", getQuoteMetadata: async () => expected });
  const router = new AssetDataRouter(matching, [wrong]);
  expect(await router.getQuoteMetadata("ASML:AMS", "NASDAQ")).toEqual(expected);
  expect(quoteCalls).toBe(0);
});

test("direct and captured metadata cannot cross identities or lose known fields on optional enrichment", async () => {
  const known: QuoteMetadata = { symbol: "EURUSD=X", listingExchangeName: "CCY", currency: "USD", source: { providerId: "known", lastUpdated: 1234, stale: true } };
  const typeOnly: QuoteMetadata = { symbol: "EURUSD=X", listingExchangeName: "CCY", instrumentType: "CURRENCY", source: { providerId: "enrichment", lastUpdated: 2345, stale: true } };
  const wrong: QuoteMetadata = { ...known, symbol: "JPY=X", currency: "JPY", instrumentType: "CURRENCY" };
  for (const [existing, loaded, expected] of [[undefined, wrong, "currency"], [wrong, null, "currency"], [known, null, "USD"], [known, typeOnly, "USD"]] as const) {
    const history = [{ date: new Date("2026-01-15"), close: 1.16 }];
    const provider = createTestDataProvider({ getTickerFinancials: async () => ({ quoteMetadata: existing, annualStatements: [], quarterlyStatements: [], priceHistory: history }),
      getQuoteMetadata: async () => loaded, getQuote: async () => { throw new Error("Stale"); },
      getPriceHistory: async () => history, getDetailedPriceHistory: async () => history });
    const spec = buildPriceChartPreset("EURUSD=X");
    spec.viewport.dateWindow = { start: "2026-01-15", end: "2026-01-16" };
    spec.viewport.resolution = "1d";
    const model = await loadChartPaneModel(spec, { marketData: provider, apiClient: {} as HeadlessPaneContext["apiClient"], config: createDefaultConfig("/tmp/metadata-unused"), signal: new AbortController().signal });
    expect(model.series[0]?.unit).toBe(expected);
    expect(model.series[0]?.points.map(point => point.value)).toEqual([1.16]);
    const retained = model.snapshot.financials[0]?.[1].quoteMetadata;
    if (existing === known) {
      expect(retained?.currency).toBe("USD");
      expect(retained?.source).toEqual(known.source);
      if (loaded === typeOnly) {
        expect(retained?.instrumentType).toBe("CURRENCY");
        expect(retained?.fieldSources?.instrumentType).toEqual(typeOnly.source);
      }
    } else expect(retained).toBeUndefined();
    expect(known).not.toHaveProperty("instrumentType");
  }
});

test("existing complete quote facts avoid an additional metadata request", async () => {
  let metadataCalls = 0;
  const history = [{ date: new Date("2026-01-15"), close: 100 }];
  const provider = createTestDataProvider({ getTickerFinancials: async () => ({ quote: { symbol: "AAPL", currency: "USD", instrumentType: "EQUITY", price: 999,
    change: 0, changePercent: 0, lastUpdated: Date.parse("2026-01-17"), stale: true }, annualStatements: [], quarterlyStatements: [], priceHistory: history }),
    getQuoteMetadata: async () => { metadataCalls++; return null; }, getPriceHistory: async () => history, getDetailedPriceHistory: async () => history });
  const spec = buildPriceChartPreset("AAPL");
  spec.viewport.dateWindow = { start: "2026-01-15", end: "2026-01-16" };
  spec.viewport.resolution = "1d";
  const model = await loadChartPaneModel(spec, { marketData: provider, apiClient: {} as HeadlessPaneContext["apiClient"], config: createDefaultConfig("/tmp/metadata-unused"), signal: new AbortController().signal });
  expect(model.series[0]?.unit).toBe("USD/share");
  expect(model.series[0]?.points.map(point => point.value)).toEqual([100]);
  expect(metadataCalls).toBe(0);
});

test("a temporary null metadata result can recover within the same chart cache", async () => {
  let calls = 0;
  let metadata: QuoteMetadata | null = null;
  const provider = createTestDataProvider({ getQuoteMetadata: async () => { calls++; return metadata; },
    getDetailedPriceHistory: async () => [{ date: new Date("2026-01-15"), close: 1.16 }] });
  const spec = buildPriceChartPreset("EURUSD=X:CCY");
  spec.viewport.dateWindow = { start: "2026-01-15", end: "2026-01-16" };
  spec.viewport.resolution = "1d";
  const cache = new ChartResolveCache();
  const sources = { dataProvider: provider, now: new Date("2026-01-16"), loadFredSeries: async () => { throw new Error("Unused"); } };
  expect((await resolveChartSpecData(spec, sources, cache)).series[0]?.unit).toBe("currency");
  metadata = { symbol: "EURUSD=X", listingExchangeName: "CCY", currency: "USD", instrumentType: "CURRENCY", source: { stale: true } };
  const recovered = await resolveChartSpecData(spec, sources, cache);
  expect(recovered.series[0]?.unit).toBe("USD");
  expect(recovered.series[0]?.points.map(point => point.value)).toEqual([1.16]);
  await resolveChartSpecData(spec, sources, cache);
  expect(calls).toBe(2);
});

test("routed metadata reuses stored quote facts while the same stale price stays unavailable", async () => {
  const store = new AppPersistence(":memory:");
  let metadataCalls = 0;
  try {
    const provider = createTestDataProvider({ id: "recorded", getQuote: async () => { throw new Error("Stale"); },
      getQuoteMetadata: async () => { metadataCalls++; return null; } });
    store.resources.set({ namespace: "market", kind: "quote", entityKey: "EURUSD=X", variantKey: "exchange=CCY", sourceKey: "provider:recorded" },
      { symbol: "EURUSD=X", listingExchangeName: "CCY", currency: "USD", instrumentType: "CURRENCY", price: 1.16,
        change: 0, changePercent: 0, lastUpdated: 1234, stale: true, providerId: "recorded" },
      { schemaVersion: 1, cachePolicy: { staleMs: 60_000, expireMs: 60_000 } });
    const router = new AssetDataRouter(provider, [], store.resources);
    expect(await router.getQuoteMetadata("EURUSD=X", "CCY")).toMatchObject({ currency: "USD", instrumentType: "CURRENCY", source: { lastUpdated: 1234, stale: true } });
    expect(metadataCalls).toBe(0);
    await expect(router.getQuote("EURUSD=X", "CCY")).rejects.toThrow("No quote provider");
  } finally { store.close(); }
});
