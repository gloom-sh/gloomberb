import { expect, test } from "bun:test";
import { createSnapshotDataProvider } from "./snapshot-provider";
import { createTestDataProvider } from "../test-support/data-provider";
import { loadChartPaneModel, chartHeadless } from "../plugins/builtin/chart-composer/headless";
import { buildPriceChartPreset } from "../plugins/builtin/chart-composer/presets";
import { createDefaultConfig } from "../types/config";
import { quoteMetadataFromQuote } from "./quotes/metadata";
import { buildDesktopShotPayload, createDesktopShotBridge } from "../cli/pane-functions/screenshot";
import { decodeRpcValue, encodeRpcValue } from "../renderers/electrobun/view/rpc-codec";
import type { InstrumentRef } from "./request-types";
import type { Quote } from "../types/financials";

const target = (expiry: string): InstrumentRef => ({ symbol: "ACME", exchange: "CBOE", brokerId: "fixture", brokerInstanceId: "desk", instrument: {
  brokerId: "fixture", brokerInstanceId: "desk", symbol: "ACME", secType: "FUT", currency: "USD", exchange: "CBOE", lastTradeDateOrContractMonth: expiry, multiplier: "100",
} });
const targets = [target("20261218"), target("20270319")];
const quote = (price: number): Quote => ({ symbol: "ACME", price, currency: "USD", instrumentType: "FUTURE", listingExchangeName: "CBOE", change: 0, changePercent: 0, lastUpdated: Date.now() });
const price = (context: any) => context?.instrument?.lastTradeDateOrContractMonth === "20261218" ? 10 : 20;
const history = (value: number) => [0, 1].map(i => ({ date: new Date(`2026-09-11T14:3${i}:00Z`), close: value }));
const revive = (value: unknown) => JSON.parse(JSON.stringify(value), (key, entry) => key === "date" ? new Date(entry) : entry);

test("two contract chart observations survive JSON snapshot and actual screenshot payload reconstruction", async () => {
  const spec = buildPriceChartPreset("ACME:CBOE");
  spec.studies = [];
  spec.viewport.dateWindow = { start: "2026-09-11", end: "2026-09-12" };
  spec.series = targets.map((instrument, i) => ({ ...spec.series[0]!, id: `future-${i}`, source: { kind: "security", instrument, fieldId: "market.close" } }));
  const provider = createTestDataProvider({
    getTickerFinancials: async (_s, _e, context) => ({ quote: quote(price(context)), annualStatements: [], quarterlyStatements: [], priceHistory: [] }),
    getQuoteMetadata: async (_s, _e, context) => quoteMetadataFromQuote(quote(price(context))),
    getQuote: async (_s, _e, context) => quote(price(context)),
    getPriceHistory: async (_s, _e, _r, context) => history(price(context)),
    getPriceHistoryForResolution: async (_s, _e, _r, _resolution, context) => history(price(context)),
    getDetailedPriceHistory: async (_s, _e, _start, _end, _resolution, context) => history(price(context)),
  });
  const config = createDefaultConfig(":memory:");
  const context = { marketData: provider, config, apiClient: {} as any, signal: new AbortController().signal };
  const first = await loadChartPaneModel(spec, context);
  expect(first.series.map(s => s.points.at(-1)?.value)).toEqual([10, 20]);
  expect(first.snapshot.financials).toEqual([]); expect(first.snapshot.instrumentFinancials).toHaveLength(2);
  let fallbackCalls = 0;
  const fail = async () => { fallbackCalls++; throw new Error("Unexpected fallback"); };
  const fallback = createTestDataProvider({ getQuote: fail, getQuoteMetadata: fail, getTickerFinancials: fail, getPriceHistory: fail, getPriceHistoryForResolution: fail, getDetailedPriceHistory: fail });
  const snapshot = createSnapshotDataProvider(revive(first.snapshot), fallback);
  const second = await loadChartPaneModel(spec, { ...context, marketData: snapshot });
  expect(second.series.map(s => s.points)).toEqual(first.series.map(s => s.points)); expect(fallbackCalls).toBe(0);
  const definition = chartHeadless("graph-price-pane");
  const resolved: any = { pane: { id: "chart-composer" }, token: "GP", headless: definition, options: {}, capability: { options: [] }, instance: { instanceId: "chart", paneId: "chart-composer", settings: { chartSpec: spec } } };
  const payload = await buildDesktopShotPayload(resolved, { config, dataProvider: provider, store: { loadTicker: async () => null } } as any, "ACME", {}, 800, 600, null, 1, null);
  expect(payload.instrumentFinancials).toHaveLength(2); expect(payload.financials).toEqual([]);
  const decoded = decodeRpcValue<typeof payload>(JSON.parse(JSON.stringify(encodeRpcValue(payload))));
  expect(decoded.instrumentFinancials?.[0]?.financials.priceHistory[0]?.date).toBeInstanceOf(Date);
  expect(decoded.instrumentFinancials?.map(entry => entry.instrument)).toEqual(targets);
  const captured = createSnapshotDataProvider(decoded, fallback);
  const reconstructed = await loadChartPaneModel(spec, { ...context, marketData: captured });
  expect(reconstructed.series.map(s => s.points)).toEqual(first.series.map(s => s.points)); expect(fallbackCalls).toBe(0);
  const bridgeRequests: unknown[] = [];
  const dispatcher = createDesktopShotBridge({ dataProvider: createTestDataProvider({
    getQuote: async (_symbol, _exchange, context) => { bridgeRequests.push(context); return quote(30); },
    getPriceHistory: async (_symbol, _exchange, _range, context) => { bridgeRequests.push(context); return history(30); },
  }) });
  const missingProvider = createSnapshotDataProvider(decoded, createTestDataProvider({
    getQuote: (symbol, exchange, context) => dispatcher.marketData("getQuote", JSON.parse(JSON.stringify([symbol, exchange, context]))) as Promise<Quote>,
    getPriceHistory: (symbol, exchange, range, context) => dispatcher.marketData("getPriceHistory", JSON.parse(JSON.stringify([symbol, exchange, range, context]))) as Promise<ReturnType<typeof history>>,
  }));
  const missing = target("20270618");
  expect((await missingProvider.getQuote("ACME", "CBOE", missing)).price).toBe(30);
  expect((await missingProvider.getPriceHistory("ACME", "CBOE", "1Y", missing)).at(-1)?.close).toBe(30);
  expect(bridgeRequests).toEqual([missing, missing]);
});

