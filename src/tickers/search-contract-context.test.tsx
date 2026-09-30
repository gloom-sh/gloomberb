import { expect, test } from "bun:test";
import { act, useState } from "react";
import { testRender } from "../renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, appReducer, createInitialState, usePaneTicker, type AppAction } from "../state/app/context";
import { createStaticAppStore } from "../test-support/app-store";
import { createDefaultConfig, createPaneInstance, TICKER_RESEARCH_PANE_ID } from "../types/config";
import { JsonTickerRepository } from "../data/json-ticker-repository";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../market-data/coordinator";
import { createTestDataProvider } from "../test-support/data-provider";
import { useAppTickerOpenRuntime } from "../app/pane-runtime/ticker-open-runtime";
import { useCommandBarPaneActions } from "../components/command-bar/pane-actions";
import { useCommandBarTickerSearchActions } from "../components/command-bar/routes/ticker-search/actions";
import { mergePlainRootTickerResults, mergeTickerSearchResultItems } from "../components/command-bar/routes/ticker-search/results";
import { AmbiguousContractError, buildTickerSearchCandidates, createLocalTickerSearchCandidates, resolveTickerSearch, upsertTickerFromSearchResult } from "./search";
import type { InstrumentSearchResult } from "../types/instrument";
import type { TickerFinancials } from "../types/financials";
import type { PinTickerOptions } from "../types/plugin";
import { resolveInstrumentForPane } from "../core/state/app/instrument";
import { tickerInstrumentLabel } from "./instrument-label";

