import { expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../../../../renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, appReducer, createInitialState, usePaneTicker, type AppAction } from "../../../../state/app/context";
import { createStaticAppStore } from "../../../../test-support/app-store";
import { createTestDataProvider } from "../../../../test-support/data-provider";
import { createTestTicker } from "../../../../test-support/ticker";
import { JsonTickerRepository } from "../../../../data/json-ticker-repository";
import { createDefaultConfig, createPaneInstance, TICKER_RESEARCH_PANE_ID } from "../../../../types/config";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../../market-data/coordinator";
import { createBaselineChartRequest } from "../../../../market-data/coordinator/chart";
import type { InstrumentRef } from "../../../../market-data/request-types";
import { useAppTickerOpenRuntime } from "../../../../app/pane-runtime/ticker-open-runtime";
import { buildTickerSearchCandidates, type TickerSearchCandidate } from "../../../../tickers/search";
import type { InstrumentSearchResult } from "../../../../types/instrument";
import type { TickerRecord } from "../../../../types/ticker";
import type { PinTickerOptions } from "../../../../types/plugin";
import { instrumentIdentityKey } from "../../../../utils/instrument-identity";
import { useCommandBarPaneActions } from "../../pane-actions";
import { useCommandBarTickerSearchActions } from "./actions";
import { createQuickLookTickerCandidates } from "./results";

const tui = createOpenTuiTestHarness();

const listing = (symbol: string, exchange: string, overrides: Partial<InstrumentSearchResult> = {}): InstrumentSearchResult => ({
  providerId: "cloud", symbol, exchange, name: `${symbol} on ${exchange}`, currency: "USD", type: "Common Stock", ...overrides,
});
const brokerContract = { brokerId: "ibkr", brokerInstanceId: "main", symbol: "AAPL", secType: "STK", exchange: "SMART", primaryExchange: "NASDAQ", currency: "USD", conId: 265598 };
const position = (portfolio = "main") => ({ portfolio, shares: 10, avgCost: 100, broker: "manual" });

/** Price by listing, so a warm for one listing cannot answer another. */
const priceOf = (symbol: string, exchange?: string) => 100 + ([...`${symbol}|${exchange ?? ""}`].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 800);
const provider = createTestDataProvider({
  getTickerFinancials: async (symbol, exchange) => ({
    annualStatements: [], quarterlyStatements: [], priceHistory: [],
    quote: { symbol, price: priceOf(symbol, exchange), currency: "USD", change: 0, changePercent: 0, lastUpdated: Date.now() },
  }),
  getQuote: async (symbol, exchange) => ({ symbol, price: priceOf(symbol, exchange), currency: "USD", change: 0, changePercent: 0, lastUpdated: Date.now() }),
  getPriceHistory: async () => [{ date: new Date(), close: 1 }],
});

/**
 * Warms the row's pick, opens the row the way Enter does, and reads the
 * instrument the pane then asks the coordinator for.
 */
async function warmThenOpen(pick: (tickers: ReadonlyMap<string, TickerRecord>) => TickerSearchCandidate, saved: TickerRecord[] = []) {
  const repo = new JsonTickerRepository(undefined, saved);
  const initial = createInitialState(createDefaultConfig(":memory:"));
  initial.config.layout = { dockRoot: null, floating: [], detached: [], instances: [] };
  for (const ticker of saved) initial.tickers.set(ticker.metadata.ticker, ticker);
  const stateRef = { current: initial };
  const coordinator = new MarketDataCoordinator(provider);
  setSharedMarketDataCoordinator(coordinator);
  const asked: InstrumentRef[] = [];
  const read = coordinator.getTickerFinancialsSync.bind(coordinator);
  coordinator.getTickerFinancialsSync = (instrument) => { asked.push(instrument); return read(instrument); };
  const pending: Promise<void>[] = [];
  let search!: ReturnType<typeof useCommandBarTickerSearchActions>;
  let dispatch!: (action: AppAction) => void;
  let sequence = 0;
  function Observer() {
    const { financials } = usePaneTicker();
    return <text>{financials?.quote?.price ?? "none"}</text>;
  }
  function Harness() {
    const [state, setState] = useState(initial);
    dispatch = (action) => { stateRef.current = appReducer(stateRef.current, action); setState(stateRef.current); };
    const registry = {
      panes: new Map([[TICKER_RESEARCH_PANE_ID, { id: TICKER_RESEARCH_PANE_ID }]]), events: { emit() {} }, notify() {},
      getTermSize: () => ({ width: 120, height: 40 }), getDisabledPaneOwner: () => null,
      pinTicker: (symbol: string, options?: PinTickerOptions) => { pending.push(runtime.openPinnedTicker(symbol, options)); },
      updateLayout: (layout: typeof state.config.layout) => dispatch({ type: "UPDATE_LAYOUT", layout }),
    } as any;
    const runtime = useAppTickerOpenRuntime({
      stateRef, dataProvider: provider, tickerRepository: repo, dispatch, pluginRegistry: registry,
      buildPaneInstance: (id, options) => createPaneInstance(id, { ...options, instanceId: `research:${++sequence}` }),
      persistLayout: (layout) => dispatch({ type: "UPDATE_LAYOUT", layout }), activatePane() {}, focusVisiblePane() {},
    });
    const paneActions = useCommandBarPaneActions({ dispatch, pluginRegistry: registry, stateRef });
    search = useCommandBarTickerSearchActions({ closeAll() {}, dispatch, focusTicker: paneActions.focusTicker, pluginRegistry: registry, tickerRepository: repo, tickers: state.tickers });
    return (
      <AppContext.Provider value={createStaticAppStore(state, dispatch)}>
        {state.config.layout.instances.map((pane) => <PaneInstanceProvider key={pane.instanceId} paneId={pane.instanceId}><Observer /></PaneInstanceProvider>)}
      </AppContext.Provider>
    );
  }
  const rendered = await tui.render(<Harness />, { width: 20, height: 3 });
  try {
    await act(async () => { await rendered.renderOnce(); });
    const row = search.mapTickerSearchCandidateToResultItem(pick(initial.tickers));
    const warmed = row.prefetchInstrument;
    if (warmed) {
      coordinator.warmTickerGaps(warmed);
      await Promise.all([coordinator.loadSnapshot(warmed), coordinator.loadChart(createBaselineChartRequest(warmed))]);
    }
    await act(async () => {
      void row.action();
      for (let i = 0; i < 20; i++) await Promise.resolve();
      await Promise.all(pending);
      await rendered.renderOnce();
    });
    const opened = asked.at(-1);
    return { warmed, opened, first: warmed && opened ? coordinator.getTickerFinancialsSync(opened) : null };
  } finally {
    await tui.destroy();
    setSharedMarketDataCoordinator(null);
    coordinator.destroy();
  }
}

