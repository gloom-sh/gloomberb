import { afterEach, describe, expect, test } from "bun:test";
import { act, useReducer, type ReactElement } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import { Box } from "../../../ui";
import {
  AppContext,
  appReducer,
  createInitialState,
  PaneInstanceProvider,
  type AppAction,
} from "../../../state/app/context";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { createTestDataProvider } from "../../../test-support/data-provider";
import {
  cloneLayout,
  createDefaultConfig,
  TICKER_RESEARCH_PANE_ID,
  type AppConfig,
  type BrokerInstanceConfig,
} from "../../../types/config";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { EventBus } from "../../event-bus";
import type { DataProvider } from "../../../types/data-provider";
import type { TickerFinancials } from "../../../types/financials";
import type { TickerResearchTabDef } from "../../../types/plugin";
import type { TickerRecord } from "../../../types/ticker";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import type { PluginRegistry } from "../../registry";
import { setSharedRegistryForTests } from "../../registry";
import { PluginRenderProvider } from "../../runtime";
import { tickerDetailModule } from ".";
import { chartComposerModule } from "../chart-composer";
import { FinancialsTab } from "./financials/tab";
import { isUsEquityTicker } from "../../../utils/sec";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";

const TEST_PANE_ID = "ticker-research:test";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
let harnessDispatch: React.Dispatch<AppAction> | null = null;
let financialsHarnessState: ReturnType<typeof createInitialState> | null = null;
let detailHarnessState: ReturnType<typeof createInitialState> | null = null;
let sharedCoordinator: MarketDataCoordinator | null = null;

const runtime = createTestPluginRuntime();
const TICKER_TAB_SETTLE_MS = 160;

const DetailPane = tickerDetailModule.panes![0]!.component as (props: {
  paneId: string;
  paneType: string;
  focused: boolean;
  width: number;
  height: number;
}) => ReactElement;

function makeTicker(
  symbol: string,
  name = symbol,
  overrides: Partial<TickerRecord["metadata"]> = {},
): TickerRecord {
  return {
    metadata: {
      ticker: symbol,
      exchange: "NASDAQ",
      currency: "USD",
      name,
      portfolios: [],
      watchlists: [],
      positions: [],
      custom: {},
      tags: [],
      ...overrides,
    },
  };
}

function makeFinancials(overrides: Partial<TickerFinancials> = {}): TickerFinancials {
  return {
    annualStatements: [],
    quarterlyStatements: [],
    priceHistory: [],
    ...overrides,
  };
}

