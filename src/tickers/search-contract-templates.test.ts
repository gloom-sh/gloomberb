import { expect, test } from "bun:test";
import { createDefaultConfig, createPaneInstance } from "../types/config";
import { appReducer, createInitialState } from "../state/app/context";
import { JsonTickerRepository } from "../data/json-ticker-repository";
import { createTestDataProvider } from "../test-support/data-provider";
import { createPaneTemplateOrThrow } from "../components/command-bar/workflow/ops";
import { tickerDetailModule } from "../plugins/builtin/ticker-detail";
import { chartComposerModule } from "../plugins/builtin/chart-composer";
import { chartHeadless } from "../plugins/builtin/chart-composer/headless";
import { resolveInstrumentForPane, resolveListingForPane, tickerForInstrument } from "../core/state/app/instrument";
import { tickerSelectionFromSearchResult } from "./selection";
import { upsertTickerFromSearchResult } from "./search";
import type { InstrumentSearchResult } from "../types/instrument";
import type { PaneInstanceConfig } from "../types/config";

test("selected futures and public listing survive actual templates, chart models and public-share restore", async () => {
  const repo = new JsonTickerRepository();
  const futures: InstrumentSearchResult[] = ["20261218", "20270319"].map(expiry => ({ providerId: "fixture", symbol: "ACME", name: `ACME ${expiry} future`, exchange: "CBOE", currency: "USD", type: "FUT",
    brokerContract: { brokerId: "fixture", brokerInstanceId: "desk", symbol: "ACME", secType: "FUT", exchange: "CBOE", currency: "USD", lastTradeDateOrContractMonth: expiry, multiplier: "100" } }));
  for (const result of futures) await upsertTickerFromSearchResult(repo, result);
  const ticker = (await repo.loadTicker("ACME"))!;
  let state = createInitialState(createDefaultConfig(":memory:")); state.tickers.set("ACME", ticker);
  state.config.layout = { dockRoot: null, floating: [], detached: [], instances: [] };
  const calls: any[] = [];
  const quote = (context?: any) => ({ symbol: "ACME", name: "ACME common stock", price: context?.instrument?.lastTradeDateOrContractMonth === "20261218" ? 10 : context?.instrument ? 20 : 30,
    currency: context?.instrument ? "USD" : "EUR", instrumentType: context?.instrument ? "FUTURE" : "EQUITY", exchangeName: "CBOE", change: 0, changePercent: 0, lastUpdated: Date.now() });
  const provider = createTestDataProvider({ getQuote: async (_s, _e, context) => { calls.push(context); return quote(context); },
    getTickerFinancials: async (_s, _e, context) => ({ quote: quote(context), annualStatements: [], quarterlyStatements: [], priceHistory: [] }),
    getPriceHistoryForResolution: async (_s, _e, _r, _resolution, context) => [{ date: new Date("2026-09-11"), close: quote(context).price }],
    getPriceHistory: async (_s, _e, _r, context) => [{ date: new Date("2026-09-11"), close: quote(context).price }],
  });
  const templates = [...tickerDetailModule.paneTemplates!, ...chartComposerModule.paneTemplates!];
  const placed: PaneInstanceConfig[] = [];
  const registry: any = { paneTemplates: new Map(templates.map(t => [t.id, t])), panes: new Map([...tickerDetailModule.panes!, ...chartComposerModule.panes!].map(p => [p.id, p])), getPaneTemplatePluginId() {}, events: { emit() {} } };
  const deps = { dataProvider: provider, tickerRepository: repo, getState: () => state, dispatch: (action: any) => { state = appReducer(state, action); }, pluginRegistry: registry,
    buildPaneInstance: (id: string, options: any) => createPaneInstance(id, options), placePaneInstance: (pane: PaneInstanceConfig) => { placed.push(pane); state.config.layout.instances.push(pane); } };
  for (const result of futures) {
    const selection = tickerSelectionFromSearchResult(result);
    const source = createPaneInstance("quote-monitor", { instanceId: "source", binding: { kind: "fixed", symbol: "ACME", ...selection } });
    state.config.layout.instances = [source]; state.focusedPaneId = "source";
    await createPaneTemplateOrThrow("new-ticker-detail-pane", undefined, deps);
    expect(placed.at(-1)?.binding).toMatchObject({ instrument: result.brokerContract });
    await createPaneTemplateOrThrow("graph-price-pane", { symbol: "ACME", ticker, ...selection }, deps);
    const chart = placed.at(-1)!; const spec = chart.settings!.chartSpec as any;
    expect(chart.binding).toMatchObject({ symbol: "ACME", listing: selection.listing });
    expect(spec.series[0].source.instrument.instrument).toEqual(result.brokerContract);
    const model = await chartHeadless("graph-price-pane").load({ argument: "ACME", rawArgument: "ACME", symbols: ["ACME"], options: {} }, {
      marketData: provider, config: state.config, apiClient: {} as any, signal: new AbortController().signal, settings: chart.settings,
    });
    expect(model.series[0]?.points.at(-1)?.value).toBe(result.brokerContract!.lastTradeDateOrContractMonth === "20261218" ? 10 : 20);
    expect(model.series[0]?.unit).toBe("USD");
    expect(chartComposerModule.paneTemplates!.find(t => t.id === "chart-composer-pane")!.publicShare!.serialize({ pane: chart, paneState: {} })).toBeNull();
  }
  const publicResult: InstrumentSearchResult = { providerId: "public", symbol: "ACME", name: "ACME common stock", exchange: "CBOE", currency: "EUR", type: "STK" };
  const selection = tickerSelectionFromSearchResult(publicResult);
  await createPaneTemplateOrThrow("new-ticker-detail-pane", { symbol: "ACME", ticker, ...selection }, deps);
  const publicPane = placed.at(-1)!;
  expect(publicPane.binding).toMatchObject({ instrument: null, listing: selection.listing });
  await createPaneTemplateOrThrow("graph-price-pane", { symbol: "ACME", ticker, ...selection }, deps);
  const publicChart = placed.at(-1)!;
  expect(publicChart.binding).toMatchObject({ symbol: "ACME", instrument: null, listing: selection.listing });
  const publicModel = await chartHeadless("graph-price-pane").load({ argument: "ACME", rawArgument: "ACME", symbols: ["ACME"], options: {} }, {
    marketData: provider, config: state.config, apiClient: {} as any, signal: new AbortController().signal, settings: publicChart.settings,
  });
  expect(publicModel.series[0]?.points.at(-1)?.value).toBe(30); expect(publicModel.series[0]?.unit).toBe("EUR/share");
  const chartShare = chartComposerModule.paneTemplates!.find(t => t.id === "chart-composer-pane")!.publicShare!;
  const sharedChart = chartShare.serialize({ pane: publicChart, paneState: {} })!;
  expect(sharedChart).not.toBeNull(); expect(JSON.stringify(sharedChart)).not.toContain("broker");
  const restoredChartOptions = chartShare.restore(sharedChart.data)!;
  const restoredChart = await chartComposerModule.paneTemplates!.find(t => t.id === "chart-composer-pane")!.createInstance!({ config: state.config, layout: state.config.layout, activeTicker: null, activeCollectionId: null, focusedPaneId: null }, restoredChartOptions);
  expect((restoredChart!.settings!.chartSpec as any).series[0].source.instrument).toMatchObject({ exchange: "CBOE", instrument: null });
  const share = tickerDetailModule.paneTemplates!.find(t => t.id === "new-ticker-detail-pane")!.publicShare!;
  const serialized = share.serialize({ pane: publicPane, paneState: {} })!;
  expect(serialized.data.symbol).toBe("ACME:CBOE"); expect(JSON.stringify(serialized)).not.toContain("broker");
  await createPaneTemplateOrThrow("new-ticker-detail-pane", share.restore(serialized.data)!, deps);
  const restored = placed.at(-1)!;
  const instrument = resolveInstrumentForPane(state, restored.instanceId)!;
  expect(instrument.instrument).toBeNull(); expect(instrument.exchange).toBe("CBOE");
  const restoredTicker = tickerForInstrument(state.tickers.get(instrument.symbol)!, instrument.instrument, resolveListingForPane(state, restored.instanceId));
  expect(restoredTicker?.metadata).toMatchObject({ name: "ACME common stock", assetCategory: "EQUITY", currency: "EUR", exchange: "CBOE" });
  expect(calls.at(-1)?.instrument).toBeNull();
});
