import { afterEach, describe, expect, test } from "bun:test";
import { TestDialogProvider, createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { act, useReducer, type ReactElement } from "react";
import { appReducer, createInitialState, type AppAction } from "../../../state/app/context";
import { TICKER_RESEARCH_PANE_ID, type AppConfig } from "../../../types/config";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { TickerFinancials } from "../../../types/financials";
import type { TickerResearchTabDef } from "../../../types/plugin";
import type { TickerRecord } from "../../../types/ticker";
import { getNativeSurfaceManager } from "../../../components/chart/native/surface/manager";
import { setSharedRegistryForTests, type PluginRegistry } from "../../registry";
import { tickerDetailModule } from ".";
import { chartComposerModule } from "../chart-composer";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { TestPaneProvider, createTestTicker as makeTicker, createTestPaneConfig } from "../../../test-support/pane";

const TEST_PANE_ID = "ticker-detail:test";
const DetailPane = tickerDetailModule.panes![0]!.component as (props: {
  paneId: string;
  paneType: string;
  focused: boolean;
  width: number;
  height: number;
}) => ReactElement;

const tui = createOpenTuiTestHarness({ width: 120, height: 36 });
let harnessDispatch: ((action: AppAction) => void) | null = null;

const chartProvider = createTestDataProvider({
  getTickerFinancials: async () => makeFinancials(48),
  getPriceHistory: async () => makeFinancials(48).priceHistory,
});
const runtime = createTestPluginRuntime({ getMarketData: () => chartProvider });

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
  const config = createTestPaneConfig("/tmp/gloomberb-test", {
    instanceId: TEST_PANE_ID,
    paneId: TICKER_RESEARCH_PANE_ID,
    binding: { kind: "fixed", symbol },
  });
  config.chartPreferences.renderer = "kitty";
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
      <TestPaneProvider state={state} dispatch={dispatch} paneId={TEST_PANE_ID} pluginId="ticker-research" runtime={runtime}>
        <DetailPane
          paneId={TEST_PANE_ID}
          paneType={TICKER_RESEARCH_PANE_ID}
          focused
          width={90}
          height={28}
        />
      </TestPaneProvider>
    </TestDialogProvider>
  );
}

async function flushFrames(count = 3) {
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
      await tui.setup().renderOnce();
    });
  }
}

type SurfaceManager = { surfaces: Map<string, { snapshot: { paneId: string; visibleRect: unknown } }> };

/** Mounts the detail pane on a renderer that reports kitty graphics, and returns its surfaces. */
async function renderKittyDetail(node: ReactElement): Promise<SurfaceManager> {
  const { setup, root } = await tui.createRoot();
  (setup.renderer as unknown as { _capabilities: unknown })._capabilities = { kitty_graphics: true };
  (setup.renderer as unknown as { _resolution: unknown })._resolution = { width: 1200, height: 960 };
  act(() => {
    root.render(node);
  });
  await flushFrames();
  return getNativeSurfaceManager(setup.renderer as never) as unknown as SurfaceManager;
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
  setSharedRegistryForTests(undefined);
});

describe("Ticker detail chart tab switching", () => {
  test("restores the overview kitty surface after visiting the full chart tab", async () => {
    const symbol = "AAPL";
    const config = makeDetailConfig(symbol);
    setSharedRegistryForTests(makeRegistry());

    const manager = await renderKittyDetail(
      <DetailHarness
        config={config}
        ticker={makeTicker(symbol, "Apple Inc.")}
        financials={makeFinancials(48)}
      />,
    );
    expect(tui.frame()).toContain("Apple Inc.");
    expect(hasCompositeSurface(manager, TEST_PANE_ID)).toBe(true);

    act(() => {
      harnessDispatch!({
        type: "UPDATE_PANE_STATE",
        paneId: TEST_PANE_ID,
        patch: { activeTabId: "chart" },
      });
    });

    await flushFrames();
    const chartTabFrame = tui.frame();
    expect(chartTabFrame).toContain("AAPL:XNAS Price");
    expect(chartTabFrame).toContain("5Y");
    expect(chartTabFrame.toUpperCase()).toContain("AUTO");
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
    const returnedOverview = tui.frame();
    expect(returnedOverview).toContain("Apple Inc.");
    expect(hasCompositeSurface(manager, TEST_PANE_ID)).toBe(true);
  });

  test("hides the full chart kitty surface when switching to financials", async () => {
    const symbol = "AAPL";
    const config = makeDetailConfig(symbol);
    setSharedRegistryForTests(makeRegistry());

    const manager = await renderKittyDetail(
      <DetailHarness
        config={config}
        ticker={makeTicker(symbol)}
        financials={makeFinancialsWithStatements(48)}
      />,
    );

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
    expect(tui.frame()).toContain("Income");
    expect(hasVisibleCompositeSurface(manager, TEST_PANE_ID)).toBe(false);
  });
});