test("intraday capture and context-aware quote/history batches preserve identities and legacy public snapshots", async () => {
  const spec = buildPriceChartPreset("ACME:CBOE"); spec.viewport = { range: "1D", resolution: "1m" };
  spec.studies = [];
  spec.series = targets.map((instrument, i) => ({ ...spec.series[0]!, id: `future-${i}`, source: { kind: "security", instrument, fieldId: "market.close" } }));
  const seen: any[] = [];
  const provider = createTestDataProvider({
    getPriceHistoryForResolution: async (_s, _e, _r, _resolution, context) => { seen.push(context); return history(price(context)); },
    getQuoteMetadata: async (_s, _e, context) => quoteMetadataFromQuote(quote(price(context))),
  });
  const context = { marketData: provider, config: createDefaultConfig(":memory:"), apiClient: {} as any, signal: new AbortController().signal, settings: { chartSpec: spec } };
  const model = await chartHeadless("graph-intraday-price-pane").load({ argument: "ACME", rawArgument: "ACME", symbols: ["ACME"], options: {} }, context);
  expect(model.series.map(s => s.points.at(-1)?.value)).toEqual([10, 20]);
  expect(seen.map(c => c?.instrument?.lastTradeDateOrContractMonth).sort()).toEqual(["20261218", "20270319"]);
  expect(model.snapshot.intradayHistories.map(h => h.target?.instrument?.lastTradeDateOrContractMonth)).toEqual(["20261218", "20270319"]);
  const publicData = { quote: quote(999), annualStatements: [], quarterlyStatements: [], priceHistory: history(999) };
  const ownData = (n: number) => ({ ...publicData, quote: quote(n), priceHistory: history(n) });
  const requests: any[] = [];
  const snapshot = createSnapshotDataProvider({ financials: [["ACME:CBOE", publicData]], instrumentFinancials: targets.map((instrument, i) => ({ instrument, financials: ownData((i + 1) * 10) })) },
    createTestDataProvider({ getQuote: async (_s, _e, context) => { requests.push(context); return quote(30); } }));
  const batch = await snapshot.getQuotesBatch!(targets.map(({ symbol, exchange, ...context }) => ({ symbol, exchange, context })));
  expect(batch.map(r => r.quote?.price)).toEqual([10, 20]);
  expect((await snapshot.getTickerFinancialsBatch!(targets)).map(r => r.financials?.quote?.price)).toEqual([10, 20]);
  expect((await snapshot.getCachedFinancialsForTargets!(targets))?.size).toBe(0);
  expect((await snapshot.getCachedFinancialsForTargets!([targets[0]!]))?.get("ACME")?.quote?.price).toBe(10);
  expect((await snapshot.getQuote("ACME", "CBOE")).price).toBe(999);
  const missing = target("20270618");
  expect((await snapshot.getQuote("ACME", "CBOE", missing)).price).toBe(30); expect(requests[0]?.instrument?.lastTradeDateOrContractMonth).toBe("20270618");
  for (const [i, instrument] of targets.entries()) expect((await snapshot.getPriceHistory("ACME", "CBOE", "1Y", instrument)).at(-1)?.close).toBe((i + 1) * 10);
  const restored = createSnapshotDataProvider(revive(model.snapshot), provider);
  const replay = await chartHeadless("graph-intraday-price-pane").load({ argument: "ACME", rawArgument: "ACME", symbols: ["ACME"], options: {} }, { ...context, marketData: restored });
  expect(replay.series.map(s => s.points)).toEqual(model.series.map(s => s.points));
});
