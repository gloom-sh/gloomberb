import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { marketMoversModule } from "./index";
import { resetMarketMoversPersistence } from "./screener";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { publicTickerKey } from "../../../utils/exchanges";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { TestPaneProvider, createTestPaneConfig } from "../../../test-support/pane";
import { testRender, settleFrame, emitKeypress, takeSavedTextFile } from "../../../renderers/opentui/test-utils";
import { createInitialState, appReducer } from "../../../state/app/context";
import { PaneFooterProvider, PaneFooterBar } from "../../../components/layout/pane/footer";
import { exportPaneTable } from "../../../state/pane-table-export-registry";
import { JsonTickerRepository } from "../../../data/json-ticker-repository";
import { useAppTickerOpenRuntime } from "../../../app/pane-runtime/ticker-open-runtime";
import { createPaneInstance, TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import { AssetDataRouter } from "../../../sources/provider-router";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { Box } from "../../../ui";
import { useRegularMarketSession } from "../../../test-support/market-session";

useRegularMarketSession();

const payload = (quotes: unknown[]) => ({ finance: { result: [{ quotes }], error: null } });
const raw = (symbol: string, fields = {}) => ({ symbol, shortName: `${symbol} Research`, regularMarketPrice: 10, regularMarketChangePercent: 10, regularMarketVolume: 200, averageDailyVolume3Month: 100, currency: "USD", fullExchangeName: "NASDAQ", ...fields });
let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let coordinator: MarketDataCoordinator | undefined;
let footer: any;
async function mount(answer: (url: URL) => unknown | Promise<unknown>, selectedProvider?: ReturnType<typeof createTestDataProvider>) {
  const provider = selectedProvider ?? createTestDataProvider();
  setHttpFetchTransport(async url => Response.json(await answer(new URL(url))));
  const id = "market-movers", Pane = marketMoversModule.panes[0]!.component;
  const initial = createInitialState(createTestPaneConfig(":memory:", { instanceId: id, paneId: id, settings: {} }));
  initial.focusedPaneId = id;
  const memory = new Map<string, string>();
  const repo = new JsonTickerRepository({ getItem: key => memory.get(key) ?? null, setItem: (key, value) => { memory.set(key, value); }, removeItem: key => { memory.delete(key); } });
  const saved = await repo.createTicker({ ticker: "ACME", name: "Remembered US share", exchange: "NASDAQ", currency: "USD", assetCategory: "STK", portfolios: [], watchlists: [], positions: [], custom: {}, tags: [] });
  initial.tickers.set("ACME", saved);
  const stateRef = { current: initial };
  const pins: any[] = [], pending: Promise<void>[] = [];
  let sequence = 0;
  function Harness() {
    const [state, setState] = useState(initial);
    const dispatch = (action: any) => { stateRef.current = appReducer(stateRef.current, action); setState(stateRef.current); };
    const registry = { panes: new Map([[TICKER_RESEARCH_PANE_ID, { id: TICKER_RESEARCH_PANE_ID }]]), events: { emit() {} }, notify() {}, getTermSizeFn: () => ({ width: 120, height: 40 }) } as any;
    const runtime = useAppTickerOpenRuntime({ stateRef, dataProvider: provider, tickerRepository: repo, dispatch, pluginRegistry: registry,
      buildPaneInstance: (paneId, options) => createPaneInstance(paneId, { ...options, instanceId: `research:${++sequence}` }),
      persistLayout: layout => dispatch({ type: "UPDATE_LAYOUT", layout }), activatePane() {}, focusVisiblePane() {} });
    return <TestPaneProvider state={state} dispatch={dispatch} paneId={id} pluginId="market-movers" runtime={{ getMarketData: () => null, pinTicker: (symbol, options) => { pins.push({ symbol, options }); pending.push(runtime.openPinnedTicker(symbol, options)); } }}>
      <PaneFooterProvider>{value => { footer = value; return <Box width={120} height={18} flexDirection="column"><Box height={17}><Pane paneId={id} paneType={id} width={120} height={17} focused /></Box><PaneFooterBar footer={value} width={120} focused /></Box>; }}</PaneFooterProvider>
    </TestPaneProvider>;
  }
  await act(async () => { setup = await testRender(<Harness />, { width: 120, height: 18 }); });
  await settleFrame(setup!, 8);
  return { stateRef, pins, pending };
}
async function clickLabel(label: string, row?: number) {
  const lines = setup!.captureCharFrame().split("\n");
  const y = row ?? lines.findIndex(line => line.includes(label));
  await act(async () => { await setup!.mockMouse.click(lines[y]!.indexOf(label) + 1, y); });
  await settleFrame(setup!, 6);
}
async function csv() {
  await act(async () => { await exportPaneTable("market-movers", "movers.csv"); });
  return takeSavedTextFile()!.text;
}
afterEach(async () => {
  if (setup) await act(async () => setup!.renderer.destroy());
  setup = undefined; setSharedMarketDataCoordinator(null); coordinator?.destroy(); coordinator = undefined;
  resetMarketMoversPersistence(); setHttpFetchTransport(null);
});

test("switching lists hides old rows while pending or failed and retains only same-list stale rows on refresh", async () => {
  let rejectLosers!: (reason: Error) => void, fail = false;
  const loserRequest = new Promise((_, reject) => { rejectLosers = reject; });
  await mount(url => url.searchParams.get("scrIds") === "day_losers" ? loserRequest : fail ? Promise.reject(new Error("Controlled unavailable")) : payload([raw("GAINER")]));
  expect(await csv()).toContain("GAINER");
  await clickLabel("Losers");
  expect(await csv()).not.toContain("GAINER");
  await act(async () => { rejectLosers(new Error("Controlled unavailable")); });
  await settleFrame(setup!, 6);
  expect(setup!.captureCharFrame()).not.toContain("GAINER");
  expect(JSON.stringify(footer)).toContain("unavailable");
  await clickLabel("Gainers");
  expect(await csv()).toContain("GAINER");
  fail = true;
  await emitKeypress(setup!, { name: "r", sequence: "r" }); await settleFrame(setup!, 6);
  expect(await csv()).toContain("GAINER");
  expect(JSON.stringify(footer)).toContain("stale");
  expect(JSON.stringify(footer)).toContain("unavailable");
});

test("keyboard selects both same-symbol listings and the actual open runtime preserves venue and source type", async () => {
  const provider = new AssetDataRouter(createTestDataProvider({ getQuote: async symbol => ({
    symbol: "ACME", price: 8, currency: "GBP", instrumentType: "ETF", exchangeName: "LSE", listingExchangeName: "LSE", lastUpdated: Date.now() - 60_000, marketState: "CLOSED",
  }) }));
  const { stateRef, pins, pending } = await mount(() => payload([raw("ACME", { shortName: "US share" }), raw("ACME", { shortName: "London fund", fullExchangeName: "LSE", currency: "GBP" })]), provider);
  await emitKeypress(setup!, { name: "down", sequence: "\u001b[B" });
  await emitKeypress(setup!, { name: "enter", sequence: "\r" });
  await act(async () => { await Promise.all(pending); }); await settleFrame(setup!, 6);
  expect(pins[0]).toEqual({ symbol: publicTickerKey("ACME", "LSE"), options: { floating: true, paneType: TICKER_RESEARCH_PANE_ID, instrument: null } });
  const opened = stateRef.current.config.layout.instances.find(pane => pane.instanceId === "research:1")!;
  expect(opened.binding).toMatchObject({ kind: "fixed", symbol: publicTickerKey("ACME", "LSE"), instrument: null, listing: { exchange: "LSE", currency: "GBP", type: "ETF" } });
  expect(stateRef.current.tickers.get("ACME")?.metadata.exchange).toBe("NASDAQ");
});

test("actual routed live snapshots update the ratio and clear missing fields; explicit zero and prior close remain usable", async () => {
  let deliver!: (quote: any) => void;
  const provider = new AssetDataRouter(createTestDataProvider({ subscribeQuotes: (targets, onQuote) => { deliver = quote => onQuote(targets.find(target => target.symbol === "LIVE")!, quote); return () => {}; } }));
  coordinator = new MarketDataCoordinator(provider); setSharedMarketDataCoordinator(coordinator);
  await mount(() => payload([raw("LIVE")]));
  const quote = { symbol: "LIVE", price: 11, currency: "USD", exchangeName: "NASDAQ", listingExchangeName: "NASDAQ", marketState: "CLOSED", lastUpdated: Date.now() - 60_000, dataSource: "live", delivery: "stream", stale: false };
  const update = async (patch: object) => { await act(async () => { deliver({ ...quote, ...patch }); await new Promise(resolve => setTimeout(resolve, 520)); }); await settleFrame(setup!, 4); };
  await update({ volume: 1000, change: 1, changePercent: 10 });
  expect(await csv()).toContain("1.0k,10x");
  await update({ price: 12, lastUpdated: quote.lastUpdated + 1000 });
  expect(await csv()).toContain("$12.00,—,—,—");
  await update({ volume: 0, change: 0, changePercent: 0, lastUpdated: quote.lastUpdated + 2000 });
  expect(await csv()).toContain("0.00%,0,0.0x");
  await update({ price: 12, previousClose: 10, volume: 300, lastUpdated: quote.lastUpdated + 3000 });
  expect(await csv()).toContain("'+20.00%,300,3.0x");
});

test("routed major-unit and unknown-unit quotes keep range context honest", async () => {
  let deliver!: (quote: any) => void;
  const provider = new AssetDataRouter(createTestDataProvider({ subscribeQuotes: (targets, onQuote) => { deliver = quote => onQuote(targets.find(target => target.symbol === "UNIT")!, quote); return () => {}; } }));
  coordinator = new MarketDataCoordinator(provider); setSharedMarketDataCoordinator(coordinator);
  await mount(() => payload([raw("UNIT", { regularMarketPrice: 125, currency: "GBp", fiftyTwoWeekLow: 100, fiftyTwoWeekHigh: 200 })]));
  expect(await csv()).toContain("£1.25");
  const quote = { symbol: "UNIT", price: 1.25, change: 0, changePercent: 0, currency: "GBP", exchangeName: "NASDAQ", listingExchangeName: "NASDAQ", marketState: "CLOSED", lastUpdated: Date.now() - 60_000, dataSource: "live", delivery: "stream", stale: false };
  await act(async () => { deliver(quote); }); await settleFrame(setup!, 4);
  expect(await csv()).toContain("25%");
  await act(async () => { deliver({ ...quote, price: 12, currency: "", lastUpdated: quote.lastUpdated + 1000 }); await new Promise(resolve => setTimeout(resolve, 520)); }); await settleFrame(setup!, 4);
  const unknown = await csv();
  expect(unknown).toContain(",12.00,");
  expect(unknown).not.toContain("£");
  expect(unknown).not.toContain("25%");
  expect(unknown).not.toContain("$");
});
