import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useReducer, type ReactElement } from "react";
import { PaneFooterProvider } from "../../../components/layout/pane/footer";
import { emitKeypress, testRender } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { AppConfig } from "../../../types/config";
import type { TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import type { BrokerAccount } from "../../../types/trading";
import type { BrokerAdapter } from "../../../types/plugin";
import type { BrokerPortfolioPerformance } from "../../../types/trading";
import type { PluginRuntimeAccess } from "../../runtime";
import { portfolioAnalyticsModule } from "./index";
import { TestPaneProvider, createTestPaneConfig } from "../../../test-support/pane";

const TEST_PANE_ID = "analytics:test";
const BROKER_PORTFOLIO_ID = "broker:ibkr-flex:DU12345";
const GATEWAY_PORTFOLIO_ID = "broker:ibkr-live:DU12345";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
let controlledCoordinator: MarketDataCoordinator | undefined;
let harnessState: ReturnType<typeof createInitialState> | null = null;

const AnalyticsPane = portfolioAnalyticsModule.panes![0]!.component as (props: {
  paneId: string;
  paneType: string;
  focused: boolean;
  width: number;
  height: number;
}) => ReactElement;

function createAnalyticsConfig(initialPortfolioId: string): AppConfig {
  const baseConfig = createTestPaneConfig("/tmp/gloomberb-analytics", {
    instanceId: TEST_PANE_ID,
    paneId: "analytics",
    binding: { kind: "none" },
    params: { portfolioId: initialPortfolioId },
  });

  return {
    ...baseConfig,
    portfolios: [
      { id: "main", name: "Main Portfolio", currency: "USD" },
      {
        id: BROKER_PORTFOLIO_ID,
        name: "Flex DU12345",
        currency: "USD",
        brokerId: "ibkr",
        brokerInstanceId: "ibkr-flex",
        brokerAccountId: "DU12345",
      },
    ],
  };
}

function createSharedTicker(): TickerRecord {
  return {
    metadata: {
      ticker: "AAPL",
      exchange: "NASDAQ",
      currency: "USD",
      name: "Apple",
      sector: "Technology",
      portfolios: ["main", BROKER_PORTFOLIO_ID],
      watchlists: [],
      positions: [
        {
          portfolio: "main",
          shares: 10,
          avgCost: 100,
          currency: "USD",
          broker: "manual",
          marketValue: 1200,
          unrealizedPnl: 200,
        },
        {
          portfolio: BROKER_PORTFOLIO_ID,
          shares: 10,
          avgCost: 100,
          currency: "USD",
          broker: "ibkr",
          brokerInstanceId: "ibkr-flex",
          brokerAccountId: "DU12345",
          marketValue: 1250,
          unrealizedPnl: 250,
        },
      ],
      custom: {},
      tags: [],
    },
  };
}

function createBrokerTicker(portfolioId: string, brokerInstanceId: string): TickerRecord {
  return {
    metadata: {
      ticker: "AAPL",
      exchange: "NASDAQ",
      currency: "USD",
      name: "Apple",
      sector: "Technology",
      portfolios: [portfolioId],
      watchlists: [],
      positions: [{
        portfolio: portfolioId,
        shares: 10,
        avgCost: 100,
        currency: "USD",
        broker: "ibkr",
        brokerInstanceId,
        brokerAccountId: "DU12345",
        marketValue: 1250,
        unrealizedPnl: 250,
      }],
      custom: {},
      tags: [],
    },
  };
}

function createFinancials(price: number): TickerFinancials {
  return {
    annualStatements: [],
    quarterlyStatements: [],
    priceHistory: [],
    quote: {
      symbol: "AAPL",
      price,
      currency: "USD",
      change: price - 130,
      changePercent: ((price - 130) / 130) * 100,
      previousClose: 130,
      lastUpdated: Date.now(),
    },
  };
}

function AnalyticsHarness({
  config,
  brokerAccounts,
  financials,
  runtime = createTestPluginRuntime(),
  ticker = createSharedTicker(),
  width = 100,
  height = 24,
}: {
  config: AppConfig;
  brokerAccounts?: Record<string, BrokerAccount[]>;
  financials?: TickerFinancials;
  runtime?: PluginRuntimeAccess;
  ticker?: TickerRecord;
  width?: number;
  height?: number;
}) {
  const initialState = createInitialState(config);
  initialState.focusedPaneId = TEST_PANE_ID;
  initialState.paneState[TEST_PANE_ID] = {
    portfolioId: config.layout.instances[0]?.params?.portfolioId,
  };
  initialState.tickers = new Map([["AAPL", ticker]]);
  initialState.brokerAccounts = brokerAccounts ?? {};
  if (financials) {
    initialState.financials = new Map([["AAPL", financials]]);
  }

  const [state, dispatch] = useReducer(appReducer, initialState);
  harnessState = state;

  return (
    <TestPaneProvider state={state} dispatch={dispatch} paneId={TEST_PANE_ID} pluginId="portfolio" runtime={runtime}>
      <PaneFooterProvider>{() => <AnalyticsPane
        paneId={TEST_PANE_ID}
        paneType="analytics"
        focused
        width={width}
        height={height}
      />}</PaneFooterProvider>
    </TestPaneProvider>
  );
}

async function flushFrame() {
  await act(async () => {
    await testSetup!.renderOnce();
  });
}

beforeEach(() => {
  setSharedMarketDataCoordinator(null);
});

afterEach(async () => {
  if (testSetup) {
    await act(async () => {
      testSetup!.renderer.destroy();
    });
    testSetup = undefined;
  }
  controlledCoordinator?.destroy();
  controlledCoordinator = undefined;
  harnessState = null;
  setSharedMarketDataCoordinator(null);
});

describe("PortfolioAnalyticsPane", () => {
  for (const currency of [undefined, "CAD"]) {
    test(`account summaries require source currency and request its FX (${currency ?? "unknown"})`, async () => {
      const requested: string[] = [];
      controlledCoordinator = new MarketDataCoordinator(createTestDataProvider({
        getQuote: async () => null, getPriceHistory: async () => [], getPriceHistoryForResolution: async () => [],
        getExchangeRate: async (source) => { requested.push(source); return 0.75; },
      }));
      setSharedMarketDataCoordinator(controlledCoordinator);
      const config = createAnalyticsConfig(BROKER_PORTFOLIO_ID);
      config.baseCurrency = "USD";
      config.brokerInstances = [{ id: "ibkr-flex", brokerType: "ibkr", config: {} }];
      await act(async () => {
        testSetup = await testRender(<AnalyticsHarness config={config} height={32}
          brokerAccounts={{ "ibkr-flex": [{ accountId: "DU12345", name: "Fixture", currency,
            netLiquidation: 20000, totalCashValue: 18000 }] }} />, { width: 100, height: 32 });
      });
      for (let index = 0; index < 6; index++) await flushFrame();
      const frame = testSetup!.captureCharFrame();
      expect(frame).toContain(currency ? "Net Liq       15k" : "Net Liq       —");
      expect(frame).toContain(currency ? "Cash          13.5k" : "Cash          —");
      expect(frame).not.toContain("Net Liq       20k");
      if (currency) expect(requested).toContain("CAD");
      else expect(frame).toContain("FX            Unavailable");
    });
  }

  for (const withAccount of [true, false]) test(`cash-only accounts retain broker history without deriving returns from cash flows (account snapshot ${withAccount})`, async () => {
    const config = createAnalyticsConfig(BROKER_PORTFOLIO_ID);
    config.brokerInstances = [{ id: "ibkr-flex", brokerType: "ibkr", config: {} }];
    const ticker = createSharedTicker();
    ticker.metadata.positions = [];
    const adapter: BrokerAdapter = {
      id: "ibkr", name: "Fixture", configSchema: [], validate: async () => true, importPositions: async () => [],
      getPortfolioPerformance: async () => ({ accountId: "DU12345", source: "flex", currency: "USD", period: "2026", fetchedAt: 1,
        points: [{ date: "2026-01-01", value: 10000, cumulativeReturn: 0 },
          { date: "2026-05-01", value: 21000, cumulativeReturn: .1 },
          { date: "2026-09-01", value: 6000, cumulativeReturn: .1 }] }),
    };
    await act(async () => {
      testSetup = await testRender(<AnalyticsHarness config={config} ticker={ticker} height={36}
        runtime={createTestPluginRuntime({ getBrokerAdapter: () => adapter })}
        brokerAccounts={withAccount ? { "ibkr-flex": [{ accountId: "DU12345", name: "Fixture", currency: "USD",
          netLiquidation: 6000, totalCashValue: 6000, grossPositionValue: 0 }] } : {}} />, { width: 100, height: 36 });
    });
    for (let index = 0; index < 6; index++) await flushFrame();
    const frame = testSetup!.captureCharFrame();
    if (withAccount) {
      expect(frame).toContain("Net Liq       6k");
      expect(frame).toContain("Cash          6k");
    } else {
      expect(frame).not.toContain("Net Liq");
      expect(frame).not.toContain("Cash");
      expect(frame).not.toContain("Val           0");
      expect(frame).not.toContain("P&L           +0");
    }
    expect(frame).toContain("Broker return +10.00%");
    expect(frame).not.toContain("Day           +0");
    expect(frame).not.toContain("P&L           +0");
    expect(frame).toContain("PORTFOLIO HISTORY");
    expect(frame).toContain("Value (USD)");
    expect(frame).not.toContain("CURRENT-WEIGHT BASKET ESTIMATES");
    expect(frame).not.toContain("Holdings by sector");
  });

  test("an identity-only account cannot establish zero holdings values or P&L", async () => {
    const config = createAnalyticsConfig(BROKER_PORTFOLIO_ID);
    config.brokerInstances = [{ id: "ibkr-flex", brokerType: "ibkr", config: {} }];
    const ticker = createSharedTicker();
    ticker.metadata.positions = [];
    await act(async () => {
      testSetup = await testRender(<AnalyticsHarness config={config} ticker={ticker}
        brokerAccounts={{ "ibkr-flex": [{ accountId: "DU12345", name: "Fixture", currency: "USD" }] }} />,
      { width: 100, height: 24 });
    });
    await flushFrame();
    const frame = testSetup!.captureCharFrame();
    expect(frame).toContain("Source        Cached");
    expect(frame).not.toContain("Val           0");
    expect(frame).not.toContain("Day           +0");
    expect(frame).not.toContain("P&L           +0");
    expect(frame).not.toContain("Net Liq");
    expect(frame).not.toContain("Cash");
  });

  test("statement-only history shows loading and failure without inventing an empty account", async () => {
    const config = createAnalyticsConfig(BROKER_PORTFOLIO_ID);
    config.brokerInstances = [{ id: "ibkr-flex", brokerType: "ibkr", config: {} }];
    const ticker = createSharedTicker();
    ticker.metadata.positions = [];
    let rejectHistory!: (reason: Error) => void;
    const history = new Promise<BrokerPortfolioPerformance>((_resolve, reject) => { rejectHistory = reject; });
    const adapter: BrokerAdapter = {
      id: "ibkr", name: "Fixture", configSchema: [], validate: async () => true, importPositions: async () => [],
      getPortfolioPerformance: async () => history,
    };
    await act(async () => {
      testSetup = await testRender(<AnalyticsHarness config={config} ticker={ticker}
        runtime={createTestPluginRuntime({ getBrokerAdapter: () => adapter })} />, { width: 100, height: 24 });
    });
    await flushFrame();
    let frame = testSetup!.captureCharFrame();
    expect(frame).toContain("Loading account history");
    expect(frame).not.toContain("No positions");
    expect(frame).not.toContain("Val           0");

    await act(async () => { rejectHistory(new Error("Statement service unavailable")); });
    await flushFrame();
    frame = testSetup!.captureCharFrame();
    expect(frame).toContain("Account history unavailable.");
    expect(frame).toContain("Statement service unavailable");
    expect(frame).not.toContain("No positions");
    expect(frame).not.toContain("P&L           +0");

    await act(async () => { testSetup!.mockInput.pressArrow("left"); });
    await flushFrame();
    frame = testSetup!.captureCharFrame();
    expect(frame).toContain("No positions in this portfolio.");
    expect(frame).not.toContain("Statement service unavailable");
    expect(frame).not.toContain("Loading account history");
  });

  test("switching accounts hides prior performance while the next account is pending", async () => {
    const firstId = BROKER_PORTFOLIO_ID;
    const secondId = "broker:ibkr-flex:DU54321";
    let completeSecond!: (value: BrokerPortfolioPerformance) => void;
    const second = new Promise<BrokerPortfolioPerformance>((resolve) => { completeSecond = resolve; });
    const adapter: BrokerAdapter = {
      id: "ibkr", name: "Fixture", configSchema: [], validate: async () => true, importPositions: async () => [],
      getPortfolioPerformance: async (_instance, accountId) => accountId === "DU54321" ? second : {
        accountId, source: "flex", period: "First account", fetchedAt: 1,
        points: [{ date: "2026-01-01", value: 10000, cumulativeReturn: 0 }, { date: "2026-02-01", value: 11000, cumulativeReturn: .1 }],
      },
    };
    const runtime = createTestPluginRuntime({ getBrokerAdapter: () => adapter });
    const config = createAnalyticsConfig(firstId);
    config.portfolios = [
      { id: firstId, name: "First", currency: "USD", brokerInstanceId: "ibkr-flex", brokerAccountId: "DU12345" },
      { id: secondId, name: "Second", currency: "USD", brokerInstanceId: "ibkr-flex", brokerAccountId: "DU54321" },
    ];
    config.brokerInstances = [{ id: "ibkr-flex", brokerType: "ibkr", label: "Fixture", enabled: false, config: {} }];
    const ticker = createSharedTicker();
    ticker.metadata.portfolios = [firstId, secondId];
    ticker.metadata.positions = [firstId, secondId].map((portfolio) => ({ ...ticker.metadata.positions[1]!, portfolio }));
    await act(async () => {
      testSetup = await testRender(<AnalyticsHarness config={config} runtime={runtime} ticker={ticker} />, { width: 100, height: 24 });
      await testSetup.renderOnce();
    });
    await flushFrame();
    expect(testSetup!.captureCharFrame()).toContain("+10.00%");
    await act(async () => { testSetup!.mockInput.pressArrow("right"); await testSetup!.renderOnce(); });
    await flushFrame();
    expect(harnessState?.paneState[TEST_PANE_ID]?.portfolioId).toBe(secondId);
    expect(testSetup!.captureCharFrame()).not.toContain("+10.00%");
    expect(testSetup!.captureCharFrame()).not.toContain("PORTFOLIO HISTORY");
    await act(async () => {
      completeSecond({ accountId: "DU54321", source: "flex", period: "Second account", fetchedAt: 1,
        points: [{ date: "2026-01-01", cumulativeReturn: 0 }, { date: "2026-02-01", cumulativeReturn: .2 }] });
      await second;
    });
    await flushFrame();
    expect(testSetup!.captureCharFrame()).toContain("+20.00%");
    expect(testSetup!.captureCharFrame()).not.toContain("+10.00%");
  });

  test("renders portfolio tabs and filters broker-managed positions to the active portfolio", async () => {
    await act(async () => {
      testSetup = await testRender(
        <AnalyticsHarness config={createAnalyticsConfig(BROKER_PORTFOLIO_ID)} />,
        { width: 100, height: 24 },
      );
      await Promise.resolve();
      await testSetup.renderOnce();
    });

    await flushFrame();

    const frame = testSetup!.captureCharFrame();
    expect(frame).toContain("Main Portfolio");
    expect(frame).toContain("Flex DU12345");
    expect(frame).toContain("Val           1.3k");
    expect(frame).toContain("P&L           +250  (+25.00%)");
    expect(frame).toContain("CURRENT-WEIGHT BASKET ESTIMATES");
    expect(frame).toContain("Est. Sharpe");
    expect(frame).toContain("Beta (SPY)");
    expect(frame).toContain("SECTOR");
    expect(frame).toContain("Technology");
    expect(frame).toContain("100.0%");
    expect(frame).not.toContain("2.5k");
  });

  test("switches portfolio tabs with the same arrow-key interaction as the portfolio pane", async () => {
    await act(async () => {
      testSetup = await testRender(
        <AnalyticsHarness config={createAnalyticsConfig("main")} />,
        { width: 100, height: 24 },
      );
      await Promise.resolve();
      await testSetup.renderOnce();
    });

    await flushFrame();
    expect(testSetup!.captureCharFrame()).toContain("Val           1.2k");

    await act(async () => {
      testSetup!.mockInput.pressArrow("right");
      await testSetup!.renderOnce();
    });
    await flushFrame();

    expect(harnessState?.paneState[TEST_PANE_ID]?.portfolioId).toBe(BROKER_PORTFOLIO_ID);
    expect(testSetup!.captureCharFrame()).toContain("Val           1.3k");
  });

  test("shows broker cash and margin data when account data is available", async () => {
    const baseConfig = createAnalyticsConfig(BROKER_PORTFOLIO_ID);
    const config = {
      ...baseConfig,
      portfolios: baseConfig.portfolios.map((portfolio) =>
        portfolio.id === BROKER_PORTFOLIO_ID
          ? { ...portfolio, lastSyncedAt: Date.now() + 10_000 }
          : portfolio
      ),
    };

    await act(async () => {
      testSetup = await testRender(
        <AnalyticsHarness
          config={config}
          brokerAccounts={{
            "ibkr-flex": [{
              accountId: "DU12345",
              name: "DU12345",
              currency: "USD",
              source: "flex",
              updatedAt: new Date(2026, 2, 27).getTime(),
              asOfDate: "2026-03-26",
              totalCashValue: -50000,
              settledCash: -45000,
              availableFunds: 15000,
              excessLiquidity: 12000,
              buyingPower: 30000,
              netLiquidation: 125000,
              grossPositionValue: 113636,
              dailyPnl: 900,
              unrealizedPnl: 777,
              realizedPnl: -25,
              cashBalances: [
                { currency: "USD", quantity: -50000, baseValue: -50000, baseCurrency: "USD" },
              ],
            }],
          }}
        />,
        { width: 100, height: 24 },
      );
      await Promise.resolve();
      await testSetup.renderOnce();
    });

    await flushFrame();

    const frame = testSetup!.captureCharFrame();
    expect(frame).toContain("Net Liq       125k");
    expect(frame).toContain("Val           113.6k");
    expect(frame).toContain("Margin Lev    0.9x");
    expect(frame).toContain("Cash          -50k");
    expect(frame).toContain("Day           +900");
    expect(frame).toContain("P&L           +777");
    expect(frame).toContain("Realized      -25");
    expect(frame).toContain("Settled       -45k");
    expect(frame).toContain("Avail         15k");
    expect(frame).toContain("Excess        12k");
    expect(frame).toContain("BP            30k");
    expect(frame).toContain("As Of         Mar 26");
    expect(frame).toContain("Source        Flex Mar 26");
  });

  test("falls back from a Gateway portfolio to a configured Flex profile for IBKR history", async () => {
    const calls: Array<{ instanceId: string; accountId: string }> = [];
    const historyBroker = {
      id: "ibkr",
      name: "Interactive Brokers",
      configSchema: [],
      validate: async () => true,
      importPositions: async () => [],
      getPortfolioPerformance: async (instance: { id: string }, accountId: string) => {
        calls.push({ instanceId: instance.id, accountId });
        if (instance.id !== "ibkr-flex") return null;
        return {
          accountId,
          source: "flex" as const,
          period: "FLEX",
          currency: "USD",
          fetchedAt: 1,
          points: [
            { date: "2025-01-02", value: 100000, cumulativeReturn: 0 },
            { date: "2026-05-15", value: 110000, cumulativeReturn: 0.1 },
          ],
        };
      },
    };
    const runtime = createTestPluginRuntime({
      getBrokerAdapter: (brokerType) => brokerType === "ibkr"
        ? historyBroker
        : null,
    });
    const baseConfig = createAnalyticsConfig(GATEWAY_PORTFOLIO_ID);
    const config = {
      ...baseConfig,
      portfolios: [
        ...baseConfig.portfolios,
        {
          id: GATEWAY_PORTFOLIO_ID,
          name: "Gateway DU12345",
          currency: "USD",
          brokerId: "ibkr",
          brokerInstanceId: "ibkr-live",
          brokerAccountId: "DU12345",
        },
      ],
      brokerInstances: [
        {
          id: "ibkr-live",
          brokerType: "ibkr",
          label: "IBKR Gateway",
          connectionMode: "gateway",
          config: { connectionMode: "gateway", gateway: { host: "127.0.0.1" } },
          enabled: true,
        },
        {
          id: "ibkr-flex",
          brokerType: "ibkr",
          label: "IBKR Flex",
          connectionMode: "flex",
          config: { connectionMode: "flex", flex: { token: "token", queryId: "query" } },
          enabled: true,
        },
      ],
    };

    await act(async () => {
      testSetup = await testRender(
        <AnalyticsHarness
          width={80}
          height={30}
          config={config}
          runtime={runtime}
          ticker={createBrokerTicker(GATEWAY_PORTFOLIO_ID, "ibkr-live")}
        />,
        { width: 80, height: 30 },
      );
      await Promise.resolve();
      await testSetup.renderOnce();
    });

    await flushFrame();
    await flushFrame();

    const frame = testSetup!.captureCharFrame();
    expect(calls).toEqual([
      { instanceId: "ibkr-live", accountId: "DU12345" },
      { instanceId: "ibkr-flex", accountId: "DU12345" },
    ]);
    expect(frame).toContain("Broker return");
    expect(frame).toContain("+10.00%");
    expect(frame).toContain("PORTFOLIO HISTORY");
    expect(frame).toContain("Technology");
    expect(frame).toContain("100.0%");
    expect(frame).toContain("Flex FLEX");
  });

  test("uses the portfolio pane quote math for value, pnl, and return", async () => {
    await act(async () => {
      testSetup = await testRender(
        <AnalyticsHarness
          config={createAnalyticsConfig(BROKER_PORTFOLIO_ID)}
          financials={createFinancials(140)}
        />,
        { width: 100, height: 24 },
      );
      await Promise.resolve();
      await testSetup.renderOnce();
    });

    await flushFrame();

    const frame = testSetup!.captureCharFrame();
    expect(frame).toContain("Val           1.4k");
    expect(frame).toContain("P&L           +400  (+40.00%)");
    expect(frame).toContain("Technology               100.0%       1.4k       +400  +40.00%");
    expect(frame).not.toContain("1.3k");
  });
});


for (const scenario of ["unknown currency", "dated correction", "empty observations"] as const) {
  test(`account history renders ${scenario} without changing the holdings table`, async () => {
    const points: BrokerPortfolioPerformance["points"] = [
      { date: "2026-01-01", value: 10000, cumulativeReturn: 0 },
      { date: "2026-01-02", value: 11000, cumulativeReturn: .1 },
      { date: "2026-09-10", value: 21000, cumulativeReturn: .1 },
    ];
    if (scenario === "dated correction") points.push({ date: "2026-09-10", cumulativeReturn: .1 });
    const performance: BrokerPortfolioPerformance = {
      accountId: "DU12345", source: "flex", period: "2026", fetchedAt: 1,
      currency: scenario === "unknown currency" ? undefined : "USD",
      points: scenario === "empty observations" ? points.map(({ date }) => ({ date })) : points,
    };
    const adapter: BrokerAdapter = {
      id: "ibkr", name: "Controlled history", configSchema: [], validate: async () => true,
      importPositions: async () => [], getPortfolioPerformance: async () => performance,
    };
    const config = createAnalyticsConfig(BROKER_PORTFOLIO_ID);
    config.baseCurrency = "EUR";
    config.portfolios[1]!.currency = "JPY";
    config.brokerInstances = [{ id: "ibkr-flex", brokerType: "ibkr", enabled: true, config: {} }];
    controlledCoordinator = new MarketDataCoordinator(createTestDataProvider({
      getQuote: async () => null, getPriceHistory: async () => [], getPriceHistoryForResolution: async () => [],
    }));
    setSharedMarketDataCoordinator(controlledCoordinator);
    await act(async () => {
      testSetup = await testRender(<AnalyticsHarness config={config}
        runtime={createTestPluginRuntime({ getBrokerAdapter: () => adapter })}
        financials={createFinancials(125)} width={80} height={32} />, { width: 80, height: 32 });
    });
    for (let index = 0; index < 6; index++) await flushFrame();
    const frame = testSetup!.captureCharFrame();
    expect(frame).toContain("Technology");
    if (scenario === "empty observations") {
      expect(frame).toContain("at least two observations");
      expect(frame).not.toContain("Enlarge this pane");
      expect(frame).not.toContain("Broker return");
    } else {
      expect(frame).toContain("Broker return +10.00%");
      expect(frame).toContain("Jan 1 2026");
      expect(frame).toContain("Sep 10 2026");
      expect(frame).toContain(scenario === "unknown currency" ? "Value (unknown currency)" : "Value (USD)");
      expect(frame).not.toContain("Value (JPY)");
      if (scenario === "dated correction") {
        expect(frame).not.toContain("1 missing value observation.");
        await emitKeypress(testSetup!, { name: "!", sequence: "!", shift: true }, { trackPropagation: true });
        await flushFrame();
        expect(testSetup!.captureCharFrame()).toContain("1 missing value observation.");
        await emitKeypress(testSetup!, { name: "escape" }, { trackPropagation: true });
        await flushFrame();
        expect(testSetup!.captureCharFrame()).toContain("Technology");
      }
    }
  });
}