function FinancialsTabHarness({ width }: { width: number }) {
  const config = createDefaultConfig("/tmp/gloomberb-test");
  config.layout.instances = config.layout.instances.map((instance) => (
    instance.instanceId === "ticker-detail:main"
      ? { ...instance, binding: { kind: "fixed" as const, symbol: "2337" } }
      : instance
  ));

  const state = createInitialState(config);
  const ticker = makeTicker("2337", "Mock Co");
  const financials: TickerFinancials = {
    annualStatements: [
      { date: "2021-12-31" },
      { date: "2022-12-31", totalRevenue: 43.49e9, operatingRevenue: 43.49e9, costOfRevenue: 20e9, grossProfit: 23.49e9, operatingIncome: 9.37e9, eps: 4.68, totalAssets: 64e9, currentAssets: 18e9, cashAndCashEquivalents: 3e9 },
      { date: "2023-12-31", totalRevenue: 27.62e9, operatingRevenue: 27.62e9, costOfRevenue: 16e9, grossProfit: 11.62e9, operatingIncome: -2.4e9, eps: -0.92, totalAssets: 67.89e9, currentAssets: 16.77e9, cashAndCashEquivalents: 3.93e9 },
      { date: "2024-12-31", totalRevenue: 25.88e9, operatingRevenue: 25.88e9, costOfRevenue: 15e9, grossProfit: 10.88e9, operatingIncome: -3.92e9, eps: -1.73, totalAssets: 69.23e9, currentAssets: 19.05e9, cashAndCashEquivalents: 3.79e9, accountsReceivable: 5.12e9 },
      { date: "2025-12-31", totalRevenue: 28.88e9, operatingRevenue: 28.88e9, costOfRevenue: 17e9, grossProfit: 11.88e9, operatingIncome: -3.7e9, eps: -1.77, totalAssets: 76.93e9, currentAssets: 26.95e9, cashAndCashEquivalents: 5.54e9, accountsReceivable: 7.45e9, inventory: 4.88e9 },
    ],
    quarterlyStatements: [
      { date: "2025-03-31", totalRevenue: 6e9, operatingRevenue: 6e9, costOfRevenue: 3e9, grossProfit: 3e9, operatingIncome: -1e9, eps: -0.4 },
      { date: "2025-06-30", totalRevenue: 6.5e9, operatingRevenue: 6.5e9, costOfRevenue: 3.3e9, grossProfit: 3.2e9, operatingIncome: -1.1e9, eps: -0.42 },
      { date: "2025-09-30", totalRevenue: 7e9, operatingRevenue: 7e9, costOfRevenue: 3.5e9, grossProfit: 3.5e9, operatingIncome: -1.2e9, eps: -0.45 },
      { date: "2025-12-31", totalRevenue: 7.08e9, operatingRevenue: 7.08e9, costOfRevenue: 3.7e9, grossProfit: 3.38e9, operatingIncome: -1.01e9, eps: -0.5, totalAssets: 76.93e9, currentAssets: 26.95e9, cashAndCashEquivalents: 5.54e9, accountsReceivable: 7.45e9, inventory: 4.88e9 },
    ],
    priceHistory: [],
  };

  state.tickers = new Map([["2337", ticker]]);
  state.financials = new Map([["2337", financials]]);
  const [appState, dispatch] = useReducer(appReducer, state);
  financialsHarnessState = appState;

  return (
    <AppContext value={{ state: appState, dispatch }}>
      <PaneInstanceProvider paneId="ticker-detail:main">
        <FinancialsTab
          width={width}
          focused
          headerScrollId="financials-header-scroll"
          bodyScrollId="financials-body-scroll"
        />
      </PaneInstanceProvider>
    </AppContext>
  );
}

function createFinancialsTabHarness(width: number) {
  return <FinancialsTabHarness width={width} />;
}

function createFinancialsTabFooterHarness(width = 90, height = 18) {
  const content = createFinancialsTabHarness(width);
  return (
    <PaneFooterProvider>
      {(footer) => (
        <Box flexDirection="column" width={width} height={height}>
          <Box height={height - 1}>{content}</Box>
          <PaneFooterBar footer={footer} focused width={width} />
        </Box>
      )}
    </PaneFooterProvider>
  );
}

function createProvider(hasOptions: boolean): DataProvider {
  return createTestDataProvider({
    getExchangeRate: async (currency) => (currency === "EUR" ? 1.1 : 1),
    getOptionsChain: async (ticker) => ({
      underlyingSymbol: ticker,
      expirationDates: hasOptions ? [1_717_113_600] : [],
      calls: [],
      puts: [],
    }),
  });
}

function setOptionsProvider(provider: DataProvider | undefined): void {
  sharedCoordinator = provider ? new MarketDataCoordinator(provider) : null;
  setSharedMarketDataCoordinator(sharedCoordinator);
}

function makeRegistry(): PluginRegistry {
  const stubTab = (_props: { width: number; height: number; focused: boolean; onCapture: (capturing: boolean) => void }) => (
    <text>stub</text>
  );
  const tickerResearchTabs = new Map<string, TickerResearchTabDef>();
  tickerDetailModule.setup?.({
    registerTickerResearchTab: (tab: TickerResearchTabDef) => tickerResearchTabs.set(tab.id, tab),
  } as any);
  chartComposerModule.setup?.({
    persistence: new MemoryPluginPersistence(),
    registerTickerResearchTab: (tab: TickerResearchTabDef) => tickerResearchTabs.set(tab.id, tab),
  } as any);
  for (const tab of [
    ["ibkr-trade", {
      id: "ibkr-trade",
      name: "Trade",
      order: 25,
      component: stubTab,
      isVisible: ({ config }) => config.brokerInstances.some((instance) => instance.brokerType === "ibkr" && instance.connectionMode === "gateway"),
    }],
    ["options", { id: "options", name: "Options", order: 35, component: stubTab, isVisible: ({ hasOptionsChain }) => hasOptionsChain }],
    ["sec", { id: "sec", name: "SEC", order: 45, component: stubTab, isVisible: ({ ticker }) => isUsEquityTicker(ticker) }],
    ["ai-chat", { id: "ai-chat", name: "Ask AI", order: 60, component: stubTab }],
  ] as Array<[string, TickerResearchTabDef]>) {
    tickerResearchTabs.set(tab[0], tab[1]);
  }
  return { tickerResearchTabs } as unknown as PluginRegistry;
}