const results: InstrumentSearchResult[] = [100, 110].map((strike) => ({
  providerId: "broker", symbol: "ACME", exchange: "CBOE", currency: "USD", type: "OPT", name: `ACME 2027-01-15 ${strike} Call`,
  brokerContract: { brokerId: "test", brokerInstanceId: "desk", symbol: "ACME", secType: "OPT", currency: "USD", exchange: "CBOE", lastTradeDateOrContractMonth: "20270115", right: "C", strike, multiplier: "100" },
}));
const financials = (price: number): TickerFinancials => ({ annualStatements: [], quarterlyStatements: [], priceHistory: [], quote: { symbol: "ACME", currency: "USD", price, change: 0, changePercent: 0, lastUpdated: Date.now() } });
test.each([48, 80, 120])("search keeps broker and explicit public panes through metadata reorder and restore at %s columns", async (width) => {
  const repo = new JsonTickerRepository();
  const config = createDefaultConfig(":memory:");
  config.layout = { dockRoot: null, floating: [], detached: [], instances: [] };
  const initial = createInitialState(config);
  initial.financials.set("ACME", financials(999));
  const stateRef = { current: initial };
  const provider = createTestDataProvider({ getFinancials: async (_symbol, _exchange, context) => financials(context?.instrument?.strike === 110 ? 20 : 10) });
  const coordinator = new MarketDataCoordinator(provider);
  coordinator.primeCachedFinancials(results.map((result, i) => ({ instrument: { symbol: "ACME", exchange: "CBOE", brokerId: "test", brokerInstanceId: "desk", instrument: result.brokerContract }, financials: financials((i + 1) * 10) })));
  setSharedMarketDataCoordinator(coordinator);
  const observed = new Map<string, ReturnType<typeof usePaneTicker>>();
  let sequence = 0;
  let search!: ReturnType<typeof useCommandBarTickerSearchActions>;
  let paneActions!: ReturnType<typeof useCommandBarPaneActions>;
  let dispatch!: (action: AppAction) => void;
  const pending: Promise<void>[] = [];
  function Observer({ id }: { id: string }) {
    const selected = usePaneTicker(); observed.set(id, selected);
    const { ticker, financials } = selected;
    return <text>{id} strike={ticker?.metadata.broker_contracts?.[0]?.strike} price={financials?.quote?.price ?? "missing"}</text>;
  }
  function Harness() {
    const [state, setState] = useState(initial);
    dispatch = (action) => { stateRef.current = appReducer(stateRef.current, action); setState(stateRef.current); };
    const registry = { panes: new Map([[TICKER_RESEARCH_PANE_ID, { id: TICKER_RESEARCH_PANE_ID }]]), events: { emit() {} }, notify() {}, getTermSize: () => ({ width: 120, height: 40 }), pinTicker: (symbol: string, options?: PinTickerOptions) => { pending.push(runtime.openPinnedTicker(symbol, options)); }, updateLayout: (layout: typeof config.layout) => dispatch({ type: "UPDATE_LAYOUT", layout }) } as any;
    const runtime = useAppTickerOpenRuntime({ stateRef, dataProvider: provider, tickerRepository: repo, dispatch, pluginRegistry: registry,
      buildPaneInstance: (id, options) => createPaneInstance(id, { ...options, instanceId: `research:${++sequence}` }),
      persistLayout: (layout) => dispatch({ type: "UPDATE_LAYOUT", layout }), activatePane() {}, focusVisiblePane() {} });
    paneActions = useCommandBarPaneActions({ dispatch, pluginRegistry: registry, stateRef });
    search = useCommandBarTickerSearchActions({ closeAll() {}, dispatch, focusTicker: paneActions.focusTicker, pluginRegistry: registry, tickerRepository: repo, tickers: state.tickers });
    return <AppContext.Provider value={createStaticAppStore(state, dispatch)}><box flexDirection="column">{state.config.layout.instances.map((pane) => <PaneInstanceProvider key={pane.instanceId} paneId={pane.instanceId}><Observer id={pane.instanceId} /></PaneInstanceProvider>)}</box></AppContext.Provider>;
  }
  const rendered = await testRender(<Harness />, { width, height: 12 });
  try {
    await act(async () => { await rendered.renderOnce(); });
    const candidates = buildTickerSearchCandidates({ query: "ACME", tickers: new Map(), providerResults: results });
    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) {
      await act(async () => { search.mapTickerSearchCandidateToResultItem(candidate).secondaryAction?.(); for (let i = 0; i < 20; i++) await Promise.resolve(); await Promise.all(pending); });
    }
    expect(stateRef.current.config.layout.instances.map((pane) => pane.binding?.kind === "fixed" ? pane.binding.instrument?.strike : null)).toEqual([100, 110]);
    expect((await repo.loadTicker("ACME"))?.metadata.broker_contracts?.map((c) => c.strike)).toEqual([100, 110]);
    const publicResult: InstrumentSearchResult = { providerId: "public", symbol: "ACME", exchange: "CBOE", currency: "EUR", name: "ACME common stock", type: "STK" };
    coordinator.primeCachedFinancials([{ instrument: { symbol: "ACME", exchange: "CBOE", instrument: null }, financials: {
      ...financials(30), quote: { ...financials(30).quote!, currency: "EUR" },
    } }]);
    await act(async () => {
      const publicCandidate = buildTickerSearchCandidates({ query: "ACME", tickers: new Map(), providerResults: [publicResult] })[0]!;
      search.mapTickerSearchCandidateToResultItem(publicCandidate).secondaryAction?.();
      for (let i = 0; i < 20; i++) await Promise.resolve(); await Promise.all(pending);
    });
    const publicPane = stateRef.current.config.layout.instances[2]!;
    expect(publicPane.binding?.kind === "fixed" && publicPane.binding.instrument).toBeNull();
    expect(observed.get("research:3")?.ticker?.metadata).toMatchObject({ name: "ACME common stock", exchange: "CBOE", currency: "EUR", assetCategory: "STK", broker_contracts: [] });
    expect(observed.get("research:3")?.financials?.quote).toMatchObject({ price: 30, currency: "EUR" });
    expect((await repo.loadTicker("ACME"))?.metadata.assetCategory).toBe("OPT");

    await act(async () => {
      const layout = stateRef.current.config.layout;
      dispatch({ type: "UPDATE_LAYOUT", layout: { ...layout, instances: [...layout.instances, createPaneInstance(TICKER_RESEARCH_PANE_ID, { instanceId: "follower", binding: { kind: "follow", sourceInstanceId: "research:1" } }), createPaneInstance(TICKER_RESEARCH_PANE_ID, { instanceId: "public-follower", binding: { kind: "follow", sourceInstanceId: "research:3" } })] } });
      paneActions.duplicatePane("research:1");
    });
    await act(async () => { await rendered.renderOnce(); });
    let frame = rendered.captureCharFrame();
    expect(frame).toContain("research:1 strike=100 price=10");
    expect(frame).toContain("research:2 strike=110 price=20");
    expect(frame).toContain("follower strike=100 price=10");
    expect(frame).not.toContain("999");
    expect(observed.get("public-follower")?.ticker?.metadata.assetCategory).toBe("STK");
    expect(observed.get("public-follower")?.financials?.quote?.price).toBe(30);
    await act(async () => {
      const ticker = (await repo.loadTicker("ACME"))!;
      ticker.metadata.broker_contracts!.reverse();
      dispatch({ type: "UPDATE_TICKER", ticker });
      dispatch({ type: "UPDATE_LAYOUT", layout: JSON.parse(JSON.stringify(stateRef.current.config.layout)) });
      await rendered.renderOnce();
    });
    frame = rendered.captureCharFrame();
    expect(frame).toContain("research:1 strike=100 price=10");
    expect(frame).toContain("research:2 strike=110 price=20");
    expect(frame).toContain("follower strike=100 price=10");
    expect(observed.get("research:3")?.ticker?.metadata).toMatchObject({ name: "ACME common stock", currency: "EUR", assetCategory: "STK" });
    expect(observed.get("public-follower")?.financials?.quote?.price).toBe(30);
  } finally {
    await act(async () => { rendered.renderer.destroy(); });
    setSharedMarketDataCoordinator(null); coordinator.destroy();
  }
});

