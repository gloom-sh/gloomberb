import { getDockedPaneIds } from "../../plugins/pane-manager";
import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../../renderers/opentui/test-utils";
import { createTestDataProvider } from "../../test-support/data-provider";
import { createBrowserResearchLayout, BROWSER_RESEARCH_PANE_ID } from "../../renderers/browser/config-host";
import { createInitialState, type AppAction } from "../../state/app/context";
import { createDefaultConfig, createPaneInstance, TICKER_RESEARCH_PANE_ID } from "../../types/config";
import type { TickerRecord } from "../../types/ticker";
import { useAppTickerOpenRuntime } from "./ticker-open-runtime";
import { researchEntryFromSearch } from "../../renderers/browser/research-entry";

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
    stateRef.current.tickers.set("VOD", { metadata: {
      ticker: "VOD", exchange: savedExchange,
      currency: savedExchange === "LSE" ? "GBP" : "ZAR", name: savedExchange === "LSE" ? "Vodafone" : "Vodacom",
      portfolios: [], watchlists: [], positions: [], custom: {}, tags: [],
    } });
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
          events: { emit() {} }, notify() {}, getTermSizeFn: () => ({ width: 120, height: 40 }),
        } as any,
        buildPaneInstance: (paneId, options) => createPaneInstance(paneId, { ...options, instanceId: "ticker-detail:linked" }),
        persistLayout: (layout) => { layouts++; stateRef.current.config.layout = layout; },
        activatePane: (paneId) => { focused.push(paneId); },
        focusVisiblePane: (paneId) => { focused.push(paneId); },
      });
      return <text>Research</text>;
    }
    const rendered = await testRender(<Harness />, { width: 20, height: 2 });
    try {
      await act(async () => { await rendered.renderOnce(); });
      const entry = researchEntryFromSearch("?ticker=VOD&exchange=LSE&tab=financials")!;
      const opening = runtime.openPinnedTicker(entry.symbol, { tabId: entry.tab, floating: true });
      // Focus may change while the provider is still resolving the linked listing.
      stateRef.current.focusedPaneId = "world-indices:main";
      // Explicit exact local matches may resolve without the deferred provider.
      if (savedExchange !== "LSE") expect(actions).toEqual([]);
      releaseSearch();
      await act(async () => { await opening; });
      const paneId = reusePane ? BROWSER_RESEARCH_PANE_ID : "ticker-detail:linked";
      expect(actions).toContainEqual({ type: "UPDATE_PANE_STATE", paneId, patch: { activeTabId: "financials" } });
      expect(actions.filter((action) => action.type === "UPDATE_PANE_STATE")).toHaveLength(1);
      expect(actions.find((action) => action.type === "UPDATE_TICKER")).toMatchObject({ ticker: { metadata: { ticker: "VOD:XLON", exchange: "LSE" } } });
      expect(stateRef.current.config.layout.instances.find((pane) => pane.instanceId === paneId)?.binding)
        .toEqual({ kind: "fixed", symbol: "VOD:XLON" });
      expect(focused).toEqual([paneId]);
      expect(layouts).toBe(savedListing === "VOD:XLON" ? 0 : 1);
      expect(stateRef.current.config.layout.instances.filter((pane) => pane.paneId === TICKER_RESEARCH_PANE_ID))
        .toHaveLength(reusePane ? 1 : 2);
    } finally {
      await act(async () => { rendered.renderer.destroy(); });
    }
  }
});


test("ambiguous deep links open the listing picker without publishing an arbitrary ticker", async () => {
  const actions: AppAction[] = [];
  const notifications: string[] = [];
  const stateRef = { current: createInitialState(createDefaultConfig(":memory:")) };
  let runtime!: ReturnType<typeof useAppTickerOpenRuntime>;
  function Harness() {
    runtime = useAppTickerOpenRuntime({
      stateRef,
      dataProvider: createTestDataProvider({
        search: async () => ["BYMA", "NYSE"].map((exchange) => ({ providerId: "cloud", symbol: "GLD", name: "SPDR", exchange, type: "ETF" })),
        getQuote: async () => ({ symbol: "GLD", price: 400, currency: "USD", lastUpdated: 1, change: 0, changePercent: 0 }),
      }),
      tickerRepository: { createTicker: async () => { throw new Error("Must not create an ambiguous ticker"); } } as any,
      dispatch: (action) => { actions.push(action); },
      pluginRegistry: { notify: ({ body }: { body: string }) => { notifications.push(body); } } as any,
      buildPaneInstance: () => null, persistLayout() {}, activatePane() {}, focusVisiblePane() {},
    });
    return <text>Research</text>;
  }
  const rendered = await testRender(<Harness />, { width: 20, height: 2 });
  try {
    await act(async () => { await rendered.renderOnce(); await runtime.openPinnedTicker("GLD"); });
    expect(actions).toEqual([{ type: "SET_COMMAND_BAR", open: true, query: "GLD", launch: { kind: "ticker-search", query: "GLD" } }]);
    expect(notifications[0]).toContain("Multiple listings match GLD");
  } finally {
    await act(async () => { rendered.renderer.destroy(); });
  }
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
  const ticker: TickerRecord = { metadata: { ticker: "RIVN:XNAS", exchange: "NASDAQ", currency: "USD", name: "Rivian",
    portfolios: [], watchlists: [], positions: [], custom: {}, tags: [] } };
  let runtime!: ReturnType<typeof useAppTickerOpenRuntime>;
  const activated: string[] = [];
  function Harness() {
    runtime = useAppTickerOpenRuntime({ stateRef, dataProvider: createTestDataProvider(), tickerRepository: {} as any, dispatch() {},
      pluginRegistry: { panes: new Map([[TICKER_RESEARCH_PANE_ID, { id: TICKER_RESEARCH_PANE_ID }]]), events: { emit() {} },
        getTermSizeFn: () => ({ width: 120, height: 40 }) } as any,
      buildPaneInstance: (paneId, options) => createPaneInstance(paneId, { ...options, instanceId: "ticker-detail:opened" }),
      persistLayout: (layout) => { stateRef.current.config.layout = layout; },
      activatePane: (paneId) => { activated.push(paneId); }, focusVisiblePane() {},
    });
    return <text>Research</text>;
  }
  const rendered = await testRender(<Harness />, { width: 20, height: 2 });
  try {
    await act(async () => { await rendered.renderOnce(); runtime.placePinnedTickerTarget({ symbol: "RIVN:XNAS", ticker, created: false }, { floating: false }); });
    const layout = stateRef.current.config.layout;
    expect(getDockedPaneIds(layout)).toContain("ticker-detail:opened");
    expect(layout.instances.find((pane) => pane.instanceId === "ticker-detail:opened")?.binding).toEqual({ kind: "fixed", symbol: "RIVN:XNAS" });
    expect(activated).toEqual(["ticker-detail:opened"]);
    if (mode !== "docked") expect(layout.floating.map((pane) => pane.instanceId)).toContain(source.instanceId);
    else expect(getDockedPaneIds(layout)).toContain(source.instanceId);
  } finally {
    await act(async () => { rendered.renderer.destroy(); });
  }
});