function createGatewayInstance(id = "ibkr-paper"): BrokerInstanceConfig {
  return {
    id,
    brokerType: "ibkr",
    label: "Paper",
    connectionMode: "gateway",
    config: { connectionMode: "gateway", gateway: { host: "127.0.0.1", port: 4002, clientId: 1 } },
    enabled: true,
  };
}

function createDetailConfig(symbol: string, brokerInstances: BrokerInstanceConfig[] = []): AppConfig {
  const config = createDefaultConfig("/tmp/gloomberb-test");
  const layout = {
    dockRoot: { kind: "pane" as const, instanceId: TEST_PANE_ID },
    instances: [{
      instanceId: TEST_PANE_ID,
      paneId: TICKER_RESEARCH_PANE_ID,
      binding: { kind: "fixed" as const, symbol },
    }],
    floating: [],
    detached: [],
  };

  return {
    ...config,
    brokerInstances,
    layout,
    layouts: [{ name: "Default", layout: cloneLayout(layout) }],
  };
}

function createDetailState(
  config: AppConfig,
  ticker: TickerRecord,
  financials: TickerFinancials | null,
  activeTabId = "overview",
  exchangeRates?: Map<string, number>,
) {
  const state = createInitialState(config);
  state.focusedPaneId = TEST_PANE_ID;
  state.tickers = new Map([[ticker.metadata.ticker, ticker]]);
  state.financials = financials ? new Map([[ticker.metadata.ticker, financials]]) : new Map();
  state.paneState[TEST_PANE_ID] = { activeTabId };
  if (exchangeRates) {
    state.exchangeRates = exchangeRates;
  }
  return state;
}

function DetailHarness({
  config,
  ticker,
  financials,
  activeTabId = "overview",
  exchangeRates,
  width = 90,
  height = 24,
}: {
  config: AppConfig;
  ticker: TickerRecord;
  financials: TickerFinancials | null;
  activeTabId?: string;
  exchangeRates?: Map<string, number>;
  width?: number;
  height?: number;
}) {
  const initialState = createDetailState(config, ticker, financials, activeTabId, exchangeRates);
  const [state, dispatch] = useReducer(appReducer, initialState);
  harnessDispatch = dispatch;
  detailHarnessState = state;

  return (
    <AppContext value={{ state, dispatch }}>
      <PaneInstanceProvider paneId={TEST_PANE_ID}>
        <text>{`active:${state.paneState[TEST_PANE_ID]?.activeTabId ?? ""}`}</text>
        <PluginRenderProvider pluginId="ticker-research" runtime={runtime}>
          <DetailPane
            paneId={TEST_PANE_ID}
            paneType={TICKER_RESEARCH_PANE_ID}
            focused
            width={width}
            height={height}
          />
        </PluginRenderProvider>
      </PaneInstanceProvider>
    </AppContext>
  );
}

async function flushFrame() {
  await act(async () => {
    await testSetup!.renderOnce();
  });
}

async function settleTickerTabCommit() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, TICKER_TAB_SETTLE_MS));
    await testSetup!.renderOnce();
  });
}