test("contract identity survives ranking, saved rows and both command-bar merges; ambiguous symbols never choose the first", async () => {
  const repo = new JsonTickerRepository();
  for (const result of results) await upsertTickerFromSearchResult(repo, result);
  const ticker = (await repo.loadTicker("ACME"))!;
  const tickers = new Map([["ACME", ticker]]);
  const oldConfig = createDefaultConfig(":memory:");
  oldConfig.layout.instances = [createPaneInstance(TICKER_RESEARCH_PANE_ID, { instanceId: "legacy", binding: { kind: "fixed", symbol: "ACME" } })];
  expect(resolveInstrumentForPane({ ...createInitialState(oldConfig), tickers }, "legacy")).toBeNull();
  expect(results.map(result => tickerInstrumentLabel("ACME", { ...result.brokerContract!, localSymbol: "SAME" }))).toEqual([
    "SAME 20270115 C 100", "SAME 20270115 C 110",
  ]);
  for (const saved of [new Map(), tickers]) {
    const candidates = buildTickerSearchCandidates({ query: "ACME", tickers: saved, providerResults: results });
    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map((c) => c.id)).size).toBe(2);
    const items = candidates.map((c) => ({ ...c, action() {} }));
    expect(mergeTickerSearchResultItems("ACME", items, items)).toHaveLength(2);
    expect(mergePlainRootTickerResults("ACME", items, [])).toHaveLength(2);
    await expect(resolveTickerSearch({ query: "ACME", activeTicker: null, tickers: saved, dataProvider: createTestDataProvider({ search: async () => results }) })).rejects.toBeInstanceOf(AmbiguousContractError);
  }
  const equity = { ...results[0]!, type: "STK", brokerContract: { brokerId: "test", symbol: "ACME", secType: "STK", conId: 123 } };
  const publicEquity = { ...equity, brokerContract: undefined, providerId: "public" };
  expect(buildTickerSearchCandidates({ query: "ACME", tickers: new Map(), providerResults: [publicEquity, equity] })).toHaveLength(1);
  const future = { ...results[0]!.brokerContract!, secType: "FUT", exchange: "EUREX", currency: "EUR", lastTradeDateOrContractMonth: "20270319", right: undefined, strike: undefined };
  const mixed = { ...ticker, metadata: { ...ticker.metadata, broker_contracts: [results[0]!.brokerContract!, future] } };
  const mixedRows = createLocalTickerSearchCandidates([mixed]);
  expect(mixedRows.map(row => [row.instrumentType, row.exchangeLabel, row.result?.currency])).toEqual([["OPT", "CBOE", "USD"], ["FUT", "EUREX", "EUR"]]);
  const filtered = createLocalTickerSearchCandidates([mixed], new Map(), { includeOptionContracts: false });
  expect(filtered).toHaveLength(1);
  expect(filtered[0]?.result?.brokerContract).toEqual(future);
  expect(buildTickerSearchCandidates({ query: "ACME", tickers: new Map([["ACME", mixed]]), providerResults: [], includeOptionContracts: false }).map(row => row.instrumentType)).toEqual(["FUT"]);
});