/**
 * The row for `results[0]`, the way the bar lists it beside the other listings and the saved tickers:
 * its own row, or the saved ticker's that took its place.
 */
const fromProvider = (query: string, ...results: InstrumentSearchResult[]) => (tickers: ReadonlyMap<string, TickerRecord>) => {
  const candidates = buildTickerSearchCandidates({ query, tickers, providerResults: results });
  const picked = results[0]!;
  const lists = (candidate: TickerSearchCandidate) => candidate.result?.symbol === picked.symbol && candidate.result.exchange === picked.exchange;
  return candidates.find((candidate) => candidate.kind === "search" && lists(candidate)) ?? candidates.find(lists)!;
};
const fromSaved = (symbol: string) => (tickers: ReadonlyMap<string, TickerRecord>) => (
  createQuickLookTickerCandidates(tickers.values()).find((candidate) => candidate.symbol === symbol)!
);

/**
 * Cases where the row can name what the pane will read: the quote and the baseline
 * chart warmed for the row are the entries the opened pane reads on its first render.
 */
test.each([
  ["a search listing", fromProvider("NVT", listing("NVT", "NYSE")), []],
  ["a non-US listing", fromProvider("SAP", listing("SAP", "XETRA", { currency: "EUR" })), []],
  ["a listing picked among others", fromProvider("SAP", listing("SAP", "XETRA", { currency: "EUR" }), listing("SAP", "NYSE")), []],
  ["a currency pair", fromProvider("EURUSD", listing("EURUSD=X", "CCY", { type: "CURRENCY" })), []],
  ["an index", fromProvider("S&P", listing("^GSPC", "SNP", { type: "INDEX" })), []],
  ["a cryptocurrency", fromProvider("BTC-USD", listing("BTC-USD", "CCC", { type: "CRYPTOCURRENCY" })), []],
  ["a saved ticker typed bare", fromSaved("AAPL"), [createTestTicker("AAPL", "Apple", { portfolios: ["main"], positions: [position()] })]],
  ["a saved ticker beside its search listing", fromProvider("AAPL", listing("AAPL", "NASDAQ")), [createTestTicker("AAPL", "Apple", { portfolios: ["main"], positions: [position()] })]],
  ["a listing whose symbol is saved for another venue", fromProvider("SAP", listing("SAP", "XETRA", { currency: "EUR" })), [createTestTicker("SAP", "SAP ADR", { exchange: "NYSE" })]],
  ["a saved ticker beside its search listing and a broker contract", fromProvider("AAPL", listing("AAPL", "NASDAQ")), [createTestTicker("AAPL", "Apple", { broker_contracts: [brokerContract] })]],
  ["a listing with no venue", fromProvider("AAPL", listing("AAPL", "")), [createTestTicker("AAPL", "Apple")]],
] as const)("%s: the pick is the instrument the opened pane reads", async (_name, pick, saved) => {
  const { warmed, opened, first } = await warmThenOpen(pick, [...saved]);
  expect(warmed).toBeDefined();
  expect(opened).toBeDefined();
  expect(instrumentIdentityKey(warmed!)).toBe(instrumentIdentityKey(opened!));
  expect(first?.quote?.price).toBe(priceOf(warmed!.symbol, warmed!.exchange));
  expect(first?.priceHistory.length).toBeGreaterThan(0);
});

const contracts = [brokerContract, { ...brokerContract, brokerInstanceId: "second", conId: 1 }];
test.each([
  ["a broker contract", fromProvider("AAPL", listing("AAPL", "SMART", { brokerContract })), []],
  ["a saved ticker with one broker contract", fromSaved("AAPL"), [createTestTicker("AAPL", "Apple", { broker_contracts: [brokerContract] })]],
  ["a saved ticker with several", fromSaved("AAPL"), [createTestTicker("AAPL", "Apple", { broker_contracts: contracts })]],
] as const)("%s is left for the pane to resolve", async (_name, pick, saved) => {
  const { warmed } = await warmThenOpen(pick, [...saved]);
  expect(warmed).toBeUndefined();
});