async function clickFrameText(text: string) {
  const lines = testSetup!.captureCharFrame().split("\n");
  const row = lines.findIndex((line) => line.includes(text));
  expect(row).toBeGreaterThanOrEqual(0);
  const col = lines[row]!.indexOf(text);
  expect(col).toBeGreaterThanOrEqual(0);
  await act(async () => {
    await testSetup!.mockMouse.click(col + 1, row);
    await testSetup!.renderOnce();
  });
  await flushFrame();
}

async function emitKeypress(event: { name?: string; sequence?: string }) {
  await act(async () => {
    (testSetup!.renderer as any).keyInput.emit("keypress", {
      ctrl: false,
      meta: false,
      option: false,
      shift: false,
      eventType: "press",
      repeated: false,
      preventDefault: () => {},
      stopPropagation: () => {},
      ...event,
    });
    await Promise.resolve();
    await testSetup!.renderOnce();
  });
  await flushFrame();
}

function spanLineText(line: { spans: Array<{ text: string }> }): string {
  return line.spans.map((span) => span.text).join("");
}

function lineBackgroundKeys(line: { spans: Array<{ text: string; bg: { toInts(): number[] } }> }): Set<string> {
  const keys: string[] = [];
  for (const span of line.spans) {
    const key = span.bg.toInts().join(",");
    for (let index = 0; index < span.text.length; index += 1) keys.push(key);
  }
  keys.shift();
  keys.pop();
  return new Set(keys);
}

afterEach(() => {
  if (testSetup) {
    testSetup.renderer.destroy();
    testSetup = undefined;
  }
  harnessDispatch = null;
  financialsHarnessState = null;
  detailHarnessState = null;
  setSharedRegistryForTests(undefined);
  setOptionsProvider(undefined);
});

describe("FinancialsTab", () => {
  test("uses p to toggle the financial statement period", async () => {
    testSetup = await testRender(createFinancialsTabFooterHarness(100, 20), {
      width: 100,
      height: 20,
    });

    await flushFrame();
    await flushFrame();

    let frame = testSetup.captureCharFrame();
    expect(frame).toContain("Annual");
    expect(frame).toContain("[p]eriod");
    expect(frame).not.toContain("[a/q]period");

    await act(async () => {
      testSetup!.mockInput.pressKey("p");
      await testSetup!.renderOnce();
    });

    frame = testSetup.captureCharFrame();
    expect(financialsHarnessState?.paneState["ticker-detail:main"]?.financialPeriod).toBe("quarterly");
    expect(frame).toContain("Quarterly");
    expect(frame).toContain("[p]eriod");
  });

  test("clicks the period footer hint repeatedly", async () => {
    testSetup = await testRender(createFinancialsTabFooterHarness(100, 20), {
      width: 100,
      height: 20,
    });

    await flushFrame();
    await flushFrame();

    expect(testSetup.captureCharFrame()).toContain("Annual");

    await clickFrameText("[p]eriod");
    expect(financialsHarnessState?.paneState["ticker-detail:main"]?.financialPeriod).toBe("quarterly");

    await clickFrameText("[p]eriod");
    expect(financialsHarnessState?.paneState["ticker-detail:main"]?.financialPeriod).toBe("annual");
  });

  test("moves selection with down without collapsing the selected financial group", async () => {
    testSetup = await testRender(createFinancialsTabFooterHarness(100, 20), {
      width: 100,
      height: 20,
    });

    await flushFrame();
    await flushFrame();
    expect(testSetup.captureCharFrame()).toContain("Cost of Revenue");

    await act(async () => {
      testSetup!.mockInput.pressArrow("down");
      await testSetup!.renderOnce();
    });
    await flushFrame();

    expect(testSetup.captureCharFrame()).toContain("Cost of Revenue");
  });

  test("uses one hover background across financial group rows", async () => {
    testSetup = await testRender(createFinancialsTabFooterHarness(100, 20), {
      width: 100,
      height: 20,
    });

    await flushFrame();
    await flushFrame();

    const rows = testSetup.captureCharFrame().split("\n");
    const groupRowY = rows.findIndex((line) => line.includes("Operating Inc"));
    expect(groupRowY).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await testSetup!.mockMouse.moveTo(2, groupRowY);
      await testSetup!.renderOnce();
    });

    const groupLine = testSetup.captureSpans().lines.find((line) => (
      spanLineText(line).includes("Operating Inc")
    ));
    expect(groupLine).toBeDefined();
    expect(lineBackgroundKeys(groupLine!).size).toBe(1);
  });

  test("switches financial statement sections with left and right arrows", async () => {
    testSetup = await testRender(createFinancialsTabFooterHarness(100, 20), {
      width: 100,
      height: 20,
    });

    await flushFrame();
    await flushFrame();

    await act(async () => {
      testSetup!.mockInput.pressArrow("right");
      await testSetup!.renderOnce();
    });
    await flushFrame();

    expect(financialsHarnessState?.paneState["ticker-detail:main"]?.financialSubTab).toBe("cashflow");

    await act(async () => {
      testSetup!.mockInput.pressArrow("left");
      await testSetup!.renderOnce();
    });
    await flushFrame();

    expect(financialsHarnessState?.paneState["ticker-detail:main"]?.financialSubTab).toBe("income");
  });

});

