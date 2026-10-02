import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useReducer, type ReactElement } from "react";
import { PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { AppConfig } from "../../../types/config";
import type { TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import type { BrokerAccount } from "../../../types/trading";
import type { BrokerPortfolioPerformance } from "../../../types/trading";
import type { PluginRuntimeAccess } from "../../runtime";
import { portfolioAnalyticsModule } from "./index";
import { TestPaneProvider, createTestPaneConfig } from "../../../test-support/pane";
import { createTestTicker } from "../../../test-support/ticker";
import { createTestBrokerAdapter } from "../../../test-support/broker";

const TEST_PANE_ID = "analytics:test";

/** A figure in the overview's grid: its label, then its value (and any detail) on the same row. */
function figure(label: string, value: string): RegExp {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escape(label)} +${value.split(/ +/).map(escape).join(" +")}(?: |$)`, "m");
}
const BROKER_PORTFOLIO_ID = "broker:ibkr-flex:DU12345";
const GATEWAY_PORTFOLIO_ID = "broker:ibkr-live:DU12345";

const tui = createOpenTuiTestHarness();
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
  return createTestTicker("AAPL", "Apple", {
    sector: "Technology",
    portfolios: ["main", BROKER_PORTFOLIO_ID],
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
  });
}

function createBrokerTicker(portfolioId: string, brokerInstanceId: string): TickerRecord {
  return createTestTicker("AAPL", "Apple", {
    sector: "Technology",
    portfolios: [portfolioId],
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
  });
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

const flushFrame = () => tui.renderFrames(1);

beforeEach(() => {
  setSharedMarketDataCoordinator(null);
});

afterEach(() => {
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
        getPriceHistory: async () => [], getPriceHistoryForResolution: async () => [],
        getExchangeRate: async (source) => { requested.push(source); return 0.75; },
      }));
      setSharedMarketDataCoordinator(controlledCoordinator);
      const config = createAnalyticsConfig(BROKER_PORTFOLIO_ID);
      config.baseCurrency = "USD";
      config.brokerInstances = [{ id: "ibkr-flex", brokerType: "ibkr", label: "IBKR", config: {} }];
      await act(async () => {
        await tui.render(<AnalyticsHarness config={config} height={32}
          brokerAccounts={{ "ibkr-flex": [{ accountId: "DU12345", name: "Fixture", currency,
            netLiquidation: 20000, totalCashValue: 18000 }] }} />, { width: 100, height: 32 });
      });
      const frame = await tui.waitForFrameToContain(currency ? "15.0k" : "Unavailable");
      expect(frame).toMatch(figure("Net Liq", currency ? "15.0k" : "—"));
      expect(frame).toMatch(figure("Cash", currency ? "13.5k" : "—"));
      expect(frame).not.toMatch(figure("Net Liq", "20.0k"));
      if (currency) expect(requested).toContain("CAD");
      else expect(frame).toMatch(figure("FX", "Unavailable"));
    });
  }

  for (const withAccount of [true, false]) test(`cash-only accounts retain broker history without deriving returns from cash flows (account snapshot ${withAccount})`, async () => {
    const config = createAnalyticsConfig(BROKER_PORTFOLIO_ID);
    config.brokerInstances = [{ id: "ibkr-flex", brokerType: "ibkr", label: "IBKR", config: {} }];
    const ticker = createSharedTicker();
    ticker.metadata.positions = [];
    const adapter = createTestBrokerAdapter({
      id: "ibkr",
      getPortfolioPerformance: async () => ({ accountId: "DU12345", source: "flex", currency: "USD", period: "2026", fetchedAt: 1,
        points: [{ date: "2026-01-01", value: 10000, cumulativeReturn: 0 },
          { date: "2026-05-01", value: 21000, cumulativeReturn: .1 },
          { date: "2026-09-01", value: 6000, cumulativeReturn: .1 }] }),
    });
    await act(async () => {
      await tui.render(<AnalyticsHarness config={config} ticker={ticker} height={36}
        runtime={createTestPluginRuntime({ getBrokerAdapter: () => adapter })}
        brokerAccounts={withAccount ? { "ibkr-flex": [{ accountId: "DU12345", name: "Fixture", currency: "USD",
          netLiquidation: 6000, totalCashValue: 6000, grossPositionValue: 0 }] } : {}} />, { width: 100, height: 36 });
    });
    const frame = await tui.waitForFrameToContain("Sep 1 2026");
    if (withAccount) {
      expect(frame).toMatch(figure("Net Liq", "6.0k"));
      expect(frame).toMatch(figure("Cash", "6.0k"));
    } else {
      expect(frame).not.toContain("Net Liq");
      expect(frame).not.toContain("Cash");
      expect(frame).not.toMatch(figure("Val", "0"));
      expect(frame).not.toMatch(figure("P&L", "0"));
    }
    expect(frame).toMatch(figure("Broker return", "+10.00%"));
    expect(frame).not.toMatch(figure("Day", "0"));
    expect(frame).not.toMatch(figure("P&L", "0"));
    // The history takes the body a sector table would share, and its legend names it.
    const lines = frame.split("\n");
    const legend = lines.findIndex((line) => line.includes("● Value (USD)"));
    expect(legend).toBeGreaterThan(0);
    expect(lines.slice(legend).some((line) => line.includes("Sep 1 2026"))).toBe(true);
    expect(frame).not.toContain("Est. Sharpe");
    expect(frame).not.toContain("SECTOR");
  });

  test("an identity-only account cannot establish zero holdings values or P&L", async () => {
    const config = createAnalyticsConfig(BROKER_PORTFOLIO_ID);
    config.brokerInstances = [{ id: "ibkr-flex", brokerType: "ibkr", label: "IBKR", config: {} }];
    const ticker = createSharedTicker();
    ticker.metadata.positions = [];
    await act(async () => {
      await tui.render(<AnalyticsHarness config={config} ticker={ticker}
        brokerAccounts={{ "ibkr-flex": [{ accountId: "DU12345", name: "Fixture", currency: "USD" }] }} />,
      { width: 100, height: 24 });
    });
    await flushFrame();
    const frame = tui.frame();
    expect(frame).toMatch(figure("Source", "Cached"));
    expect(frame).not.toMatch(figure("Val", "0"));
    expect(frame).not.toMatch(figure("Day", "0"));
    expect(frame).not.toMatch(figure("P&L", "0"));
    expect(frame).not.toContain("Net Liq");
    expect(frame).not.toContain("Cash");
  });

  test("statement-only history shows loading and failure without inventing an empty account", async () => {
    const config = createAnalyticsConfig(BROKER_PORTFOLIO_ID);
    config.brokerInstances = [{ id: "ibkr-flex", brokerType: "ibkr", label: "IBKR", config: {} }];
    const ticker = createSharedTicker();
    ticker.metadata.positions = [];
    const { promise: history, reject: rejectHistory } = Promise.withResolvers<BrokerPortfolioPerformance>();
    const adapter = createTestBrokerAdapter({
      id: "ibkr",
      getPortfolioPerformance: async () => history,
    });
    await act(async () => {
      await tui.render(<AnalyticsHarness config={config} ticker={ticker}
        runtime={createTestPluginRuntime({ getBrokerAdapter: () => adapter })} />, { width: 100, height: 24 });
    });
    await flushFrame();
    let frame = tui.frame();
    expect(frame).toContain("Loading account history");
    expect(frame).not.toContain("No positions");
    expect(frame).not.toMatch(figure("Val", "0"));

    await act(async () => { rejectHistory(new Error("Statement service unavailable")); });
    await flushFrame();
    frame = tui.frame();
    expect(frame).toContain("Account history unavailable.");
    expect(frame).toContain("Statement service unavailable");
    expect(frame).not.toContain("No positions");
    expect(frame).not.toMatch(figure("P&L", "0"));

    await act(async () => { tui.setup().mockInput.pressArrow("left"); });
    await flushFrame();
    frame = tui.frame();
    expect(frame).toContain("No positions in this portfolio.");
    expect(frame).not.toContain("Statement service unavailable");
    expect(frame).not.toContain("Loading account history");
  });

  test("switching accounts hides prior performance while the next account is pending", async () => {
    const firstId = BROKER_PORTFOLIO_ID;
    const secondId = "broker:ibkr-flex:DU54321";
    const { promise: second, resolve: completeSecond } = Promise.withResolvers<BrokerPortfolioPerformance>();
    const adapter = createTestBrokerAdapter({
      id: "ibkr",
      getPortfolioPerformance: async (_instance, accountId) => accountId === "DU54321" ? second : {
        accountId, source: "flex", period: "First account", fetchedAt: 1,
        points: [{ date: "2026-01-01", value: 10000, cumulativeReturn: 0 }, { date: "2026-02-01", value: 11000, cumulativeReturn: .1 }],
      },
    });
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
      await tui.render(<AnalyticsHarness config={config} runtime={runtime} ticker={ticker} />, { width: 100, height: 24 });
      await tui.setup().renderOnce();
    });
    await flushFrame();
    expect(tui.frame()).toContain("+10.00%");
    await act(async () => { tui.setup().mockInput.pressArrow("right"); await tui.setup().renderOnce(); });
    await flushFrame();
    expect(harnessState?.paneState[TEST_PANE_ID]?.portfolioId).toBe(secondId);
    expect(tui.frame()).not.toContain("+10.00%");
    // The band holds its rows for the pending history instead of drawing the first account's.
    expect(tui.frame()).toContain("Loading history...");
    await act(async () => {
      completeSecond({ accountId: "DU54321", source: "flex", period: "Second account", fetchedAt: 1,
        points: [{ date: "2026-01-01", cumulativeReturn: 0 }, { date: "2026-02-01", cumulativeReturn: .2 }] });
      await second;
    });
    await flushFrame();
    expect(tui.frame()).toContain("+20.00%");
    expect(tui.frame()).not.toContain("+10.00%");
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

    // Tall enough for every figure; a shorter pane drops them from the end.
    await act(async () => {
      await tui.render(
        <AnalyticsHarness
          config={config}
          height={40}
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
        { width: 100, height: 40 },
      );
      await Promise.resolve();
      await tui.setup().renderOnce();
    });

    await flushFrame();

    const frame = tui.frame();
    expect(frame).toMatch(figure("Net Liq", "125.0k"));
    expect(frame).toMatch(figure("Val", "113.6k"));
    expect(frame).toMatch(figure("Margin Lev", "0.9x"));
    expect(frame).toMatch(figure("Cash", "-50.0k"));
    expect(frame).toMatch(figure("Day", "+900.00"));
    expect(frame).toMatch(figure("P&L", "+777.00"));
    expect(frame).toMatch(figure("Realized", "-25.00"));
    expect(frame).toMatch(figure("Settled", "-45.0k"));
    expect(frame).toMatch(figure("Avail", "15.0k"));
    expect(frame).toMatch(figure("Excess", "12.0k"));
    expect(frame).toMatch(figure("BP", "30.0k"));
    expect(frame).toMatch(figure("As Of", "Mar 26"));
    expect(frame).toMatch(figure("Source", "Flex Mar 26"));
  });

  test("falls back from a Gateway portfolio to a configured Flex profile for IBKR history", async () => {
    const calls: Array<{ instanceId: string; accountId: string }> = [];
    const historyBroker = createTestBrokerAdapter({
      id: "ibkr",
      getPortfolioPerformance: async (instance, accountId) => {
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
    });
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
      await tui.render(
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
      await tui.setup().renderOnce();
    });

    const frame = await tui.waitForFrameToContain("● Value (USD)");
    expect(calls).toEqual([
      { instanceId: "ibkr-live", accountId: "DU12345" },
      { instanceId: "ibkr-flex", accountId: "DU12345" },
    ]);
    expect(frame).toMatch(figure("Broker return", "+10.00% FLEX"));
    expect(frame).toContain("● Value (USD)");
    expect(frame).toContain("Technology");
    expect(frame).toContain("100.0%");
  });

  test("filters broker-managed positions to the active portfolio and uses the portfolio pane quote math", async () => {
    await act(async () => {
      await tui.render(
        <AnalyticsHarness
          config={createAnalyticsConfig(BROKER_PORTFOLIO_ID)}
          financials={createFinancials(140)}
        />,
        { width: 100, height: 24 },
      );
      await Promise.resolve();
      await tui.setup().renderOnce();
    });

    await flushFrame();

    const frame = tui.frame();
    expect(frame).toContain("Main Portfolio");
    expect(frame).toContain("Flex DU12345");
    expect(frame).toMatch(figure("Val", "1.4k"));
    expect(frame).toMatch(figure("P&L", "+400.00 +40.00%"));
    expect(frame).toContain("Technology               100.0%       1.4k    +400.00  +40.00%");
    expect(frame).not.toContain("1.3k");
    // Both portfolios' AAPL together would be 2.8k at this quote.
    expect(frame).not.toContain("2.8k");
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
    const adapter = createTestBrokerAdapter({ id: "ibkr", getPortfolioPerformance: async () => performance });
    const config = createAnalyticsConfig(BROKER_PORTFOLIO_ID);
    config.baseCurrency = "EUR";
    config.portfolios[1]!.currency = "JPY";
    config.brokerInstances = [{ id: "ibkr-flex", brokerType: "ibkr", label: "IBKR", enabled: true, config: {} }];
    controlledCoordinator = new MarketDataCoordinator(createTestDataProvider({
      getPriceHistory: async () => [], getPriceHistoryForResolution: async () => [],
    }));
    setSharedMarketDataCoordinator(controlledCoordinator);
    await act(async () => {
      await tui.render(<AnalyticsHarness config={config}
        runtime={createTestPluginRuntime({ getBrokerAdapter: () => adapter })}
        financials={createFinancials(125)} width={80} height={32} />, { width: 80, height: 32 });
    });
    await tui.renderFrames(6);
    const frame = tui.frame();
    expect(frame).toContain("Technology");
    if (scenario === "empty observations") {
      // No band: the footer warning says which observations are missing.
      expect(frame).not.toContain("●");
      expect(frame).not.toContain("Broker return");
      await tui.emitKeypress({ name: "!", sequence: "!", shift: true }, { trackPropagation: true });
      await flushFrame();
      expect(tui.frame()).toContain("3 missing return observations.");
    } else {
      expect(frame).toMatch(figure("Broker return", "+10.00%"));
      if (scenario === "dated correction") {
        // The correction leaves Sep 10 without a value, so the line ends on Jan 2 and the footer says why.
        expect(frame).toContain("● Value (USD) 11.0k");
        expect(frame).not.toContain("Sep 10 2026");
      } else {
        expect(frame).toContain("● Value (unknown currency) 21.0k");
        expect(frame).toContain("Jan 1 2026");
        expect(frame).toContain("Sep 10 2026");
      }
      expect(frame).not.toContain("Value (JPY)");
      if (scenario === "dated correction") {
        expect(frame).not.toContain("1 missing value observation.");
        await tui.emitKeypress({ name: "!", sequence: "!", shift: true }, { trackPropagation: true });
        await flushFrame();
        expect(tui.frame()).toContain("1 missing value observation.");
        await tui.emitKeypress({ name: "escape" }, { trackPropagation: true });
        await flushFrame();
        expect(tui.frame()).toContain("Technology");
      }
    }
  });
}

test("the overview draws the account history between its figures and the sector rows, and compacts it in a short pane", async () => {
  const performance: BrokerPortfolioPerformance = {
    accountId: "DU12345", source: "flex", period: "YTD", currency: "USD", fetchedAt: 1,
    points: Array.from({ length: 30 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 2, 2) + index * 7 * 86_400_000).toISOString().slice(0, 10),
      value: 10_000 + index * 150 + (index % 4) * 90,
    })),
  };
  const adapter = createTestBrokerAdapter({ id: "ibkr", getPortfolioPerformance: async () => performance });
  const config = createAnalyticsConfig(BROKER_PORTFOLIO_ID);
  config.brokerInstances = [{ id: "ibkr-flex", brokerType: "ibkr", label: "IBKR", enabled: true, config: {} }];
  const ticker = createSharedTicker();
  for (const [width, height] of [[78, 28], [60, 9]] as const) {
    controlledCoordinator = new MarketDataCoordinator(createTestDataProvider({
      getPriceHistory: async () => [], getPriceHistoryForResolution: async () => [],
    }));
    setSharedMarketDataCoordinator(controlledCoordinator);
    await act(async () => {
      await tui.render(<AnalyticsHarness config={config} ticker={ticker}
        runtime={createTestPluginRuntime({ getBrokerAdapter: () => adapter })}
        financials={createFinancials(125)} width={width} height={height} />, { width, height });
    });
    await tui.renderFrames(6);
    const lines = tui.frame().split("\n");
    const legend = lines.findIndex((line) => line.includes("● Value (USD)"));
    const header = lines.findIndex((line) => line.includes("SECTOR"));
    expect(legend).toBeGreaterThan(0);
    expect(lines[legend]).toContain(width === 78 ? "● Value (USD) 14.4k" : "● Value (USD) ");
    // The chart takes rows at the default size; in a short pane whose sector
    // rows fit whole it keeps a compact four rows instead of a strip over blank rows.
    expect(header - legend).toBeGreaterThan(width === 78 ? 6 : 0);
    if (width === 60) expect(header - legend).toBe(4);
    expect(lines.slice(header + 1).some((line) => line.includes("Technology"))).toBe(true);
    await tui.destroy();
    controlledCoordinator.destroy();
    controlledCoordinator = undefined;
  }
});
