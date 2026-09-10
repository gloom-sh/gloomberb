import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../../renderers/opentui/test-utils";
import { createTestDataProvider } from "../../test-support/data-provider";
import { createBrowserResearchLayout, BROWSER_RESEARCH_PANE_ID } from "../../renderers/browser/config-host";
import { createInitialState, type AppAction } from "../../state/app/context";
import { createDefaultConfig, createPaneInstance, TICKER_RESEARCH_PANE_ID } from "../../types/config";
import type { TickerRecord } from "../../types/ticker";
import { useAppTickerOpenRuntime } from "./ticker-open-runtime";

test("a slow linked ticker applies its tab to the reused or new pane after hydration", async () => {
  for (const reusePane of [true, false]) {
    const config = createDefaultConfig(":memory:");
    config.layout = createBrowserResearchLayout(reusePane ? "VOD:XLON" : "NVDA");
    const stateRef = { current: createInitialState(config) };
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
      const opening = runtime.openPinnedTicker("VOD:XLON", { tabId: "financials", floating: true });
      // Focus may change while the provider is still resolving the linked listing.
      stateRef.current.focusedPaneId = "world-indices:main";
      expect(actions).toEqual([]);
      releaseSearch();
      await act(async () => { await opening; });
      const paneId = reusePane ? BROWSER_RESEARCH_PANE_ID : "ticker-detail:linked";
      expect(actions).toContainEqual({ type: "UPDATE_PANE_STATE", paneId, patch: { activeTabId: "financials" } });
      expect(actions.filter((action) => action.type === "UPDATE_PANE_STATE")).toHaveLength(1);
      expect(actions.find((action) => action.type === "UPDATE_TICKER")).toMatchObject({ ticker: { metadata: { ticker: "VOD:XLON", exchange: "LSE" } } });
      expect(stateRef.current.config.layout.instances.find((pane) => pane.instanceId === paneId)?.binding)
        .toEqual({ kind: "fixed", symbol: "VOD:XLON" });
      expect(focused).toEqual([paneId]);
      expect(layouts).toBe(reusePane ? 0 : 1);
    } finally {
      await act(async () => { rendered.renderer.destroy(); });
    }
  }
});
