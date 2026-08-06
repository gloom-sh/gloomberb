import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { TestDialogProvider, createOpenTuiTestRoot as createRoot } from "../../../renderers/opentui/test-utils";
import { act, useReducer, type ReactElement } from "react";
import {
  AppContext,
  PaneInstanceProvider,
  appReducer,
  createInitialState,
  type AppAction,
} from "../../../state/app/context";
import { cloneLayout, createDefaultConfig, TICKER_RESEARCH_PANE_ID, type AppConfig } from "../../../types/config";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { TickerFinancials } from "../../../types/financials";
import type { TickerResearchTabDef } from "../../../types/plugin";
import type { TickerRecord } from "../../../types/ticker";
import { getNativeSurfaceManager } from "../../../components/chart/native/surface/manager";
import { setSharedRegistryForTests, type PluginRegistry } from "../../registry";
import { PluginRenderProvider } from "../../runtime";
import { tickerDetailModule } from ".";
import { chartComposerModule } from "../chart-composer";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestDataProvider } from "../../../test-support/data-provider";

const TEST_PANE_ID = "ticker-detail:test";
const DetailPane = tickerDetailModule.panes![0]!.component as (props: {
  paneId: string;
  paneType: string;
  focused: boolean;
  width: number;
  height: number;
}) => ReactElement;

let testSetup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;
let root: ReturnType<typeof createRoot> | undefined;
let harnessDispatch: ((action: AppAction) => void) | null = null;
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

const chartProvider = createTestDataProvider({
  getTickerFinancials: async () => makeFinancials(48),
  getPriceHistory: async () => makeFinancials(48).priceHistory,
});
const runtime = createTestPluginRuntime({ getMarketData: () => chartProvider });

function makeTicker(symbol: string): TickerRecord {
  return {
    metadata: {
      ticker: symbol,
      exchange: "NASDAQ",
      currency: "USD",
      name: symbol,
      portfolios: [],
      watchlists: [],
      positions: [],
      custom: {},
      tags: [],
    },
  };
}

function makeFinancials(length: number): TickerFinancials {
  return {
    annualStatements: [],
    quarterlyStatements: [],
    priceHistory: Array.from({ length }, (_, index) => ({
      date: new Date(Date.UTC(2024, 0, index + 1)),
      open: 100 + index * 0.4,
      high: 101 + index * 0.4,
      low: 99 + index * 0.4,
      close: 100.5 + index * 0.4,
      volume: 1_000 + index * 50,
    })),
  };
}

function makeFinancialsWithStatements(length: number): TickerFinancials {
  const financials = makeFinancials(length);
  financials.annualStatements = [
    { date: "2023-12-31", totalRevenue: 90, netIncome: 10 },
    { date: "2024-12-31", totalRevenue: 110, netIncome: 14 },
  ];
  return financials;
}

function makeDetailConfig(symbol: string): AppConfig {
  const config = createDefaultConfig("/tmp/gloomberb-test");
  config.chartPreferences.renderer = "kitty";
  config.layout = {
    dockRoot: { kind: "pane", instanceId: TEST_PANE_ID },
    instances: [{
      instanceId: TEST_PANE_ID,
      paneId: TICKER_RESEARCH_PANE_ID,
      binding: { kind: "fixed", symbol },
    }],
    floating: [],
    detached: [],
  };
  config.layouts = [{ name: "Default", layout: cloneLayout(config.layout) }];
  return config;
}

function makeRegistry(): PluginRegistry {
  const tickerResearchTabs = new Map<string, TickerResearchTabDef>();
  tickerDetailModule.setup?.({
    registerTickerResearchTab: (tab: TickerResearchTabDef) => tickerResearchTabs.set(tab.id, tab),
  } as any);
  chartComposerModule.setup?.({
    persistence: new MemoryPluginPersistence(),
    registerTickerResearchTab: (tab: TickerResearchTabDef) => tickerResearchTabs.set(tab.id, tab),
  } as any);
  return { tickerResearchTabs } as unknown as PluginRegistry;
}

function DetailHarness({
  config,
  ticker,
  financials,
  activeTabId = "overview",
}: {
  config: AppConfig;
  ticker: TickerRecord;
  financials: TickerFinancials;
  activeTabId?: string;
}) {
  const initialState = createInitialState(config);
  initialState.focusedPaneId = TEST_PANE_ID;
  initialState.tickers = new Map([[ticker.metadata.ticker, ticker]]);
  initialState.financials = new Map([[ticker.metadata.ticker, financials]]);
  initialState.paneState[TEST_PANE_ID] = { activeTabId };

  const [state, dispatch] = useReducer(appReducer, initialState);
  harnessDispatch = dispatch;

  return (
    <TestDialogProvider>
      <AppContext value={{ state, dispatch }}>
        <PaneInstanceProvider paneId={TEST_PANE_ID}>
          <PluginRenderProvider pluginId="ticker-research" runtime={runtime}>
            <DetailPane
              paneId={TEST_PANE_ID}
              paneType={TICKER_RESEARCH_PANE_ID}
              focused
              width={90}
              height={28}
            />
          </PluginRenderProvider>
        </PaneInstanceProvider>
      </AppContext>
    </TestDialogProvider>
  );
}

