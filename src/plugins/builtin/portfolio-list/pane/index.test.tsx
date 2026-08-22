import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { act, useReducer } from "react";
import type { ReactElement } from "react";
import { testRender } from "../../../../renderers/opentui/test-utils";
import { AppPersistence } from "../../../../data/app-persistence";
import { TickerRepository } from "../../../../data/ticker-repository";
import { AppContext, appReducer, createInitialState, PaneInstanceProvider, type AppAction } from "../../../../state/app/context";
import { AssetDataRouter } from "../../../../sources/provider-router";
import {
  cloneLayout,
  createDefaultConfig,
  TICKER_RESEARCH_PANE_ID,
  type AppConfig,
  type BrokerInstanceConfig,
  type LayoutConfig,
} from "../../../../types/config";
import type { DataProvider } from "../../../../types/data-provider";
import type { Quote } from "../../../../types/financials";
import type { TickerRecord } from "../../../../types/ticker";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../../market-data/coordinator";
import { instrumentFromTicker } from "../../../../market-data/request-types";
import { createTestPluginRuntime } from "../../../../test-support/plugin-runtime";
import { PluginRenderProvider, type PluginRuntimeAccess } from "../../../runtime";
import { PluginRegistry, setSharedMarketDataForTests, setSharedRegistryForTests } from "../../../registry";
import type { BrokerAdapter } from "../../../../types/broker";
import { colors } from "../../../../theme/colors";
import { portfolioListModule } from "..";

const TEST_PANE_ID = "portfolio-list:test";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
let harnessDispatch: React.Dispatch<AppAction> | null = null;
let sharedCoordinator: MarketDataCoordinator | null = null;
let harnessState: ReturnType<typeof createInitialState> | null = null;
const tempPaths: string[] = [];
const tempPersistences: AppPersistence[] = [];

const PortfolioPane = portfolioListModule.panes![0]!.component as (props: {
  paneId: string;
  paneType: string;
  focused: boolean;
  width: number;
  height: number;
}) => ReactElement;

function createBrokerInstance(connectionMode: "gateway" | "flex", id = `ibkr-${connectionMode}`): BrokerInstanceConfig {
  return {
    id,
    brokerType: "ibkr",
    label: connectionMode === "gateway" ? "Gateway" : "Flex",
    connectionMode,
    config: connectionMode === "gateway"
      ? { connectionMode, gateway: { host: "127.0.0.1", port: 4002, clientId: 1 } }
      : { connectionMode, flex: { token: "token", queryId: "query" } },
    enabled: true,
  };
}

