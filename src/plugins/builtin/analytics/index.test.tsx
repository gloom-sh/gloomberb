import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useReducer, type ReactElement } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { AppConfig } from "../../../types/config";
import type { TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import type { BrokerAccount } from "../../../types/trading";
import type { PluginRuntimeAccess } from "../../runtime";
import { portfolioAnalyticsModule } from "./index";
import { TestPaneProvider, createTestPaneConfig } from "../../../test-support/pane";

const TEST_PANE_ID = "analytics:test";
const BROKER_PORTFOLIO_ID = "broker:ibkr-flex:DU12345";
const GATEWAY_PORTFOLIO_ID = "broker:ibkr-live:DU12345";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
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
}: {
  config: AppConfig;
  brokerAccounts?: Record<string, BrokerAccount[]>;
  financials?: TickerFinancials;
  runtime?: PluginRuntimeAccess;
  ticker?: TickerRecord;
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
      <AnalyticsPane
        paneId={TEST_PANE_ID}
        paneType="analytics"
        focused
        width={100}
        height={24}
      />
    </TestPaneProvider>
  );
}

async function flushFrame() {
  await act(async () => {
    await testSetup!.renderOnce();
  });
}

function expectBlankLineBetween(frame: string, beforeText: string, afterText: string) {
  const lines = frame.split("\n");
  const beforeRow = lines.findIndex((line) => line.includes(beforeText));
  const afterRow = lines.findIndex((line) => line.includes(afterText));

  expect(beforeRow).toBeGreaterThanOrEqual(0);
  expect(afterRow).toBe(beforeRow + 2);
  expect(lines[beforeRow + 1]?.trim()).toBe("");
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
  harnessState = null;
  setSharedMarketDataCoordinator(null);
});

describe("PortfolioAnalyticsPane", () => {
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
    expect(frame).toContain("Current-weight basket estimates");
    expect(frame).toContain("Est. Sharpe");
    expect(frame).toContain("Beta (SPY)");
    expect(frame).toContain("SECTOR");
    expectBlankLineBetween(frame, "Beta (SPY)", "Sector Allocation");
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
          config={config}
          runtime={runtime}
          ticker={createBrokerTicker(GATEWAY_PORTFOLIO_ID, "ibkr-live")}
        />,
        { width: 100, height: 24 },
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
    expect(frame).toContain("Hist Ret");
    expect(frame).toContain("+10.00%");
    expect(frame).toContain("Portfolio History");
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