async function flushFrames(count = 3) {
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
      await testSetup!.renderOnce();
    });
  }
}

function hasCompositeSurface(
  manager: { surfaces: Map<string, { snapshot: { paneId: string } }> },
  paneId: string,
): boolean {
  return [...manager.surfaces.entries()].some(([id, surface]) => (
    id.startsWith("opentui-chart:") && surface.snapshot.paneId === paneId
  ));
}

function hasVisibleCompositeSurface(
  manager: { surfaces: Map<string, { snapshot: { paneId: string; visibleRect: unknown } }> },
  paneId: string,
): boolean {
  return [...manager.surfaces.entries()].some(([id, surface]) => (
    id.startsWith("opentui-chart:")
    && surface.snapshot.paneId === paneId
    && surface.snapshot.visibleRect !== null
  ));
}

afterEach(() => {
  harnessDispatch = null;
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = undefined;
  }
  if (testSetup) {
    testSetup.renderer.destroy();
    testSetup = undefined;
  }
  setSharedRegistryForTests(undefined);
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
});

describe("Ticker detail chart tab switching", () => {
  test("restores the overview kitty surface after visiting the full chart tab", async () => {
    const symbol = "AAPL";
    const config = makeDetailConfig(symbol);
    setSharedRegistryForTests(makeRegistry());

    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    testSetup = await createTestRenderer({ width: 120, height: 36 });
    (testSetup.renderer as unknown as { _capabilities: unknown })._capabilities = { kitty_graphics: true };
    (testSetup.renderer as unknown as { _resolution: unknown })._resolution = { width: 1200, height: 960 };

    root = createRoot(testSetup.renderer);
    act(() => {
      root!.render(
        <DetailHarness
          config={config}
          ticker={makeTicker(symbol)}
          financials={makeFinancials(48)}
        />,
      );
    });

    await flushFrames();
    const initialOverview = testSetup.captureCharFrame();
    expect(initialOverview).toContain("AAPL");
    const manager = getNativeSurfaceManager(testSetup.renderer as never) as unknown as {
      surfaces: Map<string, { snapshot: { paneId: string; visibleRect: unknown } }>;
    };
    expect(hasCompositeSurface(manager, TEST_PANE_ID)).toBe(true);

    act(() => {
      harnessDispatch!({
        type: "UPDATE_PANE_STATE",
        paneId: TEST_PANE_ID,
        patch: { activeTabId: "chart" },
      });
    });

    await flushFrames();
    const chartTabFrame = testSetup.captureCharFrame();
    expect(chartTabFrame).toContain("AAPL:XNAS Price");
    expect(chartTabFrame).toContain("5Y");
    expect(chartTabFrame).toContain("AUTO");
    expect(chartTabFrame).not.toContain("AAPL -");
    expect(hasVisibleCompositeSurface(manager, TEST_PANE_ID)).toBe(true);

    act(() => {
      harnessDispatch!({
        type: "UPDATE_PANE_STATE",
        paneId: TEST_PANE_ID,
        patch: { activeTabId: "overview" },
      });
    });

    await flushFrames();
    const returnedOverview = testSetup.captureCharFrame();
    expect(returnedOverview).toContain("AAPL");
    expect(hasCompositeSurface(manager, TEST_PANE_ID)).toBe(true);
  });

  test("hides the full chart kitty surface when switching to financials", async () => {
    const symbol = "AAPL";
    const config = makeDetailConfig(symbol);
    setSharedRegistryForTests(makeRegistry());

    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    testSetup = await createTestRenderer({ width: 120, height: 36 });
    (testSetup.renderer as unknown as { _capabilities: unknown })._capabilities = { kitty_graphics: true };
    (testSetup.renderer as unknown as { _resolution: unknown })._resolution = { width: 1200, height: 960 };

    root = createRoot(testSetup.renderer);
    act(() => {
      root!.render(
        <DetailHarness
          config={config}
          ticker={makeTicker(symbol)}
          financials={makeFinancialsWithStatements(48)}
        />,
      );
    });

    await flushFrames();
    const manager = getNativeSurfaceManager(testSetup.renderer as never) as unknown as {
      surfaces: Map<string, { snapshot: { paneId: string; visibleRect: unknown } }>;
    };

    act(() => {
      harnessDispatch!({
        type: "UPDATE_PANE_STATE",
        paneId: TEST_PANE_ID,
        patch: { activeTabId: "chart" },
      });
    });

    await flushFrames();
    expect(hasVisibleCompositeSurface(manager, TEST_PANE_ID)).toBe(true);

    act(() => {
      harnessDispatch!({
        type: "UPDATE_PANE_STATE",
        paneId: TEST_PANE_ID,
        patch: { activeTabId: "financials" },
      });
    });

    await flushFrames();
    expect(testSetup.captureCharFrame()).toContain("Income");
    expect(hasVisibleCompositeSurface(manager, TEST_PANE_ID)).toBe(false);
  });
});
