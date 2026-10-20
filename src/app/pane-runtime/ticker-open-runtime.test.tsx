import { getDockedPaneIds } from "../../layout/pane-manager";
import { expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { createTestDataProvider, createTestQuote } from "../../test-support/data-provider";
import { AssetDataRouter } from "../../sources/provider-router";
import { createBrowserResearchLayout, BROWSER_RESEARCH_PANE_ID } from "../../renderers/browser/config-host";
import { createInitialState, type AppAction } from "../../state/app/context";
import { createDefaultConfig, createPaneInstance, TICKER_RESEARCH_PANE_ID } from "../../types/config";
import type { TickerRecord } from "../../types/ticker";
import { useAppTickerOpenRuntime } from "./ticker-open-runtime";
import { researchEntryFromSearch } from "../../renderers/browser/research-entry";
import { createTestTicker } from "../../test-support/ticker";

const tui = createOpenTuiTestHarness({ width: 20, height: 2 });

test("a slow linked ticker applies its tab to the reused or new pane after hydration", async () => {
  for (const { savedListing, savedExchange, reusePane } of [
    { savedListing: "VOD:XLON", savedExchange: "JSE", reusePane: true },
    { savedListing: "VOD", savedExchange: "LSE", reusePane: true },
    { savedListing: "VOD", savedExchange: "JSE", reusePane: false },
  ]) {
    const config = createDefaultConfig(":memory:");
    config.layout = createBrowserResearchLayout(savedListing);
    const stateRef = { current: createInitialState(config) };
    // A saved same-spelling issuer on another venue must not satisfy the link.
    stateRef.current.tickers.set("VOD", createTestTicker("VOD", savedExchange === "LSE" ? "Vodafone" : "Vodacom", { exchange: savedExchange, currency: savedExchange === "LSE" ? "GBP" : "ZAR" }));
    const actions: AppAction[] = [];
    const focused: string[] = [];
    let layouts = 0;
    let releaseSearch!: () => void;
    const pendingSearch = new Promise<void>((resolve) => { releaseSearch = resolve; });
    let runtime!: ReturnType<typeof useAppTickerOpenRuntime>;
    function Harness() {
      runtime = useAppTickerOpenRuntime({
        stateRef,
        dataProvider: createTestDataProvider({ search: async () => {
          await pendingSearch;
          return [{ providerId: "cloud", symbol: "VOD", name: "Vodafone", exchange: "LSE", currency: "GBP", type: "EQUITY" }];
        } }),
        tickerRepository: {
          loadTicker: async () => null,
          createTicker: async (metadata: TickerRecord["metadata"]) => ({ metadata }),
        } as any,
        dispatch: (action) => { actions.push(action); },
        pluginRegistry: {
          panes: new Map([[TICKER_RESEARCH_PANE_ID, { id: TICKER_RESEARCH_PANE_ID }]]),
          events: { emit() {} }, notify() {}, getTermSize: () => ({ width: 120, height: 40 }), getDisabledPaneOwner: () => null,
        } as any,
        buildPaneInstance: (paneId, options) => createPaneInstance(paneId, { ...options, instanceId: "ticker-detail:linked" }),
        persistLayout: (layout) => { layouts++; stateRef.current.config.layout = layout; },
        activatePane: (paneId) => { focused.push(paneId); },
        focusVisiblePane: (paneId) => { focused.push(paneId); },
      });
      return <text>Research</text>;
    }
    const rendered = await tui.render(<Harness />);
    await act(async () => { await rendered.renderOnce(); });
    const entry = researchEntryFromSearch("?ticker=VOD&exchange=LSE&tab=financials")!;
    const opening = runtime.openPinnedTicker(entry.symbol, { tabId: entry.tab, floating: true, tabState: { requestedView: "one-use-token", activeTabId: "ignored" } });
    // Focus may change while the provider is still resolving the linked listing.
    stateRef.current.focusedPaneId = "world-indices:main";
    // Explicit exact local matches may resolve without the deferred provider.
    if (savedExchange !== "LSE") expect(actions).toEqual([]);
    releaseSearch();
    await act(async () => { await opening; });
    const paneId = reusePane ? BROWSER_RESEARCH_PANE_ID : "ticker-detail:linked";
    expect(actions).toContainEqual({ type: "UPDATE_PANE_STATE", paneId, patch: { requestedView: "one-use-token", activeTabId: "financials" } });
    expect(actions.filter((action) => action.type === "UPDATE_PANE_STATE")).toHaveLength(1);
    expect(actions.find((action) => action.type === "UPDATE_TICKER")).toMatchObject({ ticker: { metadata: { ticker: "VOD:XLON", exchange: "LSE" } } });
    expect(stateRef.current.config.layout.instances.find((pane) => pane.instanceId === paneId)?.binding)
      .toMatchObject({ kind: "fixed", symbol: "VOD:XLON" });
    expect(focused).toEqual([paneId]);
    expect(layouts).toBe(1);
    expect(stateRef.current.config.layout.instances.filter((pane) => pane.paneId === TICKER_RESEARCH_PANE_ID))
      .toHaveLength(reusePane ? 1 : 2);
  }
});


test.each(["ambiguous", "missing"])("%s ticker feedback waits for current navigation ownership", async (mode) => {
  const actions: AppAction[] = [];
  const notifications: string[] = [];
  const stateRef = { current: createInitialState(createDefaultConfig(":memory:")) };
  let releaseSearch!: () => void;
  const pendingSearch = new Promise<void>((resolve) => { releaseSearch = resolve; });
  let current = true;
  let runtime!: ReturnType<typeof useAppTickerOpenRuntime>;
  function Harness() {
    runtime = useAppTickerOpenRuntime({
      stateRef,
      dataProvider: createTestDataProvider({
        search: async () => {
          await pendingSearch;
          return mode === "missing" ? [] : ["BYMA", "NYSE"].map((exchange) => ({ providerId: "cloud", symbol: "GLD", name: "SPDR", exchange, type: "ETF" }));
        },
        getQuote: async () => {
          if (mode === "missing") throw new Error("No quote available");
          return { symbol: "GLD", price: 400, currency: "USD", lastUpdated: 1, change: 0, changePercent: 0 };
        },
      }),
      tickerRepository: { createTicker: async () => { throw new Error("Must not create an ambiguous ticker"); } } as any,
      dispatch: (action) => { actions.push(action); },
      pluginRegistry: { notify: ({ body }: { body: string }) => { notifications.push(body); }, getDisabledPaneOwner: () => null } as any,
      buildPaneInstance: () => null, persistLayout() {}, activatePane() {}, focusVisiblePane() {},
    });
    return <text>Research</text>;
  }
  const rendered = await tui.render(<Harness />);
  await act(async () => { await rendered.renderOnce(); });
  const obsolete = runtime.resolveOpenTickerTarget("GLD", false, () => current);
  current = false;
  releaseSearch();
  await act(async () => { expect(await obsolete).toBeNull(); });
  expect(actions).toEqual([]);
  expect(notifications).toEqual([]);

  // Ordinary opening still presents the actionable failure or listing picker.
  await act(async () => { await runtime.openPinnedTicker("GLD"); });
  expect(actions).toEqual(mode === "ambiguous"
    ? [{ type: "SET_COMMAND_BAR", open: true, query: "GLD", launch: { kind: "ticker-search", query: "GLD" } }]
    : []);
  expect(notifications).toHaveLength(1);
  expect(notifications[0]).toContain(mode === "ambiguous" ? "Multiple listings match GLD" : "Could not open GLD");
});

test.each(["floating", "docked", "only-floating"])("ticker research opens visibly from a %s source", async (mode) => {
  const source = createPaneInstance("relative-valuation", { instanceId: "relative-valuation:source", binding: { kind: "none" } });
  const anchor = createPaneInstance("world-indices", { instanceId: "world-indices:anchor", binding: { kind: "none" } });
  const config = createDefaultConfig(":memory:");
  config.layout = { dockRoot: mode === "only-floating" ? null : { kind: "pane", instanceId: mode === "docked" ? source.instanceId : anchor.instanceId },
    instances: mode === "only-floating" || mode === "docked" ? [source] : [source, anchor],
    floating: mode === "docked" ? [] : [{ instanceId: source.instanceId, x: 2, y: 2, width: 80, height: 20, zIndex: 1 }], detached: [] };
  const stateRef = { current: createInitialState(config) };
  stateRef.current.focusedPaneId = source.instanceId;
  const ticker: TickerRecord = createTestTicker("RIVN:XNAS", "Rivian");
  let runtime!: ReturnType<typeof useAppTickerOpenRuntime>;
  const activated: string[] = [];
  function Harness() {
    runtime = useAppTickerOpenRuntime({ stateRef, dataProvider: createTestDataProvider(), tickerRepository: {} as any, dispatch() {},
      pluginRegistry: { panes: new Map([[TICKER_RESEARCH_PANE_ID, { id: TICKER_RESEARCH_PANE_ID }]]), events: { emit() {} },
        getTermSize: () => ({ width: 120, height: 40 }), getDisabledPaneOwner: () => null } as any,
      buildPaneInstance: (paneId, options) => createPaneInstance(paneId, { ...options, instanceId: "ticker-detail:opened" }),
      persistLayout: (layout) => { stateRef.current.config.layout = layout; },
      activatePane: (paneId) => { activated.push(paneId); }, focusVisiblePane() {},
    });
    return <text>Research</text>;
  }
  const rendered = await tui.render(<Harness />);
  await act(async () => { await rendered.renderOnce(); runtime.placePinnedTickerTarget({ symbol: "RIVN:XNAS", ticker, created: false }, { floating: false }); });
  const layout = stateRef.current.config.layout;
  expect(getDockedPaneIds(layout)).toContain("ticker-detail:opened");
  expect(layout.instances.find((pane) => pane.instanceId === "ticker-detail:opened")?.binding).toEqual({ kind: "fixed", symbol: "RIVN:XNAS" });
  expect(activated).toEqual(["ticker-detail:opened"]);
  if (mode !== "docked") expect(layout.floating.map((pane) => pane.instanceId)).toContain(source.instanceId);
  else expect(getDockedPaneIds(layout)).toContain(source.instanceId);
});

// `DES NEE` binds the public listing; a ticker link names no route. Both are the one security without a broker.
test("a ticker link brings forward the DES the command bar opened on the public listing, binding untouched", async () => {
  const config = createDefaultConfig(":memory:");
  const des = createPaneInstance(TICKER_RESEARCH_PANE_ID, { instanceId: "ticker-research:nee", title: "NEE",
    binding: { kind: "fixed", symbol: "NEE", instrument: null, listing: { name: "NextEra Energy Inc.", exchange: "NYSE", currency: "USD", type: "Common Stock" } } });
  config.layout = { dockRoot: null, instances: [des], floating: [{ instanceId: des.instanceId, x: 2, y: 2, width: 80, height: 20, zIndex: 1 }], detached: [] };
  const stateRef = { current: createInitialState(config) };
  stateRef.current.tickers.set("NEE", createTestTicker("NEE", "NextEra Energy Inc.", { exchange: "NYSE" }));
  const focused: string[] = [];
  let runtime!: ReturnType<typeof useAppTickerOpenRuntime>;
  function Harness() {
    runtime = useAppTickerOpenRuntime({ stateRef, dataProvider: createTestDataProvider(), tickerRepository: {} as any, dispatch() {},
      pluginRegistry: { panes: new Map([[TICKER_RESEARCH_PANE_ID, { id: TICKER_RESEARCH_PANE_ID }]]), events: { emit() {} }, notify() {},
        getTermSize: () => ({ width: 120, height: 40 }), getDisabledPaneOwner: () => null } as any,
      buildPaneInstance: (paneId, options) => createPaneInstance(paneId, { ...options, instanceId: "ticker-research:second" }),
      persistLayout: (layout) => { stateRef.current.config.layout = layout; },
      activatePane: (paneId) => { focused.push(paneId); }, focusVisiblePane: (paneId) => { focused.push(paneId); },
    });
    return <text>Research</text>;
  }
  const rendered = await tui.render(<Harness />);
  await act(async () => { await rendered.renderOnce(); });
  await act(async () => { await runtime.openPinnedTicker("NEE", { floating: true, paneType: TICKER_RESEARCH_PANE_ID }); });
  expect(focused).toEqual([des.instanceId]);
  expect(stateRef.current.config.layout.instances).toEqual([des]);
});

// With Ticker Research off, its pane would be added and then hidden.
test("opening a ticker while its pane's plugin is off offers to turn it on instead", async () => {
  const config = createDefaultConfig(":memory:");
  config.disabledPlugins = ["ticker-research"];
  const stateRef = { current: createInitialState(config) };
  stateRef.current.tickers.set("AAPL", createTestTicker("AAPL", "Apple", { exchange: "NASDAQ" }));
  const notifications: Array<{ body: string; action?: { label: string; onClick: () => void } }> = [];
  const enabled: string[] = [];
  const layouts: string[][] = [];
  let runtime!: ReturnType<typeof useAppTickerOpenRuntime>;
  function Harness() {
    runtime = useAppTickerOpenRuntime({
      stateRef,
      dataProvider: createTestDataProvider(),
      tickerRepository: { loadTicker: async () => null } as any,
      dispatch() {},
      pluginRegistry: {
        panes: new Map([[TICKER_RESEARCH_PANE_ID, { id: TICKER_RESEARCH_PANE_ID }]]),
        events: { emit() {} },
        getTermSize: () => ({ width: 120, height: 40 }),
        getDisabledPaneOwner: (_paneType: string, disabled: readonly string[]) => (
          disabled.includes("ticker-research") ? { id: "ticker-research", name: "Ticker Research" } : null
        ),
        notify: (notification: (typeof notifications)[number]) => { notifications.push(notification); },
        setPluginEnabled: (pluginId: string) => {
          enabled.push(pluginId);
          stateRef.current = { ...stateRef.current, config: { ...stateRef.current.config, disabledPlugins: [] } };
        },
      } as any,
      buildPaneInstance: (paneId, options) => createPaneInstance(paneId, { ...options, instanceId: "ticker-detail:opened" }),
      persistLayout: (layout) => {
        layouts.push(layout.instances.map((pane) => pane.instanceId));
        stateRef.current.config.layout = layout;
      },
      activatePane() {},
      focusVisiblePane() {},
    });
    return <text>Research</text>;
  }
  const rendered = await tui.render(<Harness />);
  await act(async () => { await rendered.renderOnce(); });

  await act(async () => { await runtime.openPinnedTicker("AAPL"); });
  expect(layouts).toEqual([]);
  expect(notifications).toHaveLength(1);
  expect(notifications[0]).toMatchObject({ body: "Turn on Ticker Research to open AAPL.", action: { label: "Turn on" } });

  // The button turns it on and opens what was asked for.
  await act(async () => {
    notifications[0]!.action!.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(enabled).toEqual(["ticker-research"]);
  expect(layouts.at(-1)).toContain("ticker-detail:opened");
});

// GLO-822: Zcash on the crypto board did not open while the signed-in quote for ZEC-USD:CCC failed,
// though search listed it. The open goes through the router the app uses, as a board row asks for it.
test.each([
  ["fails", true], ["prices another venue", true], ["fails", false],
] as const)("a board row opens its listing when the listing's quote %s (listed: %p)", async (quoteOutcome, listed) => {
  const stateRef = { current: createInitialState(createDefaultConfig(":memory:")) };
  const notifications: string[] = [];
  const created: string[] = [];
  const dataProvider = new AssetDataRouter(null, [createTestDataProvider({
    getQuote: async () => {
      if (quoteOutcome === "fails") throw new Error("Cloud quotes are unavailable for ZEC-USD:CCC");
      return createTestQuote({ symbol: "ZEC/USD", price: 1139, listingExchangeName: "BINANCE", exchangeName: "BINANCE" });
    },
    search: async () => listed
      ? [{ providerId: "cloud", symbol: "ZEC-USD", name: "Zcash USD", exchange: "CCC", currency: "USD", type: "CRYPTOCURRENCY" }]
      : [{ providerId: "cloud", symbol: "CBZEC-USD", name: "Coinbase Wrapped ZEC USD", exchange: "CCC", currency: "USD", type: "CRYPTOCURRENCY" }],
  })]);
  let runtime!: ReturnType<typeof useAppTickerOpenRuntime>;
  function Harness() {
    runtime = useAppTickerOpenRuntime({
      stateRef,
      dataProvider,
      tickerRepository: {
        loadTicker: async () => null,
        createTicker: async (metadata: TickerRecord["metadata"]) => { created.push(metadata.ticker); return { metadata }; },
      } as any,
      dispatch() {},
      pluginRegistry: { panes: new Map([[TICKER_RESEARCH_PANE_ID, { id: TICKER_RESEARCH_PANE_ID }]]), events: { emit() {} },
        notify: ({ body }: { body: string }) => { notifications.push(body); },
        getTermSize: () => ({ width: 120, height: 40 }), getDisabledPaneOwner: () => null } as any,
      buildPaneInstance: (paneId, options) => createPaneInstance(paneId, { ...options, instanceId: "ticker-research:zec" }),
      persistLayout: (layout) => { stateRef.current.config.layout = layout; },
      activatePane() {}, focusVisiblePane() {},
    });
    return <text>Research</text>;
  }
  const rendered = await tui.render(<Harness />);
  await act(async () => { await rendered.renderOnce(); });
  await act(async () => {
    await runtime.openPinnedTicker("ZEC-USD:CCC", { floating: true, paneType: TICKER_RESEARCH_PANE_ID, instrument: null });
  });
  const pane = stateRef.current.config.layout.instances.find((instance) => instance.instanceId === "ticker-research:zec");
  if (listed) {
    expect(notifications).toEqual([]);
    expect(created).toEqual(["ZEC-USD:CCC"]);
    expect(pane?.binding).toMatchObject({ kind: "fixed", symbol: "ZEC-USD:CCC", instrument: null, listing: { exchange: "CCC" } });
  } else {
    expect(notifications).toEqual(["Could not open ZEC-USD:CCC: no quote or listing found."]);
    expect(created).toEqual([]);
    expect(pane).toBeUndefined();
  }
});

// Regression: opening an option from its chain searched for its OCC symbol,
// which no provider lists, and failed instead of opening the contract.
test("a chosen listing that is not saved yet opens as given, with its broker contract and tab", async () => {
  const config = createDefaultConfig(":memory:");
  const stateRef = { current: createInitialState(config) };
  const actions: AppAction[] = [];
  const created: TickerRecord["metadata"][] = [];
  let searched = false;
  let runtime!: ReturnType<typeof useAppTickerOpenRuntime>;
  function Harness() {
    runtime = useAppTickerOpenRuntime({
      stateRef,
      dataProvider: createTestDataProvider({ search: async () => { searched = true; return []; } }),
      tickerRepository: {
        loadTicker: async () => null,
        createTicker: async (metadata: TickerRecord["metadata"]) => { created.push(metadata); return { metadata }; },
      } as any,
      dispatch: (action) => { actions.push(action); },
      pluginRegistry: {
        panes: new Map([[TICKER_RESEARCH_PANE_ID, { id: TICKER_RESEARCH_PANE_ID }]]),
        events: { emit() {} }, notify() {}, getTermSize: () => ({ width: 120, height: 40 }), getDisabledPaneOwner: () => null,
      } as any,
      buildPaneInstance: (paneId, options) => createPaneInstance(paneId, { ...options, instanceId: "ticker-detail:option" }),
      persistLayout: (layout) => { stateRef.current.config.layout = layout; },
      activatePane() {}, focusVisiblePane() {},
    });
    return <text>Research</text>;
  }
  const rendered = await tui.render(<Harness />);
  await act(async () => { await rendered.renderOnce(); });
  const instrument = { brokerId: "aries", brokerInstanceId: "sim", symbol: "AAPL", localSymbol: "AAPL261026C00345000", secType: "OPT", currency: "USD",
    lastTradeDateOrContractMonth: "20261026", right: "C" as const, strike: 345, multiplier: "100" };
  await act(async () => {
    await runtime.openPinnedTicker("AAPL261026C00345000", { instrument, listing: { name: "AAPL Oct 26 '26 $345 Call", exchange: "", currency: "USD", type: "OPT" }, tabId: "broker-trade", tabState: { brokerTradeIntent: "token" } });
  });
  expect(searched).toBe(false);
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ ticker: "AAPL261026C00345000", assetCategory: "OPT", currency: "USD", broker_contracts: [instrument] });
  expect(stateRef.current.config.layout.instances.find((pane) => pane.instanceId === "ticker-detail:option")?.binding)
    .toMatchObject({ kind: "fixed", symbol: "AAPL261026C00345000", instrument });
  expect(actions).toContainEqual({ type: "UPDATE_PANE_STATE", paneId: "ticker-detail:option", patch: { brokerTradeIntent: "token", activeTabId: "broker-trade" } });
});