function createTempDbPath(name: string): string {
  const path = join(tmpdir(), `gloomberb-portfolio-list-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  tempPaths.push(path);
  return path;
}

function makeTicker(overrides: Partial<TickerRecord["metadata"]> = {}): TickerRecord {
  return {
    metadata: {
      ticker: "AAPL",
      exchange: "NASDAQ",
      currency: "USD",
      name: "Apple",
      portfolios: ["broker:ibkr-flex:DU12345", "broker:ibkr-live:DU12345"],
      watchlists: [],
      positions: [
        {
          portfolio: "broker:ibkr-flex:DU12345",
          shares: 10,
          avgCost: 100,
          currency: "USD",
          broker: "ibkr",
          brokerInstanceId: "ibkr-flex",
          brokerAccountId: "DU12345",
        },
        {
          portfolio: "broker:ibkr-live:DU12345",
          shares: 10,
          avgCost: 100,
          currency: "USD",
          broker: "ibkr",
          brokerInstanceId: "ibkr-live",
          brokerAccountId: "DU12345",
        },
      ],
      custom: {},
      tags: [],
      ...overrides,
    },
  };
}

function makeQuote(overrides: Partial<Quote> = {}): Quote {
  return {
    symbol: "AAPL",
    price: 125,
    bid: 124.95,
    ask: 125.05,
    bidSize: 100,
    askSize: 200,
    currency: "USD",
    change: 5,
    changePercent: 4.17,
    previousClose: 120,
    name: "Apple",
    lastUpdated: Date.now(),
    marketState: "REGULAR",
    ...overrides,
  };
}

function createPortfolioConfig(portfolioId: string, brokerInstances: BrokerInstanceConfig[] = []): AppConfig {
  const config = createDefaultConfig("/tmp/gloomberb-portfolio-list");
  const layout: LayoutConfig = {
    dockRoot: { kind: "pane" as const, instanceId: TEST_PANE_ID },
    instances: [{
      instanceId: TEST_PANE_ID,
      paneId: "portfolio-list",
      binding: { kind: "none" as const },
      params: { collectionId: portfolioId },
    }],
    floating: [],
    detached: [],
  };

  return {
    ...config,
    brokerInstances,
    portfolios: [
      ...config.portfolios,
      {
        id: portfolioId,
        name: portfolioId.includes("flex") ? "Flex DU12345" : "Live DU12345",
        currency: "USD",
        brokerId: "ibkr",
        brokerInstanceId: portfolioId.includes("flex") ? "ibkr-flex" : "ibkr-live",
        brokerAccountId: "DU12345",
      },
    ],
    layout,
    layouts: [{ name: "Default", layout: cloneLayout(layout) }],
  };
}

function createPortfolioConfigWithColumns(
  portfolioId: string,
  columnIds: string[],
  brokerInstances: BrokerInstanceConfig[] = [],
): AppConfig {
  const config = createPortfolioConfig(portfolioId, brokerInstances);
  const instance = config.layout.instances.find((entry) => entry.instanceId === TEST_PANE_ID);
  if (instance) {
    instance.settings = {
      ...(instance.settings ?? {}),
      columnIds,
    };
  }
  return config;
}

function createManualCollectionConfig(collectionId: string): AppConfig {
  const config = createDefaultConfig("/tmp/gloomberb-portfolio-list");
  const layout: LayoutConfig = {
    dockRoot: { kind: "pane" as const, instanceId: TEST_PANE_ID },
    instances: [{
      instanceId: TEST_PANE_ID,
      paneId: "portfolio-list",
      binding: { kind: "none" as const },
      params: { collectionId },
    }],
    floating: [],
    detached: [],
  };

  return {
    ...config,
    layout,
    layouts: [{ name: "Default", layout: cloneLayout(layout) }],
  };
}

function installQuickAddRegistry(provider: DataProvider): PluginRegistry {
  const persistence = new AppPersistence(createTempDbPath("quick-add"));
  tempPersistences.push(persistence);
  const registry = new PluginRegistry(provider, new TickerRepository(persistence.tickers), persistence);
  registry.getConfigFn = () => harnessState?.config ?? createDefaultConfig("/tmp/gloomberb-portfolio-list");
  return registry;
}

function createQuickAddProvider(match = true): DataProvider {
  return {
    id: "quick-add-test",
    name: "Quick Add Test",
    async getTickerFinancials() {
      return {
        annualStatements: [],
        quarterlyStatements: [],
        priceHistory: [],
        quote: makeQuote({ symbol: "MSFT", price: 420, change: 5.2, changePercent: 1.25, name: "Microsoft" }),
      };
    },
    async getQuote(symbol) {
      if (match && symbol === "MSFT") {
        return makeQuote({ symbol: "MSFT", price: 420, change: 5.2, changePercent: 1.25, name: "Microsoft" });
      }
      throw new Error(`No quote for ${symbol}`);
    },
    async getExchangeRate() {
      return 1;
    },
    async search(query) {
      if (!match || query !== "MSFT") return [];
      return [{
        providerId: "quick-add-test",
        symbol: "MSFT",
        name: "Microsoft",
        exchange: "NASDAQ",
        currency: "USD",
        type: "STK",
      }];
    },
    async getArticleSummary() {
      return null;
    },
    async getPriceHistory() {
      return [];
    },
  };
}

function createPortfolioState(
  config: AppConfig,
  collectionId: string,
  expanded = false,
  {
    ticker = makeTicker(),
    quote = makeQuote(),
    exchangeRates,
  }: {
    ticker?: TickerRecord;
    quote?: Quote;
    exchangeRates?: Map<string, number>;
  } = {},
) {
  const state = createInitialState(config);
  state.focusedPaneId = TEST_PANE_ID;
  state.paneState[TEST_PANE_ID] = {
    collectionId,
    cursorSymbol: "AAPL",
    cashDrawerExpanded: expanded,
  };
  state.tickers = new Map([["AAPL", ticker]]);
  state.financials = new Map([["AAPL", { annualStatements: [], quarterlyStatements: [], priceHistory: [], quote }]]);
  if (exchangeRates) {
    state.exchangeRates = exchangeRates;
  }
  return state;
}

function PortfolioHarness({
  config,
  collectionId,
  expanded = false,
  brokerAccounts = {},
  ticker,
  quote,
  exchangeRates,
  stateMutator,
  runtime = createTestPluginRuntime(),
  paneHeight = 24,
  paneFocused = true,
}: {
  config: AppConfig;
  collectionId: string;
  expanded?: boolean;
  brokerAccounts?: ReturnType<typeof createInitialState>["brokerAccounts"];
  ticker?: TickerRecord;
  quote?: Quote;
  exchangeRates?: Map<string, number>;
  stateMutator?: (state: ReturnType<typeof createInitialState>) => void;
  runtime?: PluginRuntimeAccess;
  paneHeight?: number;
  paneFocused?: boolean;
}) {
  const initialState = createPortfolioState(config, collectionId, expanded, {
    ticker,
    quote,
    exchangeRates,
  });
  initialState.brokerAccounts = brokerAccounts;
  stateMutator?.(initialState);
  const [state, dispatch] = useReducer(appReducer, initialState);
  harnessDispatch = dispatch;
  harnessState = state;

  return (
    <AppContext value={{ state, dispatch }}>
      <PaneInstanceProvider paneId={TEST_PANE_ID}>
        <PluginRenderProvider pluginId="portfolio" runtime={runtime}>
          <PortfolioPane
            paneId={TEST_PANE_ID}
            paneType="portfolio-list"
            focused={paneFocused}
            width={100}
            height={paneHeight}
          />
        </PluginRenderProvider>
      </PaneInstanceProvider>
    </AppContext>
  );
}

async function flushFrame() {
  await act(async () => {
    await Promise.resolve();
    await testSetup!.renderOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    await testSetup!.renderOnce();
  });
}

function makeSortWarmupQuote(symbol: string): Quote {
  return makeQuote({
    symbol,
    price: symbol === "SIVE" ? 46.7 : 100,
    change: symbol === "SIVE" ? -9.6 : 0,
    changePercent: symbol === "SIVE" ? -17.05 : 0,
    previousClose: symbol === "SIVE" ? 56.3 : 100,
    listingExchangeName: "NASDAQ",
  });
}

function makeSortWarmupBrokerTicker(portfolioId: string, symbol: string, index: number): TickerRecord {
  return makeTicker({
    ticker: symbol,
    name: symbol,
    portfolios: [portfolioId],
    positions: [{
      portfolio: portfolioId,
      shares: 10,
      avgCost: 100,
      currency: "USD",
      broker: "ibkr",
      brokerInstanceId: "ibkr-live",
      brokerAccountId: "DU12345",
      brokerContractId: 10_000 + index,
      markPrice: 100,
    }],
    broker_contracts: [{
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-live",
      symbol,
      localSymbol: symbol,
      exchange: "SMART",
      primaryExchange: "NASDAQ",
      conId: 10_000 + index,
    }],
  });
}

async function renderHiddenChangePctSortWarmup(options: { staleCachedSiveSnapshot?: boolean } = {}) {
  const portfolioId = "broker:ibkr-live:DU12345";
  const config = createPortfolioConfigWithColumns(
    portfolioId,
    ["ticker", "price", "change_pct", "latency"],
    [createBrokerInstance("gateway", "ibkr-live")],
  );
  const requestedSnapshots: string[] = [];
  const provider: DataProvider = {
    id: "test-provider",
    name: "Test Provider",
    async getTickerFinancials(symbol) {
      requestedSnapshots.push(symbol);
      return {
        annualStatements: [],
        quarterlyStatements: [],
        priceHistory: [],
        quote: makeSortWarmupQuote(symbol),
      };
    },
    async getQuote(symbol) {
      return makeSortWarmupQuote(symbol);
    },
    async getExchangeRate() {
      return 1;
    },
    async search() {
      return [];
    },
    async getArticleSummary() {
      return null;
    },
    async getPriceHistory() {
      return [];
    },
    subscribeQuotes() {
      return () => {};
    },
  };
  sharedCoordinator = new MarketDataCoordinator(provider);
  setSharedMarketDataCoordinator(sharedCoordinator);

  const tickers = Array.from({ length: 29 }, (_, index) => makeSortWarmupBrokerTicker(portfolioId, `T${String(index).padStart(2, "0")}`, index));
  const sive = makeSortWarmupBrokerTicker(portfolioId, "SIVE", 29);
  if (options.staleCachedSiveSnapshot) {
    const siveInstrument = instrumentFromTicker(sive, "SIVE", { portfolioId });
    if (!siveInstrument) throw new Error("expected SIVE instrument");
    sharedCoordinator.primeCachedFinancials([{
      instrument: siveInstrument,
      financials: {
        annualStatements: [],
        quarterlyStatements: [],
        priceHistory: [],
        quote: makeQuote({
          symbol: "SIVE",
          price: 56.3,
          change: 56.3,
          changePercent: 100,
          previousClose: 0,
          listingExchangeName: "NASDAQ",
          lastUpdated: Date.now() - 24 * 60 * 60_000,
          stale: true,
        }),
      },
    }]);
  }

  testSetup = await testRender(
    <PortfolioHarness
      config={config}
      collectionId={portfolioId}
      stateMutator={(state) => {
        state.tickers = new Map([...tickers, sive].map((entry) => [entry.metadata.ticker, entry]));
        state.financials = new Map(tickers.map((entry, index) => [
          entry.metadata.ticker,
          {
            annualStatements: [],
            quarterlyStatements: [],
            priceHistory: [],
            quote: makeQuote({
              symbol: entry.metadata.ticker,
              price: 100 + index,
              change: index,
              changePercent: index,
              listingExchangeName: "NASDAQ",
            }),
          },
        ]));
        state.paneState[TEST_PANE_ID] = {
          collectionId: portfolioId,
          cursorSymbol: "T00",
          cashDrawerExpanded: false,
          collectionSorts: {
            [portfolioId]: { columnId: "change_pct", direction: "asc" },
          },
        };
      }}
      paneHeight={12}
    />,
    { width: 100, height: 12 },
  );

  await flushFrame();
  const beforeFrame = testSetup.captureCharFrame();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
  await flushFrame();

  return { beforeFrame, frame: testSetup.captureCharFrame(), requestedSnapshots };
}

afterEach(async () => {
  if (testSetup) {
    testSetup.renderer.destroy();
    testSetup = undefined;
  }
  harnessDispatch = null;
  sharedCoordinator = null;
  setSharedMarketDataCoordinator(null);
  setSharedMarketDataForTests(undefined);
  setSharedRegistryForTests(undefined);
  harnessState = null;
  for (const persistence of tempPersistences.splice(0)) {
    persistence.close();
  }
  for (const path of tempPaths.splice(0)) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
});

describe("PortfolioListPane cash and margin UI", () => {
  test("opens the selected ticker on a second row click", async () => {
    const portfolioId = "broker:ibkr-flex:DU12345";
    const config = createPortfolioConfig(portfolioId, [createBrokerInstance("flex")]);
    const pinned: Array<{ symbol: string; options: { floating?: boolean; paneType?: string } | undefined }> = [];
    const runtime = createTestPluginRuntime({
      navigateTicker: () => {
        throw new Error("portfolio rows should open fixed floating panes directly");
      },
      pinTicker: (symbol, options) => {
        pinned.push({ symbol, options });
      },
    });

    testSetup = await testRender(
      <PortfolioHarness config={config} collectionId={portfolioId} runtime={runtime} />,
      { width: 100, height: 24 },
    );

    await flushFrame();
    const rowY = testSetup.captureCharFrame().split("\n").findIndex((line) => line.includes("AAPL"));
    expect(rowY).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await testSetup!.mockMouse.click(2, rowY);
      await testSetup!.renderOnce();
    });
    expect(pinned).toEqual([]);

    await act(async () => {
      await testSetup!.mockMouse.click(2, rowY);
      await testSetup!.renderOnce();
    });
    expect(pinned).toEqual([{ symbol: "AAPL", options: { floating: true, paneType: TICKER_RESEARCH_PANE_ID } }]);
  });

  test("quick-add validates and adds an exact watchlist ticker", async () => {
    const config = createManualCollectionConfig("watchlist");
    const notifications: Array<{ type?: string; body: string }> = [];
    installQuickAddRegistry(createQuickAddProvider(true));

    testSetup = await testRender(
      <PortfolioHarness
        config={config}
        collectionId="watchlist"
        ticker={makeTicker({ portfolios: [], watchlists: [], positions: [] })}
        runtime={createTestPluginRuntime({
          notify: (notification) => notifications.push(notification),
        })}
        paneHeight={12}
      />,
      { width: 100, height: 12 },
    );

    await flushFrame();
    await act(async () => {
      testSetup!.mockInput.pressKey("a");
      await testSetup!.renderOnce();
    });
    await act(async () => {
      await testSetup!.mockInput.typeText("MSFT");
      await testSetup!.renderOnce();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 360));
    });
    await flushFrame();

    const previewFrame = testSetup.captureCharFrame();
    expect(previewFrame).toContain("420");
    expect(previewFrame).not.toMatch(/MSFT\s+420/);
    expect(previewFrame).toContain("+1.25%");

    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await Promise.resolve();
      await testSetup!.renderOnce();
    });
    await flushFrame();

    expect(harnessState?.tickers.get("MSFT")?.metadata.watchlists).toEqual(["watchlist"]);
    expect(notifications.at(-1)).toMatchObject({
      type: "success",
      body: "Added MSFT to Watchlist.",
    });
  });

  test("quick-add adds an exact ticker to a manual portfolio", async () => {
    const config = createManualCollectionConfig("main");
    const notifications: Array<{ type?: string; body: string }> = [];
    installQuickAddRegistry(createQuickAddProvider(true));

    testSetup = await testRender(
      <PortfolioHarness
        config={config}
        collectionId="main"
        ticker={makeTicker({ portfolios: [], watchlists: [], positions: [] })}
        runtime={createTestPluginRuntime({
          notify: (notification) => notifications.push(notification),
        })}
        paneHeight={12}
      />,
      { width: 100, height: 12 },
    );

    await flushFrame();
    await act(async () => {
      testSetup!.mockInput.pressKey("n");
      await testSetup!.renderOnce();
    });
    await act(async () => {
      await testSetup!.mockInput.typeText("MSFT");
      await testSetup!.renderOnce();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 360));
    });
    await flushFrame();

    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await Promise.resolve();
      await testSetup!.renderOnce();
    });
    await flushFrame();

    expect(harnessState?.tickers.get("MSFT")?.metadata.portfolios).toEqual(["main"]);
    expect(notifications.at(-1)).toMatchObject({
      type: "success",
      body: "Added MSFT to Main Portfolio.",
    });
  });

  test("quick-add rejects unresolved ticker input", async () => {
    const config = createManualCollectionConfig("watchlist");
    const notifications: Array<{ type?: string; body: string }> = [];
    installQuickAddRegistry(createQuickAddProvider(false));

    testSetup = await testRender(
      <PortfolioHarness
        config={config}
        collectionId="watchlist"
        ticker={makeTicker({ portfolios: [], watchlists: [], positions: [] })}
        runtime={createTestPluginRuntime({
          notify: (notification) => notifications.push(notification),
        })}
        paneHeight={12}
      />,
      { width: 100, height: 12 },
    );

    await flushFrame();
    await act(async () => {
      testSetup!.mockInput.pressKey("n");
      await testSetup!.renderOnce();
    });
    await act(async () => {
      await testSetup!.mockInput.typeText("NOPE");
      await testSetup!.renderOnce();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 360));
    });
    await flushFrame();

    expect(testSetup.captureCharFrame()).toContain("No exact ticker match");

    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await Promise.resolve();
      await testSetup!.renderOnce();
    });
    await flushFrame();

    expect(harnessState?.tickers.has("NOPE")).toBe(false);
    expect(notifications.at(-1)).toMatchObject({
      type: "error",
      body: "No exact ticker match",
    });
  });

  test("keeps non-broker portfolios unchanged", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-portfolio-list");
    const layout: LayoutConfig = {
      dockRoot: { kind: "pane" as const, instanceId: TEST_PANE_ID },
      instances: [{
        instanceId: TEST_PANE_ID,
        paneId: "portfolio-list",
        binding: { kind: "none" as const },
        params: { collectionId: "main" },
      }],
      floating: [],
      detached: [],
    };
    const nextConfig = { ...config, layout, layouts: [{ name: "Default", layout: cloneLayout(layout) }] };

    testSetup = await testRender(
      <PortfolioHarness config={nextConfig} collectionId="main" />,
      { width: 100, height: 24 },
    );

    await flushFrame();

    const frame = testSetup.captureCharFrame();
    expect(frame).not.toContain("Cash & Margin");
  });

  test("renders one-month sparkline column when price history is loaded", async () => {
    const config = createPortfolioConfigWithColumns(
      "broker:ibkr-flex:DU12345",
      ["ticker", "price", "sparkline"],
      [createBrokerInstance("flex")],
    );

    testSetup = await testRender(
      <PortfolioHarness
        config={config}
        collectionId="broker:ibkr-flex:DU12345"
        stateMutator={(state) => {
          state.financials = new Map([[
            "AAPL",
            {
              annualStatements: [],
              quarterlyStatements: [],
              quote: makeQuote(),
              priceHistory: [118, 121, 119, 124, 127, 126, 130].map((close, index) => ({
                date: `2026-03-${20 + index}T00:00:00Z` as unknown as Date,
                close,
              })),
            },
          ]]);
        }}
      />,
      { width: 100, height: 12 },
    );

    await flushFrame();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("1M");
    const row = frame.split("\n").find((line) => line.includes("AAPL")) ?? "";
    expect(row).toMatch(/[\u2800-\u28ff]/);
  });

  test("keeps native price and avg cost while converting market value and pnl to base currency", async () => {
    const portfolioId = "broker:ibkr-flex:DU12345";
    const config = createPortfolioConfigWithColumns(
      portfolioId,
      ["ticker", "price", "change_pct", "shares", "avg_cost", "cost_basis", "mkt_value", "pnl"],
      [createBrokerInstance("flex")],
    );

    testSetup = await testRender(
      <PortfolioHarness
        config={config}
        collectionId={portfolioId}
        ticker={makeTicker({
          currency: "EUR",
          positions: [
            {
              portfolio: "broker:ibkr-flex:DU12345",
              shares: 10,
              avgCost: 100,
              currency: "EUR",
              broker: "ibkr",
              brokerInstanceId: "ibkr-flex",
              brokerAccountId: "DU12345",
            },
          ],
        })}
        quote={makeQuote({
          price: 125,
          currency: "EUR",
          change: 5,
          changePercent: 4.17,
        })}
        exchangeRates={new Map([["USD", 1], ["EUR", 1.1]])}
      />,
      { width: 100, height: 24 },
    );

    await flushFrame();

    const frame = testSetup.captureCharFrame();
    expect(frame).toMatch(/AAPL\s+125\s+\+4\.17%/);
    expect(frame).toContain("100");
    expect(frame).toContain("1.4k");
    expect(frame).toContain("+275");
    expect(frame).not.toContain("€100.00");
    expect(frame).not.toContain("$137.50");
  });

  test("shows broker market value and pnl before snapshot warmup", async () => {
    const portfolioId = "broker:ibkr-flex:DU12345";
    const config = createPortfolioConfigWithColumns(
      portfolioId,
      ["ticker", "price", "mkt_value", "pnl", "pnl_pct"],
      [createBrokerInstance("flex")],
    );

    testSetup = await testRender(
      <PortfolioHarness
        config={config}
        collectionId={portfolioId}
        stateMutator={(state) => {
          state.tickers = new Map([["AAPL", makeTicker({
            portfolios: [portfolioId],
            positions: [{
              portfolio: portfolioId,
              shares: 10,
              avgCost: 100,
              currency: "USD",
              broker: "ibkr",
              brokerInstanceId: "ibkr-flex",
              brokerAccountId: "DU12345",
              markPrice: 125,
              marketValue: 1250,
              unrealizedPnl: 250,
            }],
          })]]);
          state.financials = new Map();
          state.paneState[TEST_PANE_ID] = {
            collectionId: portfolioId,
            cursorSymbol: "AAPL",
            cashDrawerExpanded: false,
          };
        }}
      />,
      { width: 100, height: 12 },
    );

    await flushFrame();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("1.3k");
    expect(frame).toContain("125");
    expect(frame).toContain("+250");
    expect(frame).toContain("25.00%");
  });

  test("renders portfolio grid from portfolio table values and opens the selected ticker", async () => {
    const portfolioId = "broker:ibkr-flex:DU12345";
    const config = createPortfolioConfig(portfolioId, [createBrokerInstance("flex")]);
    const instance = config.layout.instances.find((entry) => entry.instanceId === TEST_PANE_ID);
    if (instance) {
      instance.settings = {
        ...(instance.settings ?? {}),
        viewMode: "grid",
      };
    }
    const pinned: Array<{ symbol: string; options: { floating?: boolean; paneType?: string } | undefined }> = [];
    const runtime = createTestPluginRuntime({
      pinTicker: (symbol, options) => {
        pinned.push({ symbol, options });
      },
    });

    testSetup = await testRender(
      <PortfolioHarness
        config={config}
        collectionId={portfolioId}
        runtime={runtime}
      />,
      { width: 100, height: 12 },
    );

    await flushFrame();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("AAPL");
    expect(frame).toContain("1.3k");
    expect(frame).toContain("+4.17%");

    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await testSetup!.renderOnce();
    });

    expect(pinned).toEqual([{ symbol: "AAPL", options: { floating: true, paneType: TICKER_RESEARCH_PANE_ID } }]);
  });

  test("keeps watchlists in table view when grid is saved on the pane", async () => {
    const config = createManualCollectionConfig("watchlist");
    const instance = config.layout.instances.find((entry) => entry.instanceId === TEST_PANE_ID);
    if (instance) {
      instance.settings = {
        ...(instance.settings ?? {}),
        viewMode: "grid",
      };
    }

    testSetup = await testRender(
      <PortfolioHarness
        config={config}
        collectionId="watchlist"
        ticker={makeTicker({ portfolios: [], watchlists: ["watchlist"], positions: [] })}
      />,
      { width: 100, height: 12 },
    );

    await flushFrame();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("TICKER");
    expect(frame).toContain("AAPL");
  });

  test("keeps option avg cost on premium scale and multiplies quoted value by contract size", async () => {
    const portfolioId = "broker:ibkr-flex:DU12345";
    const optionTicker = "SPY  260619C00500000";
    const config = createPortfolioConfigWithColumns(
      portfolioId,
      ["ticker", "price", "avg_cost", "cost_basis", "mkt_value", "pnl"],
      [createBrokerInstance("flex")],
    );

    testSetup = await testRender(
      <PortfolioHarness
        config={config}
        collectionId={portfolioId}
        stateMutator={(state) => {
          state.tickers = new Map([[
            optionTicker,
            makeTicker({
              ticker: optionTicker,
              name: "SPY Jun19'26 500 Call",
              assetCategory: "OPT",
              portfolios: [portfolioId],
              positions: [{
                portfolio: portfolioId,
                shares: 2,
                avgCost: 4.25,
                currency: "USD",
                broker: "ibkr",
                brokerInstanceId: "ibkr-flex",
                brokerAccountId: "DU12345",
                multiplier: 100,
              }],
            }),
          ]]);
          state.financials = new Map([[
            optionTicker,
            {
              annualStatements: [],
              quarterlyStatements: [],
              priceHistory: [],
              quote: makeQuote({
                symbol: optionTicker,
                price: 5,
                change: 0.5,
                changePercent: 11.11,
                previousClose: 4.5,
                name: "SPY Jun19'26 500 Call",
              }),
            },
          ]]);
          state.paneState[TEST_PANE_ID] = {
            collectionId: portfolioId,
            cursorSymbol: optionTicker,
            cashDrawerExpanded: false,
          };
        }}
      />,
      { width: 100, height: 12 },
    );

    await flushFrame();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("4.25");
    expect(frame).toContain("5");
    expect(frame).toContain("850");
    expect(frame).toContain("1k");
    expect(frame).toContain("+150");
    expect(frame).not.toContain("$4.25");
  });

  test("shows flex cash summary and hides unavailable margin metrics", async () => {
    const config = createPortfolioConfig("broker:ibkr-flex:DU12345", [createBrokerInstance("flex")]);
    testSetup = await testRender(
      <PortfolioHarness
        config={config}
        collectionId="broker:ibkr-flex:DU12345"
        expanded
        brokerAccounts={{
          "ibkr-flex": [{
            accountId: "DU12345",
            name: "DU12345",
            currency: "USD",
            source: "flex",
            updatedAt: new Date(2026, 2, 27).getTime(),
            totalCashValue: -50000,
            settledCash: -45000,
            netLiquidation: 125000,
            cashBalances: [
              { currency: "USD", quantity: -50000, baseValue: -50000, baseCurrency: "USD" },
              { currency: "EUR", quantity: -351957.025, baseValue: -381000, baseCurrency: "USD" },
              { currency: "JPY", quantity: 0, baseValue: 0, baseCurrency: "USD" },
            ],
          }],
        }}
      />,
      { width: 100, height: 24 },
    );

    await flushFrame();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Cash");
    expect(frame).toContain("Cash & Margin");
    expect(frame).toContain("Net Liq");
    expect(frame).toContain("Flex Mar 27");
    expect(frame).toContain("-351,957.025");
    expect(frame).not.toContain("Avail");
    expect(frame).not.toContain("JPY");
  });

  test("renders bid ask and spread when those columns are enabled", async () => {
    const config = createPortfolioConfigWithColumns(
      "broker:ibkr-flex:DU12345",
      ["ticker", "bid", "ask", "spread", "latency"],
      [createBrokerInstance("flex")],
    );

    testSetup = await testRender(
      <PortfolioHarness config={config} collectionId="broker:ibkr-flex:DU12345" />,
      { width: 100, height: 12 },
    );

    await flushFrame();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("BID");
    expect(frame).toContain("ASK");
    expect(frame).toContain("SPREAD");
    expect(frame).toContain("124.95");
    expect(frame).toContain("125.05");
    expect(frame).toContain("0.1");
  });

  test("warms full financials for visible rows when only quote data is loaded", async () => {
    const config = createPortfolioConfigWithColumns(
      "broker:ibkr-flex:DU12345",
      ["ticker", "market_cap", "pe", "forward_pe"],
      [createBrokerInstance("flex")],
    );
    const seededTicker = makeTicker();
    const seededQuote = makeQuote();
    let calls = 0;
    let resolveFinancials!: (value: {
      annualStatements: [];
      quarterlyStatements: [];
      priceHistory: Array<{ date: Date; close: number }>;
      quote: Quote;
      fundamentals: { trailingPE: number; forwardPE: number };
    }) => void;
    const financialsPromise = new Promise<{
      annualStatements: [];
      quarterlyStatements: [];
      priceHistory: Array<{ date: Date; close: number }>;
      quote: Quote;
      fundamentals: { trailingPE: number; forwardPE: number };
    }>((resolve) => {
      resolveFinancials = resolve;
    });
    const provider: DataProvider = {
      id: "test-provider",
      name: "Test Provider",
      async getTickerFinancials(symbol) {
        calls += 1;
        return financialsPromise;
      },
      async getQuote() {
        return makeQuote();
      },
      async getExchangeRate() {
        return 1;
      },
      async search() {
        return [];
      },
      async getArticleSummary() {
        return null;
      },
      async getPriceHistory() {
        return [];
      },
      subscribeQuotes() {
        return () => {};
      },
    };
    sharedCoordinator = new MarketDataCoordinator(provider);
    const instrument = instrumentFromTicker(seededTicker, seededTicker.metadata.ticker);
    if (!instrument) throw new Error("expected ticker instrument");
    sharedCoordinator.primeCachedFinancials([{
      instrument,
      financials: {
        annualStatements: [],
        quarterlyStatements: [],
        priceHistory: [],
        quote: seededQuote,
      },
    }]);
    setSharedMarketDataCoordinator(sharedCoordinator);

    testSetup = await testRender(
      <PortfolioHarness
        config={config}
        collectionId="broker:ibkr-flex:DU12345"
        ticker={seededTicker}
        quote={seededQuote}
      />,
      { width: 100, height: 12 },
    );

    await flushFrame();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 380));
    });
    await act(async () => {
      resolveFinancials({
        annualStatements: [],
        quarterlyStatements: [],
        priceHistory: [{ date: new Date("2026-03-28T00:00:00Z"), close: 124 }],
        quote: makeQuote({
          symbol: "AAPL",
          marketCap: 2_000_000_000,
        }),
        fundamentals: {
          trailingPE: 25,
          forwardPE: 22,
        },
      });
      await Promise.resolve();
    });
    await flushFrame();

    const frame = testSetup.captureCharFrame();
    expect(calls).toBeGreaterThan(0);
    expect(frame).toContain("2B");
    expect(frame).toContain("25.0");
    expect(frame).toContain("22.0");
  });

  test("force-refreshes old visible quote data even when the pane is not focused", async () => {
    const config = createPortfolioConfigWithColumns(
      "broker:ibkr-flex:DU12345",
      ["ticker", "price", "day_pnl"],
      [createBrokerInstance("flex")],
    );
    const oldQuote = makeQuote({
      price: 120,
      change: -5,
      changePercent: -4,
      currency: "EUR",
      listingExchangeName: "FWB2",
      marketState: "REGULAR",
      lastUpdated: Date.now() - 5 * 60 * 1000,
    });
    const batchOptions: Array<{ forceRefresh?: boolean } | undefined> = [];
    const provider: DataProvider = {
      id: "test-provider",
      name: "Test Provider",
      async getTickerFinancials() {
        return {
          annualStatements: [],
          quarterlyStatements: [],
          priceHistory: [],
          quote: oldQuote,
        };
      },
      async getQuotesBatch(targets, options) {
        batchOptions.push(options);
        return targets.map((target) => ({
          target,
          quote: makeQuote({
            symbol: target.symbol,
            price: 126,
            change: 1,
            changePercent: 0.8,
            currency: "EUR",
            listingExchangeName: "FWB2",
            marketState: "REGULAR",
          }),
        }));
      },
      async getQuote(symbol) {
        return makeQuote({ symbol, price: 126 });
      },
      async getExchangeRate() {
        return 1;
      },
      async search() {
        return [];
      },
      async getArticleSummary() {
        return null;
      },
      async getPriceHistory() {
        return [];
      },
      subscribeQuotes() {
        return () => {};
      },
    };
    sharedCoordinator = new MarketDataCoordinator(provider);
    setSharedMarketDataCoordinator(sharedCoordinator);

    testSetup = await testRender(
      <PortfolioHarness
        config={config}
        collectionId="broker:ibkr-flex:DU12345"
        ticker={makeTicker({ exchange: "FWB2", currency: "EUR" })}
        quote={oldQuote}
        paneFocused={false}
        stateMutator={(state) => {
          state.focusedPaneId = "portfolio-list:other";
          state.paneState[TEST_PANE_ID] = {
            ...(state.paneState[TEST_PANE_ID] ?? {}),
            collectionSorts: {
              "broker:ibkr-flex:DU12345": { columnId: "ticker", direction: "asc" },
            },
          };
        }}
      />,
      { width: 100, height: 12 },
    );

    await flushFrame();
    await act(async () => {
      await Promise.resolve();
    });
    await flushFrame();

    expect(batchOptions.some((options) => options?.forceRefresh === true)).toBe(true);
    expect(testSetup.captureCharFrame()).toContain("126");
  });

  test("shows cached market cap on reopen for broker-linked rows", async () => {
    const dbPath = createTempDbPath("cached-reopen-market-cap");
    const persistence = new AppPersistence(dbPath);
    const instrument = {
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-live",
      symbol: "AAPL",
      localSymbol: "AAPL",
      exchange: "SMART",
      primaryExchange: "NASDAQ",
      conId: 265598,
    };
    const cloudProvider: DataProvider = {
      id: "cloud",
      name: "Cloud",
      priority: 100,
      async getTickerFinancials() {
        return {
          annualStatements: [],
          quarterlyStatements: [],
          priceHistory: [],
          quote: makeQuote({
            symbol: "AAPL",
            price: 125,
            marketCap: 2_000_000_000,
          }),
          fundamentals: {
            trailingPE: 25,
            forwardPE: 22,
          },
          profile: {
            sector: "Technology",
          },
        };
      },
      async getQuote() {
        return makeQuote({
          symbol: "AAPL",
          price: 125,
        });
      },
      async getExchangeRate() {
        return 1;
      },
      async search() {
        return [];
      },
      async getArticleSummary() {
        return null;
      },
      async getPriceHistory() {
        return [];
      },
    };
    const yahooProvider: DataProvider = {
      ...cloudProvider,
      id: "yahoo",
      name: "Yahoo",
      priority: 1000,
      async getTickerFinancials() {
        return {
          annualStatements: [],
          quarterlyStatements: [],
          priceHistory: [{ date: new Date("2026-03-28T00:00:00Z"), close: 124 }],
          quote: makeQuote({
            symbol: "AAPL",
            price: 124,
            marketCap: 2_000_000_000,
          }),
          fundamentals: {
            forwardPE: 22,
          },
          profile: {
            sector: "Technology",
          },
        };
      },
    };

    const seedRouter = new AssetDataRouter(yahooProvider, [cloudProvider], persistence.resources);
    await seedRouter.getTickerFinancials("AAPL", "NASDAQ", {
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-live",
      instrument,
    });

    let liveCalls = 0;
    const cachedRouter = new AssetDataRouter({
      ...yahooProvider,
      async getTickerFinancials() {
        liveCalls += 1;
        throw new Error("expected cached yahoo snapshot");
      },
    }, [{
      ...cloudProvider,
      async getTickerFinancials() {
        liveCalls += 1;
        throw new Error("expected cached cloud snapshot");
      },
    }], persistence.resources);
    sharedCoordinator = new MarketDataCoordinator(cachedRouter);
    setSharedMarketDataCoordinator(sharedCoordinator);
    const cachedFinancials = cachedRouter.getCachedFinancialsForTargets([{
      symbol: "AAPL",
      exchange: "NASDAQ",
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-live",
      instrument,
    }]);
    sharedCoordinator.primeCachedFinancials([{
      instrument: {
        symbol: "AAPL",
        exchange: "NASDAQ",
        brokerId: "ibkr",
        brokerInstanceId: "ibkr-live",
        instrument,
      },
      financials: cachedFinancials.get("AAPL")!,
    }]);

    const config = createPortfolioConfigWithColumns(
      "broker:ibkr-live:DU12345",
      ["ticker", "market_cap", "pe", "forward_pe"],
      [createBrokerInstance("gateway", "ibkr-live")],
    );

    testSetup = await testRender(
      <PortfolioHarness
        config={config}
        collectionId="broker:ibkr-live:DU12345"
        stateMutator={(state) => {
          state.tickers = new Map([["AAPL", makeTicker({
            portfolios: ["broker:ibkr-live:DU12345"],
            positions: [{
              portfolio: "broker:ibkr-live:DU12345",
              shares: 10,
              avgCost: 100,
              currency: "USD",
              broker: "ibkr",
              brokerInstanceId: "ibkr-live",
              brokerAccountId: "DU12345",
            }],
            broker_contracts: [instrument],
          })]]);
          state.financials = new Map();
          state.paneState[TEST_PANE_ID] = {
            collectionId: "broker:ibkr-live:DU12345",
            cursorSymbol: "AAPL",
            cashDrawerExpanded: false,
          };
        }}
      />,
      { width: 100, height: 12 },
    );

    await flushFrame();

    const frame = testSetup.captureCharFrame();
    expect(liveCalls).toBe(0);
    expect(frame).toContain("2B");
    expect(frame).toContain("25.0");
    expect(frame).toContain("22.0");

    persistence.close();
  });

  test("updates a non-selected broker-linked row from streamed quotes", async () => {
    const config = createPortfolioConfigWithColumns(
      "broker:ibkr-live:DU12345",
      ["ticker", "price", "change_pct", "latency"],
      [createBrokerInstance("gateway", "ibkr-live")],
    );
    let streamed: ((target: { symbol: string; exchange?: string; context?: unknown }, quote: Quote) => void) | null = null;
    const provider: DataProvider = {
      id: "test-provider",
      name: "Test Provider",
      async getTickerFinancials(symbol) {
        if (symbol === "AAPL") {
          return {
            annualStatements: [],
            quarterlyStatements: [],
            priceHistory: [],
            quote: makeQuote({
              symbol: "AAPL",
              price: 125,
              change: 5,
              changePercent: 4.17,
              marketState: "PRE",
              preMarketPrice: 125,
              preMarketChange: 5,
              preMarketChangePercent: 4.17,
            }),
          };
        }
        return {
          annualStatements: [],
          quarterlyStatements: [],
          priceHistory: [],
          quote: makeQuote({
            symbol: "MSFT",
            price: 315,
            change: 2,
            changePercent: 0.64,
            previousClose: 313,
            name: "Microsoft",
          }),
        };
      },
      async getQuote(symbol) {
        return symbol === "AAPL"
          ? makeQuote({
            symbol: "AAPL",
            price: 125,
            change: 5,
            changePercent: 4.17,
            marketState: "PRE",
            preMarketPrice: 125,
            preMarketChange: 5,
            preMarketChangePercent: 4.17,
          })
          : makeQuote({
            symbol: "MSFT",
            price: 315,
            change: 2,
            changePercent: 0.64,
            previousClose: 313,
            name: "Microsoft",
          });
      },
      async getExchangeRate() {
        return 1;
      },
      async search() {
        return [];
      },
      async getArticleSummary() {
        return null;
      },
      async getPriceHistory() {
        return [];
      },
      subscribeQuotes(_targets, onQuote) {
        streamed = onQuote as typeof streamed;
        return () => {};
      },
    };
    sharedCoordinator = new MarketDataCoordinator(provider);
    setSharedMarketDataCoordinator(sharedCoordinator);

    testSetup = await testRender(
      <PortfolioHarness
        config={config}
        collectionId="broker:ibkr-live:DU12345"
        stateMutator={(state) => {
          state.tickers = new Map([
            ["AAPL", makeTicker({
              ticker: "AAPL",
              name: "Apple",
              broker_contracts: [{
                brokerId: "ibkr",
                brokerInstanceId: "ibkr-live",
                symbol: "AAPL",
                localSymbol: "AAPL",
                exchange: "SMART",
                primaryExchange: "NASDAQ",
                conId: 265598,
              }],
            })],
            ["MSFT", makeTicker({
              ticker: "MSFT",
              name: "Microsoft",
              broker_contracts: [{
                brokerId: "ibkr",
                brokerInstanceId: "ibkr-live",
                symbol: "MSFT",
                localSymbol: "MSFT",
                exchange: "SMART",
                primaryExchange: "NASDAQ",
                conId: 272093,
              }],
            })],
          ]);
          state.financials = new Map();
          state.paneState[TEST_PANE_ID] = {
            collectionId: "broker:ibkr-live:DU12345",
            cursorSymbol: "MSFT",
            cashDrawerExpanded: false,
          };
        }}
      />,
      { width: 100, height: 12 },
    );

    await flushFrame();
    await act(async () => {
      await Promise.resolve();
    });
    await flushFrame();

    await act(async () => {
      streamed?.(
        {
          symbol: "AAPL",
          exchange: "NASDAQ",
          context: {
            brokerId: "ibkr",
            brokerInstanceId: "ibkr-live",
            instrument: {
              brokerId: "ibkr",
              brokerInstanceId: "ibkr-live",
              symbol: "AAPL",
              localSymbol: "AAPL",
              exchange: "SMART",
              primaryExchange: "NASDAQ",
              conId: 265598,
            },
          },
        },
        makeQuote({
          symbol: "AAPL",
          price: 126.5,
          change: 6.5,
          changePercent: 5.41,
          marketState: "PRE",
          preMarketPrice: 126.5,
          preMarketChange: 6.5,
          preMarketChangePercent: 5.41,
          lastUpdated: Date.now() + 1_000,
        }),
      );
      await Promise.resolve();
    });
    await flushFrame();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("AAPL");
    expect(frame).toContain("126.5");
    expect(frame).toContain("+5.41%");
  });

  test("streams portfolio rows with the active collection broker contract", async () => {
    const config = createPortfolioConfigWithColumns(
      "broker:ibkr-live:DU12345",
      ["ticker", "price", "change_pct", "latency"],
      [createBrokerInstance("gateway", "ibkr-flex"), createBrokerInstance("gateway", "ibkr-live")],
    );
    let subscribedTargets: Array<{ symbol: string; context?: { brokerInstanceId?: string; instrument?: unknown } }> = [];
    const provider: DataProvider = {
      id: "test-provider",
      name: "Test Provider",
      async getTickerFinancials(symbol) {
        return {
          annualStatements: [],
          quarterlyStatements: [],
          priceHistory: [],
          quote: makeQuote({ symbol }),
        };
      },
      async getQuote(symbol) {
        return makeQuote({ symbol });
      },
      async getExchangeRate() {
        return 1;
      },
      async search() {
        return [];
      },
      async getArticleSummary() {
        return null;
      },
      async getPriceHistory() {
        return [];
      },
      subscribeQuotes(targets) {
        subscribedTargets = targets;
        return () => {};
      },
    };
    sharedCoordinator = new MarketDataCoordinator(provider);
    setSharedMarketDataCoordinator(sharedCoordinator);

    const flexContract = {
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-flex",
      symbol: "VICR",
      localSymbol: "VICR",
      exchange: "NASDAQ",
      conId: 275759,
    };
    const liveContract = {
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-live",
      symbol: "VICR",
      localSymbol: "VICR",
      exchange: "NASDAQ",
      primaryExchange: "NASDAQ",
      conId: 275759,
    };

    testSetup = await testRender(
      <PortfolioHarness
        config={config}
        collectionId="broker:ibkr-live:DU12345"
        stateMutator={(state) => {
          state.tickers = new Map([["VICR", makeTicker({
            ticker: "VICR",
            name: "Vicor",
            portfolios: ["broker:ibkr-flex:DU12345", "broker:ibkr-live:DU12345"],
            positions: [
              {
                portfolio: "broker:ibkr-flex:DU12345",
                shares: 170,
                avgCost: 198,
                currency: "USD",
                broker: "ibkr",
                brokerInstanceId: "ibkr-flex",
                brokerAccountId: "DU12345",
                brokerContractId: 275759,
              },
              {
                portfolio: "broker:ibkr-live:DU12345",
                shares: 350,
                avgCost: 290,
                currency: "USD",
                broker: "ibkr",
                brokerInstanceId: "ibkr-live",
                brokerAccountId: "DU12345",
                brokerContractId: 275759,
              },
            ],
            broker_contracts: [flexContract, liveContract],
          })]]);
          state.financials = new Map();
          state.paneState[TEST_PANE_ID] = {
            collectionId: "broker:ibkr-live:DU12345",
            cursorSymbol: "VICR",
            cashDrawerExpanded: false,
          };
        }}
      />,
      { width: 100, height: 12 },
    );

    await flushFrame();
    await act(async () => {
      await Promise.resolve();
    });

    const vicrTarget = subscribedTargets.find((target) => target.symbol === "VICR");
    expect(vicrTarget?.context?.brokerInstanceId).toBe("ibkr-live");
    expect(vicrTarget?.context?.instrument).toEqual(liveContract);
  });

  test("warms hidden quote-missing rows when sorting by change percent", async () => {
    const { beforeFrame, frame, requestedSnapshots } = await renderHiddenChangePctSortWarmup();
    expect(beforeFrame).not.toContain("SIVE");
    expect(requestedSnapshots).toContain("SIVE");
    expect(frame).toContain("SIVE");
    expect(frame).toContain("-17.05%");
    expect(frame).toContain("46.7");
  });

  test("force-refreshes hidden stale cached snapshots when sorting by change percent", async () => {
    const { beforeFrame, frame, requestedSnapshots } = await renderHiddenChangePctSortWarmup({
      staleCachedSiveSnapshot: true,
    });
    expect(beforeFrame).not.toContain("SIVE");
    expect(requestedSnapshots).toContain("SIVE");
    expect(frame).toContain("SIVE");
    expect(frame).toContain("-17.05%");
    expect(frame).toContain("46.7");
  });

});