describe("TickerResearchPane", () => {
  test("shows core and lightweight plugin tabs without waiting on options preflight", async () => {
    setSharedRegistryForTests(makeRegistry());
    setOptionsProvider(createProvider(false));

    testSetup = await testRender(
      <DetailHarness
        config={createDetailConfig("AAPL")}
        ticker={makeTicker("AAPL")}
        financials={null}
      />,
      { width: 90, height: 24 },
    );

    await flushFrame();
    await flushFrame();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Overview");
    expect(frame).toContain("Chart");
    expect(frame).toContain("Options");
    expect(frame).toContain("Ask AI");
    expect(frame).not.toContain("Financials");
    expect(frame).not.toContain("Trade");
  });

  test("shows Financials when statement data exists", async () => {
    setSharedRegistryForTests(makeRegistry());
    setOptionsProvider(createProvider(false));

    testSetup = await testRender(
      <DetailHarness
        config={createDetailConfig("AAPL")}
        ticker={makeTicker("AAPL")}
        financials={makeFinancials({
          annualStatements: [{ date: "2024-12-31", totalRevenue: 1_000 }],
        })}
      />,
      { width: 90, height: 24 },
    );

    await flushFrame();
    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Financials");
  });

  test("lets ticker detail tab arrows leave the embedded financials tab", async () => {
    setSharedRegistryForTests(makeRegistry());
    setOptionsProvider(createProvider(false));

    testSetup = await testRender(
      <DetailHarness
        config={createDetailConfig("AAPL")}
        ticker={makeTicker("AAPL")}
        financials={makeFinancials({
          annualStatements: [{ date: "2024-12-31", totalRevenue: 1_000 }],
        })}
        activeTabId="financials"
      />,
      { width: 90, height: 24 },
    );

    await flushFrame();
    expect(detailHarnessState?.paneState[TEST_PANE_ID]?.activeTabId).toBe("financials");

    await act(async () => {
      testSetup!.mockInput.pressArrow("right");
      await testSetup!.renderOnce();
    });
    await flushFrame();

    await settleTickerTabCommit();
    expect(detailHarnessState?.paneState[TEST_PANE_ID]?.activeTabId).toBe("chart");

    await act(async () => {
      testSetup!.mockInput.pressArrow("left");
      await testSetup!.renderOnce();
    });
    await flushFrame();

    await settleTickerTabCommit();
    expect(detailHarnessState?.paneState[TEST_PANE_ID]?.activeTabId).toBe("financials");
  });

  test("shows Trade when an IBKR gateway profile exists", async () => {
    setSharedRegistryForTests(makeRegistry());
    setOptionsProvider(createProvider(false));

    testSetup = await testRender(
      <DetailHarness
        config={createDetailConfig("AAPL", [createGatewayInstance()])}
        ticker={makeTicker("AAPL")}
        financials={null}
      />,
      { width: 90, height: 24 },
    );

    await flushFrame();
    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Trade");
  });

  test("shows Options for option-capable tickers without a preflight round trip", async () => {
    setSharedRegistryForTests(makeRegistry());
    setOptionsProvider(createProvider(true));

    testSetup = await testRender(
      <DetailHarness
        config={createDetailConfig("AAPL")}
        ticker={makeTicker("AAPL")}
        financials={null}
      />,
      { width: 90, height: 24 },
    );

    await flushFrame();
    await flushFrame();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Options");
  });

  test("shows SEC for US equities", async () => {
    setSharedRegistryForTests(makeRegistry());
    setOptionsProvider(createProvider(false));

    testSetup = await testRender(
      <DetailHarness
        config={createDetailConfig("AAPL")}
        ticker={makeTicker("AAPL")}
        financials={null}
      />,
      { width: 90, height: 24 },
    );

    await flushFrame();
    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("SEC");
  });

  test("hides plugin tabs when their owner plugin is disabled", async () => {
    setSharedRegistryForTests({
      ...makeRegistry(),
      getTickerResearchTabPluginId: (tabId: string) => (
        tabId === "sec" ? "ticker-research" : tabId
      ),
    } as unknown as PluginRegistry);
    setOptionsProvider(createProvider(false));
    const config = createDetailConfig("AAPL");
    config.disabledPlugins = ["ticker-research"];

    testSetup = await testRender(
      <DetailHarness
        config={config}
        ticker={makeTicker("AAPL")}
        financials={null}
      />,
      { width: 90, height: 24 },
    );

    await flushFrame();
    const frame = testSetup.captureCharFrame();
    expect(frame).not.toContain("SEC");
  });

  test("refreshes plugin tabs when registration completes after the pane mounted", async () => {
    const tickerResearchTabs = new Map<string, TickerResearchTabDef>();
    const events = new EventBus();
    setSharedRegistryForTests({
      tickerResearchTabs,
      events,
      getTickerResearchTabPluginId: () => "ticker-research",
    } as unknown as PluginRegistry);
    setOptionsProvider(createProvider(false));

    testSetup = await testRender(
      <DetailHarness
        config={createDetailConfig("AAPL")}
        ticker={makeTicker("AAPL")}
        financials={null}
      />,
      { width: 90, height: 24 },
    );

    await flushFrame();
    expect(testSetup.captureCharFrame()).not.toContain("Analyst");

    await act(async () => {
      tickerResearchTabs.set("analyst-research", {
        id: "analyst-research",
        name: "Analyst",
        order: 32,
        component: () => <text>Analyst body</text>,
        isVisible: ({ ticker }) => !!ticker,
      });
      events.emit("plugin:registered", { pluginId: "ticker-research" });
    });
    await flushFrame();

    expect(testSetup.captureCharFrame()).toContain("Analyst");
  });

  test("passes visible tab content height to plugin tabs", async () => {
    let receivedHeight: number | null = null;
    const probeTab: TickerResearchTabDef["component"] = ({ height }) => {
      receivedHeight = height;
      return <text>{`height:${height}`}</text>;
    };
    setSharedRegistryForTests({
      tickerResearchTabs: new Map<string, TickerResearchTabDef>([
        ["sec", { id: "sec", name: "SEC", order: 45, component: probeTab, isVisible: ({ ticker }) => isUsEquityTicker(ticker) }],
      ]),
    } as unknown as PluginRegistry);
    setOptionsProvider(createProvider(false));

    testSetup = await testRender(
      <DetailHarness
        config={createDetailConfig("AAPL")}
        ticker={makeTicker("AAPL")}
        financials={null}
        activeTabId="sec"
        height={18}
      />,
      { width: 90, height: 18 },
    );

    await flushFrame();
    const frame = testSetup.captureCharFrame();
    expect(Number(receivedHeight)).toBe(17);
    expect(frame).toContain("height:17");
  });

  test("hides SEC for non-US equities", async () => {
    setSharedRegistryForTests(makeRegistry());
    setOptionsProvider(createProvider(false));

    testSetup = await testRender(
      <DetailHarness
        config={createDetailConfig("0700")}
        ticker={makeTicker("0700", "Tencent", {
          exchange: "HKEX",
          currency: "HKD",
          assetCategory: "STK",
        })}
        financials={null}
      />,
      { width: 90, height: 24 },
    );

    await flushFrame();
    const frame = testSetup.captureCharFrame();
    expect(frame).not.toContain("SEC");
  });

  test("keeps quote prices native while converting market cap and position totals to base currency", async () => {
    setSharedRegistryForTests(makeRegistry());
    setOptionsProvider(createProvider(false));

    testSetup = await testRender(
      <DetailHarness
        config={createDetailConfig("SAP")}
        ticker={makeTicker("SAP", "SAP SE", {
          exchange: "XETRA",
          currency: "EUR",
          positions: [{
            portfolio: "broker:ibkr-interactive-brokers:UTEST12345",
            shares: 10,
            avgCost: 100,
            currency: "EUR",
            broker: "ibkr",
            markPrice: 125,
            marketValue: 1250,
            unrealizedPnl: 250,
          }],
        })}
        financials={makeFinancials({
          quote: {
            symbol: "SAP",
            price: 125,
            currency: "EUR",
            change: 5,
            changePercent: 4.17,
            marketCap: 2_000_000_000,
            previousClose: 120,
            name: "SAP SE",
            lastUpdated: Date.now(),
            marketState: "REGULAR",
          },
        })}
        exchangeRates={new Map([["USD", 1], ["EUR", 1.1]])}
        height={32}
      />,
      { width: 90, height: 32 },
    );

    await flushFrame();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("€125");
    expect(frame).toContain("2.20B USD");
    expect(frame).toContain("Account");
    expect(frame).toContain("Qty");
    expect(frame).toContain("Avg");
    expect(frame).toContain("Cost");
    expect(frame).toContain("Value");
    expect(frame).toContain("Ret");
    expect(frame).toContain("UTEST12345");
    expect(frame).toContain("10 sh");
    expect(frame).toContain("€100");
    expect(frame).toContain("€125");
    expect(frame).toContain("$1,100.00");
    expect(frame).toContain("$1,375.00");
    expect(frame).toContain("+$275.00");
    expect(frame).toContain("+25.00%");
  });

  test("renders an Overview fallback without overwriting a temporarily unavailable active tab", async () => {
    const gatewayConfig = createDetailConfig("AAPL", [createGatewayInstance()]);
    const noGatewayConfig = createDetailConfig("AAPL");
    setSharedRegistryForTests(makeRegistry());
    setOptionsProvider(createProvider(false));

    testSetup = await testRender(
      <DetailHarness
        config={gatewayConfig}
        ticker={makeTicker("AAPL")}
        financials={null}
        activeTabId="ibkr-trade"
      />,
      { width: 90, height: 24 },
    );

    await flushFrame();
    await act(async () => {
      harnessDispatch!({ type: "SET_CONFIG", config: noGatewayConfig });
      await Promise.resolve();
    });
    await flushFrame();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("active:ibkr-trade");
    expect(frame).not.toContain("Trade");
  });

  test("opens the Chart tab from a click on the overview price chart", async () => {
    setSharedRegistryForTests(makeRegistry());
    setOptionsProvider(createProvider(false));
    const priceHistory = Array.from({ length: 40 }, (_, index) => ({
      date: new Date(Date.UTC(2025, 0, index + 1)),
      close: 100 + index,
    }));

    testSetup = await testRender(
      <DetailHarness
        config={createDetailConfig("AAPL")}
        ticker={makeTicker("AAPL")}
        financials={makeFinancials({ priceHistory })}
      />,
      { width: 90, height: 24 },
    );

    await flushFrame();
    // The chart is not interactive here, so the click has to bubble out of
    // the plot surface to the overview's handler.
    const lines = testSetup.captureCharFrame().split("\n");
    const plotRow = lines.findIndex((line) => line.includes("$120"));
    expect(plotRow).toBeGreaterThan(0);
    await act(async () => {
      await testSetup!.mockMouse.click(5, plotRow);
      await testSetup!.renderOnce();
    });
    await flushFrame();

    expect(detailHarnessState?.paneState[TEST_PANE_ID]?.activeTabId).toBe("chart");
  });

});
