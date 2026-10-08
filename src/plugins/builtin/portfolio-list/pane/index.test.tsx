import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, useReducer } from "react";
import { Box } from "../../../../ui";
import { PaneFooterProvider, PaneFooterBar, PaneFooterKeys } from "../../../../components/layout/pane/footer";
import type { ReactElement } from "react";
import { createOpenTuiTestHarness } from "../../../../renderers/opentui/test-utils";
import { AppPersistence } from "../../../../data/app-persistence";
import { TickerRepository } from "../../../../data/ticker-repository";
import { appReducer, createInitialState, type AppAction } from "../../../../state/app/context";
import { AssetDataRouter } from "../../../../sources/provider-router";
import {
  createDefaultConfig,
  TICKER_RESEARCH_PANE_ID,
  type AppConfig,
  type BrokerInstanceConfig,
} from "../../../../types/config";
import type { DataProvider } from "../../../../types/data-provider";
import type { Quote, TickerFinancials } from "../../../../types/financials";
import type { TickerRecord } from "../../../../types/ticker";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../../market-data/coordinator";
import { instrumentFromTicker } from "../../../../market-data/request-types";
import { createTestPluginRuntime } from "../../../../test-support/plugin-runtime";
import { createTestDataProvider, createTestFinancials, createTestQuote } from "../../../../test-support/data-provider";
import type { PluginRuntimeAccess } from "../../../runtime";
import { PluginRegistry, setSharedMarketDataForTests, setSharedRegistryForTests } from "../../../registry";
import { portfolioListModule } from "..";
import { TestPaneProvider, createTestTicker, createTestPaneConfig } from "../../../../test-support/pane";
import { AGE_CLOCK_MS } from "../use-column-clock";
import { createTempDbPath, removeTempDbFiles } from "../../../../test-support/temp-db";

const TEST_PANE_ID = "portfolio-list:test";

const tui = createOpenTuiTestHarness();
let harnessDispatch: React.Dispatch<AppAction> | null = null;
let sharedCoordinator: MarketDataCoordinator | null = null;
let harnessState: ReturnType<typeof createInitialState> | null = null;
let quoteClock: ReturnType<typeof spyOn> | undefined;
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

function makeTicker(overrides: Partial<TickerRecord["metadata"]> = {}): TickerRecord {
  return createTestTicker("AAPL", "Apple", {
    portfolios: ["broker:ibkr-flex:DU12345", "broker:ibkr-live:DU12345"],
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
    ...overrides
  });
}

function makeQuote(overrides: Partial<Quote> = {}): Quote {
  return createTestQuote({
    price: 125, bid: 124.95, ask: 125.05, bidSize: 100, askSize: 200, change: 5, changePercent: 4.17,
    previousClose: 120, name: "Apple", marketState: "REGULAR", ...overrides,
  });
}

function createPortfolioConfig(portfolioId: string, brokerInstances: BrokerInstanceConfig[] = []): AppConfig {
  const config = createTestPaneConfig("/tmp/gloomberb-portfolio-list", {
    instanceId: TEST_PANE_ID,
    paneId: "portfolio-list",
    binding: { kind: "none" },
    params: { collectionId: portfolioId },
  });

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
  return createTestPaneConfig("/tmp/gloomberb-portfolio-list", {
    instanceId: TEST_PANE_ID,
    paneId: "portfolio-list",
    binding: { kind: "none" },
    params: { collectionId },
  });
}

function installQuickAddRegistry(provider: DataProvider): PluginRegistry {
  const persistence = new AppPersistence(createTempDbPath("quick-add"));
  tempPersistences.push(persistence);
  const registry = new PluginRegistry(provider, new TickerRepository(persistence.tickers), persistence);
  registry.bindHost({ getConfig: () => harnessState?.config ?? createDefaultConfig("/tmp/gloomberb-portfolio-list") });
  return registry;
}

function createQuickAddProvider(match = true): DataProvider {
  return createTestDataProvider({
    id: "quick-add-test",
    name: "Quick Add Test",
    async getTickerFinancials() {
      return createTestFinancials({
        quote: makeQuote({ symbol: "MSFT", price: 420, change: 5.2, changePercent: 1.25, name: "Microsoft" }),
      });
    },
    async getQuote(symbol) {
      if (match && symbol === "MSFT") {
        return makeQuote({ symbol: "MSFT", price: 420, change: 5.2, changePercent: 1.25, name: "Microsoft" });
      }
      throw new Error(`No quote for ${symbol}`);
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
  });
}

function createPortfolioState(
  config: AppConfig,
  collectionId: string,
  expanded = false,
  {
    ticker = makeTicker(),
    quote = makeQuote(),
  }: {
    ticker?: TickerRecord;
    quote?: Quote;
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
  state.financials = new Map([["AAPL", createTestFinancials({ quote })]]);
  return state;
}

function PortfolioHarness({
  config,
  collectionId,
  expanded = false,
  brokerAccounts = {},
  ticker,
  quote,
  stateMutator,
  runtime = createTestPluginRuntime(),
  paneHeight = 24,
  paneWidth = 100,
  paneFocused = true,
}: {
  config: AppConfig;
  collectionId: string;
  expanded?: boolean;
  brokerAccounts?: ReturnType<typeof createInitialState>["brokerAccounts"];
  ticker?: TickerRecord;
  quote?: Quote;
  stateMutator?: (state: ReturnType<typeof createInitialState>) => void;
  runtime?: PluginRuntimeAccess;
  paneHeight?: number;
  paneWidth?: number;
  paneFocused?: boolean;
}) {
  const initialState = createPortfolioState(config, collectionId, expanded, {
    ticker,
    quote,
  });
  initialState.brokerAccounts = brokerAccounts;
  stateMutator?.(initialState);
  const [state, dispatch] = useReducer(appReducer, initialState);
  harnessDispatch = dispatch;
  harnessState = state;

  return (
    <TestPaneProvider state={state} dispatch={dispatch} paneId={TEST_PANE_ID} pluginId="portfolio" runtime={runtime}>
      <PortfolioPane
        paneId={TEST_PANE_ID}
        paneType="portfolio-list"
        focused={paneFocused}
        width={paneWidth}
        height={paneHeight}
      />
    </TestPaneProvider>
  );
}

async function flushFrame() {
  await act(async () => {
    await Promise.resolve();
    await tui.setup().renderOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    await tui.setup().renderOnce();
  });
}

// Answers for the fixture rows repeat what their cache was primed with, so a
// snapshot the pane warms for a row near the cursor cannot reorder the list;
// only SIVE, the row under test, has a quote the cache lacks.
function makeSortWarmupQuote(symbol: string): Quote {
  if (symbol === "SIVE") {
    return makeQuote({
      symbol,
      price: 46.7,
      change: -9.6,
      changePercent: -17.05,
      previousClose: 56.3,
      listingExchangeName: "NASDAQ",
    });
  }
  const index = Number(symbol.replace(/^T/, ""));
  return makeQuote({
    symbol,
    price: 100 + index,
    change: index,
    changePercent: index,
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
  // Sorting fixtures have regular-session prices; keep them usable regardless
  // of the wall-clock session so only the hidden row needs a refresh.
  quoteClock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-14T18:00:00Z"));
  const portfolioId = "broker:ibkr-live:DU12345";
  const config = createPortfolioConfigWithColumns(
    portfolioId,
    ["ticker", "price", "change_pct", "latency"],
    [createBrokerInstance("gateway", "ibkr-live")],
  );
  const requestedSnapshots: string[] = [];
  const provider: DataProvider = createTestDataProvider({
    async getTickerFinancials(symbol) {
      requestedSnapshots.push(symbol);
      return createTestFinancials({ quote: makeSortWarmupQuote(symbol) });
    },
    async getQuote(symbol) {
      return makeSortWarmupQuote(symbol);
    },
    subscribeQuotes() {
      return () => {};
    },
  });
  sharedCoordinator = new MarketDataCoordinator(provider);
  setSharedMarketDataCoordinator(sharedCoordinator);

  const tickers = Array.from({ length: 29 }, (_, index) => makeSortWarmupBrokerTicker(portfolioId, `T${String(index).padStart(2, "0")}`, index));
  sharedCoordinator.primeCachedFinancials(tickers.map((ticker, index) => ({
    instrument: instrumentFromTicker(ticker, ticker.metadata.ticker, { portfolioId })!,
    financials: createTestFinancials({
      quote: makeQuote({ symbol: ticker.metadata.ticker, price: 100 + index, change: index, changePercent: index, listingExchangeName: "NASDAQ" }),
    }),
  })));
  const sive = makeSortWarmupBrokerTicker(portfolioId, "SIVE", 29);
  if (options.staleCachedSiveSnapshot) {
    const siveInstrument = instrumentFromTicker(sive, "SIVE", { portfolioId });
    if (!siveInstrument) throw new Error("expected SIVE instrument");
    sharedCoordinator.primeCachedFinancials([{
      instrument: siveInstrument,
      financials: createTestFinancials({
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
      }),
    }]);
  }

  await tui.render(
    <PortfolioHarness
      config={config}
      collectionId={portfolioId}
      stateMutator={(state) => {
        state.tickers = new Map([...tickers, sive].map((entry) => [entry.metadata.ticker, entry]));
        state.financials = new Map(tickers.map((entry, index) => [
          entry.metadata.ticker,
          createTestFinancials({
            quote: makeQuote({
              symbol: entry.metadata.ticker,
              price: 100 + index,
              change: index,
              changePercent: index,
              listingExchangeName: "NASDAQ",
            }),
          }),
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
  const beforeFrame = tui.frame();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
  await flushFrame();

  return { beforeFrame, frame: tui.frame(), requestedSnapshots };
}

afterEach(() => {
  harnessDispatch = null;
  sharedCoordinator = null;
  setSharedMarketDataCoordinator(null);
  setSharedMarketDataForTests(undefined);
  setSharedRegistryForTests(undefined);
  harnessState = null;
  for (const persistence of tempPersistences.splice(0)) {
    persistence.close();
  }
  removeTempDbFiles();
  quoteClock?.mockRestore();
  quoteClock = undefined;
});

describe("PortfolioListPane cash and margin UI", () => {
  for (const source of ["unknown currency", "CAD", "missing cash"] as const) {
    test(`cash drawer and footer preserve account units and missing values (${source})`, async () => {
      const portfolioId = "broker:ibkr-flex:DU12345";
      const requested: string[] = [];
      sharedCoordinator = new MarketDataCoordinator(createTestDataProvider({
        getExchangeRate: async (currency) => { requested.push(currency); return 0.75; },
      }));
      setSharedMarketDataCoordinator(sharedCoordinator);
      const config = createPortfolioConfig(portfolioId, [createBrokerInstance("flex")]);
      config.baseCurrency = "USD";
      await act(async () => {
        await tui.render(<PaneFooterProvider>{(footer) => <Box flexDirection="column">
          <PortfolioHarness config={config} collectionId={portfolioId} paneHeight={23}
            paneWidth={160} brokerAccounts={{ "ibkr-flex": [{
              accountId: "DU12345", name: "Fixture", source: "flex",
              currency: source === "unknown currency" ? undefined : "CAD",
              netLiquidation: 20000, totalCashValue: source === "missing cash" ? undefined : 18000,
            }] }} />
          <PaneFooterBar footer={footer} focused width={160} />
        </Box>}</PaneFooterProvider>, { width: 160, height: 24 });
      });
      for (let index = 0; index < 6; index++) await flushFrame();
      const frame = tui.frame();
      expect(frame).toContain(source === "unknown currency" ? "Net Liq —" : "Net Liq 15.0k");
      expect(frame).toContain(source === "CAD" ? "Cash 13.5k" : "Cash —");
      expect(frame).not.toContain("Cash 0");
      if (source !== "unknown currency") expect(requested).toContain("CAD");
      else expect(frame).toContain("⚠");
    });
  }

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

    await tui.render(
      <PortfolioHarness config={config} collectionId={portfolioId} runtime={runtime} />,
      { width: 100, height: 24 },
    );

    await flushFrame();
    const rowY = tui.frame().split("\n").findIndex((line) => line.includes("AAPL"));
    expect(rowY).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await tui.setup().mockMouse.click(2, rowY);
      await tui.setup().renderOnce();
    });
    expect(pinned).toEqual([]);

    await act(async () => {
      await tui.setup().mockMouse.click(2, rowY);
      await tui.setup().renderOnce();
    });
    expect(pinned).toEqual([{ symbol: "AAPL", options: { floating: true, paneType: TICKER_RESEARCH_PANE_ID } }]);
  });

  test("quick-add validates and adds an exact watchlist ticker", async () => {
    const config = createManualCollectionConfig("watchlist");
    const notifications: Array<{ type?: string; body: string }> = [];
    installQuickAddRegistry(createQuickAddProvider(true));

    await tui.render(
      <PortfolioHarness
        config={config}
        collectionId="watchlist"
        ticker={makeTicker({ portfolios: [], watchlists: [], positions: [] })}
        runtime={createTestPluginRuntime({
          notify: (notification) => { notifications.push(notification); },
        })}
        paneHeight={12}
      />,
      { width: 100, height: 12 },
    );

    await flushFrame();
    await act(async () => {
      tui.setup().mockInput.pressKey("a");
      await tui.setup().renderOnce();
    });
    await act(async () => {
      await tui.setup().mockInput.typeText("MSFT");
      await tui.setup().renderOnce();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 360));
    });
    await flushFrame();

    const previewFrame = tui.frame();
    expect(previewFrame).toContain("420");
    expect(previewFrame).not.toMatch(/MSFT\s+420/);
    expect(previewFrame).toContain("+1.25%");

    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await Promise.resolve();
      await tui.setup().renderOnce();
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

    await tui.render(
      <PortfolioHarness
        config={config}
        collectionId="main"
        ticker={makeTicker({ portfolios: [], watchlists: [], positions: [] })}
        runtime={createTestPluginRuntime({
          notify: (notification) => { notifications.push(notification); },
        })}
        paneHeight={12}
      />,
      { width: 100, height: 12 },
    );

    await flushFrame();
    await act(async () => {
      tui.setup().mockInput.pressKey("n");
      await tui.setup().renderOnce();
    });
    await act(async () => {
      await tui.setup().mockInput.typeText("MSFT");
      await tui.setup().renderOnce();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 360));
    });
    await flushFrame();

    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await Promise.resolve();
      await tui.setup().renderOnce();
    });
    await flushFrame();

    expect(harnessState?.tickers.get("MSFT")?.metadata.portfolios).toEqual(["main"]);
    expect(notifications.at(-1)).toMatchObject({
      type: "success",
      body: "Added MSFT to Main Portfolio.",
    });
  });

  async function renderRemovable(
    config: AppConfig,
    collectionId: string,
    tickers: TickerRecord[],
    cursorSymbol = tickers[0]!.metadata.ticker,
  ) {
    const notifications: Array<{ type?: string; body: string }> = [];
    installQuickAddRegistry(createQuickAddProvider(true));
    await tui.render(<PaneFooterProvider>{(footer) => <Box flexDirection="column">
      <PortfolioHarness
        config={config}
        collectionId={collectionId}
        stateMutator={(state) => {
          state.tickers = new Map(tickers.map((ticker) => [ticker.metadata.ticker, ticker]));
          state.paneState[TEST_PANE_ID] = { ...state.paneState[TEST_PANE_ID], cursorSymbol };
        }}
        runtime={createTestPluginRuntime({
          notify: (notification) => { notifications.push(notification); },
        })}
        paneHeight={11}
      />
      <PaneFooterBar footer={footer} focused width={100} />
      <PaneFooterKeys paneId={TEST_PANE_ID} footer={footer} focused />
    </Box>}</PaneFooterProvider>, { width: 100, height: 24 });
    await flushFrame();
    return notifications;
  }

  async function press(key: "d" | "y" | "escape") {
    await act(async () => {
      if (key === "escape") tui.setup().mockInput.pressEscape();
      else tui.setup().mockInput.pressKey(key);
      await Promise.resolve();
      await tui.setup().renderOnce();
    });
    await flushFrame();
  }

  test("d asks before taking the selected ticker off a watchlist, then moves to the next row", async () => {
    const position = { portfolio: "main", shares: 2, avgCost: 40, currency: "USD", broker: "manual" as const };
    const watched = (symbol: string, overrides: Partial<TickerRecord["metadata"]> = {}) => makeTicker({
      ticker: symbol, name: symbol, portfolios: [], positions: [], watchlists: ["watchlist"], ...overrides,
    });
    const notifications = await renderRemovable(createManualCollectionConfig("watchlist"), "watchlist", [
      watched("AAPL"),
      watched("MSFT", { watchlists: ["watchlist", "team:t1:w1"], portfolios: ["main"], positions: [position] }),
      watched("NVDA"),
    ], "MSFT");
    expect(tui.frame()).toContain("[d]elete");

    await press("d");
    expect(tui.frame()).toContain("Remove MSFT from Watchlist?");
    await press("escape");
    await tui.waitForFrameToExclude("Remove MSFT from Watchlist?");
    expect(harnessState?.tickers.get("MSFT")?.metadata.watchlists).toEqual(["watchlist", "team:t1:w1"]);

    await press("d");
    await press("y");
    const ticker = harnessState?.tickers.get("MSFT");
    expect(ticker?.metadata.watchlists).toEqual(["team:t1:w1"]);
    expect(ticker?.metadata.positions).toEqual([position]);
    expect(harnessState?.paneState[TEST_PANE_ID]?.cursorSymbol).toBe("NVDA");
    expect(notifications.at(-1)).toMatchObject({ type: "success", body: "Removed MSFT from Watchlist." });
  });

  test("d on a manual portfolio says the position goes with the ticker", async () => {
    const kept = { portfolio: "other", shares: 1, avgCost: 10, currency: "USD", broker: "manual" as const };
    await renderRemovable(createManualCollectionConfig("main"), "main", [makeTicker({
      portfolios: ["main", "other"],
      watchlists: ["watchlist"],
      positions: [{ portfolio: "main", shares: 4, avgCost: 100, currency: "USD", broker: "manual" }, kept],
    })]);

    await press("d");
    expect(tui.frame()).toContain("Its position here, 4 at 100");
    await press("y");
    const ticker = harnessState?.tickers.get("AAPL");
    expect(ticker?.metadata.portfolios).toEqual(["other"]);
    expect(ticker?.metadata.positions).toEqual([kept]);
    expect(ticker?.metadata.watchlists).toEqual(["watchlist"]);
  });

  const teamConfig = createManualCollectionConfig("team:t1:w1");
  teamConfig.watchlists = [{ id: "team:t1:w1", name: "Desk", teamId: "t1" }];
  for (const [name, collectionId, config] of [
    ["a broker portfolio", "broker:ibkr-flex:DU12345", createPortfolioConfig("broker:ibkr-flex:DU12345", [createBrokerInstance("flex")])],
    ["a team watchlist", "team:t1:w1", teamConfig],
  ] satisfies Array<[string, string, AppConfig]>) {
    test(`${name} offers no delete`, async () => {
      const ticker = makeTicker({ watchlists: ["team:t1:w1"] });
      const notifications = await renderRemovable(config, collectionId, [ticker]);
      expect(tui.frame()).toContain("AAPL");
      expect(tui.frame()).not.toContain("[d]elete");

      await press("d");
      expect(tui.frame()).not.toContain("Remove AAPL");
      expect(harnessState?.tickers.get("AAPL")).toBe(ticker);
      expect(notifications).toEqual([]);
    });
  }

  test("quick-add rejects unresolved ticker input", async () => {
    const config = createManualCollectionConfig("watchlist");
    const notifications: Array<{ type?: string; body: string }> = [];
    installQuickAddRegistry(createQuickAddProvider(false));

    await tui.render(
      <PortfolioHarness
        config={config}
        collectionId="watchlist"
        ticker={makeTicker({ portfolios: [], watchlists: [], positions: [] })}
        runtime={createTestPluginRuntime({
          notify: (notification) => { notifications.push(notification); },
        })}
        paneHeight={12}
      />,
      { width: 100, height: 12 },
    );

    await flushFrame();
    await act(async () => {
      tui.setup().mockInput.pressKey("n");
      await tui.setup().renderOnce();
    });
    await act(async () => {
      await tui.setup().mockInput.typeText("NOPE");
      await tui.setup().renderOnce();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 360));
    });
    await flushFrame();

    expect(tui.frame()).toContain("No exact ticker match");

    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await Promise.resolve();
      await tui.setup().renderOnce();
    });
    await flushFrame();

    expect(harnessState?.tickers.has("NOPE")).toBe(false);
    expect(notifications.at(-1)).toMatchObject({
      type: "error",
      body: "No exact ticker match",
    });
  });

  test("quick-add shows the saved listing's venue, and a colon opens that symbol's venues in the command bar", async () => {
    const config = createManualCollectionConfig("watchlist");
    const nyse = { providerId: "quick-add-test", symbol: "NET", name: "Cloudflare", exchange: "NYSE", currency: "USD", type: "STK" };
    const lse = { providerId: "quick-add-test", symbol: "NET", name: "Netcall Plc", exchange: "LSE", currency: "GBP", type: "STK" };
    installQuickAddRegistry(createTestDataProvider({
      id: "quick-add-test",
      name: "Quick Add Test",
      async search() { return [nyse, lse]; },
    }));

    await tui.render(
      <PortfolioHarness
        config={config}
        collectionId="watchlist"
        stateMutator={(state) => {
          const net = createTestTicker("NET", "Netcall Plc", {
            exchange: "LSE", currency: "GBP", portfolios: [], watchlists: [], positions: [],
          });
          state.tickers = new Map([["NET", net]]);
          state.financials = new Map([["NET", createTestFinancials({
            quote: makeQuote({ symbol: "NET", price: 1.26, changePercent: 0.4, currency: "GBP", name: "Netcall Plc" }),
          })]]);
        }}
        paneHeight={16}
      />,
      { width: 100, height: 16 },
    );

    await flushFrame();
    await act(async () => {
      tui.setup().mockInput.pressKey("a");
      await tui.setup().renderOnce();
    });
    await act(async () => {
      await tui.setup().mockInput.typeText("NET");
      await tui.setup().renderOnce();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 360));
    });
    await flushFrame();

    const bare = tui.frame();
    expect(bare).toContain("Netcall Plc");
    expect(bare).toContain("LSE");

    await act(async () => {
      await tui.setup().mockInput.typeText(":");
      await tui.setup().renderOnce();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 360));
    });
    await flushFrame();

    expect(harnessState?.commandBarOpen).toBe(true);
    expect(harnessState?.commandBarQuery).toBe("NET:");
    expect(harnessState?.commandBarLaunchRequest).toMatchObject({
      kind: "add-listing",
      collectionId: "watchlist",
      collectionKind: "watchlist",
    });
    expect(tui.frame()).not.toContain("Use a ticker symbol");
  });

  test("renders one-month sparkline column when price history is loaded", async () => {
    const config = createPortfolioConfigWithColumns(
      "broker:ibkr-flex:DU12345",
      ["ticker", "price", "sparkline"],
      [createBrokerInstance("flex")],
    );

    await tui.render(
      <PortfolioHarness
        config={config}
        collectionId="broker:ibkr-flex:DU12345"
        stateMutator={(state) => {
          state.financials = new Map([[
            "AAPL",
            createTestFinancials({
              quote: makeQuote(),
              priceHistory: [118, 121, 119, 124, 127, 126, 130].map((close, index) => ({
                date: `2026-03-${20 + index}T00:00:00Z` as unknown as Date,
                close,
              })),
            }),
          ]]);
        }}
      />,
      { width: 100, height: 12 },
    );

    await flushFrame();

    const frame = tui.frame();
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
    sharedCoordinator = new MarketDataCoordinator(createTestDataProvider({
      getExchangeRate: async (currency) => (currency === "EUR" ? 1.1 : 1),
    }));
    setSharedMarketDataCoordinator(sharedCoordinator);

    await tui.render(
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
      />,
      { width: 100, height: 24 },
    );

    await flushFrame();

    // The EUR rate arrives from the market data coordinator a frame later.
    const frame = await tui.waitForFrameToContain("1.4k");
    expect(frame).toMatch(/AAPL\s+125\.00\s+\+4\.17%/);
    expect(frame).toContain("100");
    expect(frame).toContain("+275");
    expect(frame).not.toContain("€100.00");
    expect(frame).not.toContain("$137.50");
  });

  for (const width of [80, 120]) {
    test(`keeps unknown imported cost and broker profit distinct until cost recovery at ${width} columns`, async () => {
      const portfolioId = "cost-review";
      const config = createPortfolioConfigWithColumns(portfolioId, ["ticker", "avg_cost", "mkt_value", "pnl", "pnl_pct"]);
      const imported = makeTicker({ portfolios: [portfolioId], positions: [{
        portfolio: portfolioId, shares: 10, currency: "USD", broker: "demo", unrealizedPnl: 200,
      }] });
      await tui.render(<PaneFooterProvider>{footer => <Box flexDirection="column">
        <PortfolioHarness config={config} collectionId={portfolioId}
          ticker={imported} quote={makeQuote({ price: 120 })} paneWidth={width} paneHeight={15} />
        <PaneFooterBar footer={footer} focused width={width} />
      </Box>}</PaneFooterProvider>, { width, height: 16 });
      await flushFrame();
      const before = tui.frame();
      expect(before).toContain("⚠");
      expect(before).toMatch(/AAPL\s+—\s+1\.2k\s+\+200\.00\s+—/);
      expect(before).not.toContain("NaN");
      const corrected = { ...imported, metadata: { ...imported.metadata,
        positions: [{ ...imported.metadata.positions[0]!, avgCost: 100 }],
      } };
      await act(async () => { harnessDispatch!({ type: "UPDATE_TICKER", ticker: corrected }); });
      await flushFrame();
      const after = tui.frame();
      expect(after).not.toContain("⚠");
      expect(after).toMatch(/AAPL\s+100\s+1\.2k\s+\+200\.00\s+\+20\.00%/);
    });
  }

  test("shows broker market value and pnl before snapshot warmup", async () => {
    const portfolioId = "broker:ibkr-flex:DU12345";
    const config = createPortfolioConfigWithColumns(
      portfolioId,
      ["ticker", "price", "mkt_value", "pnl", "pnl_pct"],
      [createBrokerInstance("flex")],
    );

    await tui.render(
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

    const frame = tui.frame();
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

    await tui.render(
      <PortfolioHarness
        config={config}
        collectionId={portfolioId}
        runtime={runtime}
      />,
      { width: 100, height: 12 },
    );

    await flushFrame();

    const frame = tui.frame();
    expect(frame).toContain("AAPL");
    expect(frame).toContain("1.3k");
    expect(frame).toContain("+4.17%");

    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await tui.setup().renderOnce();
    });

    expect(pinned).toEqual([{ symbol: "AAPL", options: { floating: true, paneType: TICKER_RESEARCH_PANE_ID } }]);
  });

  test("keeps the grid's arrows on its tiles and leaves h and l to the collection tabs", async () => {
    const portfolioId = "broker:ibkr-flex:DU12345";
    const config = createPortfolioConfig(portfolioId, [createBrokerInstance("flex")]);
    const instance = config.layout.instances.find((entry) => entry.instanceId === TEST_PANE_ID);
    if (instance) instance.settings = { ...(instance.settings ?? {}), viewMode: "grid" };
    await tui.render(<PortfolioHarness config={config} collectionId={portfolioId} />, { width: 100, height: 12 });
    await flushFrame();
    const collection = () => harnessState?.paneState[TEST_PANE_ID]?.collectionId;
    expect(collection()).toBe(portfolioId);

    // The tabs mount first and would take left and right for themselves.
    await act(async () => {
      tui.setup().mockInput.pressArrow("right");
      await tui.setup().renderOnce();
    });
    expect(collection()).toBe(portfolioId);

    await act(async () => {
      tui.setup().mockInput.pressKey("l");
      await tui.setup().renderOnce();
    });
    expect(collection()).not.toBe(portfolioId);
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

    await tui.render(
      <PortfolioHarness
        config={config}
        collectionId="watchlist"
        ticker={makeTicker({ portfolios: [], watchlists: ["watchlist"], positions: [] })}
      />,
      { width: 100, height: 12 },
    );

    await flushFrame();

    const frame = tui.frame();
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

    await tui.render(
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
            createTestFinancials({
              quote: makeQuote({
                symbol: optionTicker,
                price: 5,
                change: 0.5,
                changePercent: 11.11,
                previousClose: 4.5,
                name: "SPY Jun19'26 500 Call",
              }),
            }),
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

    const frame = tui.frame();
    expect(frame).toContain("4.25");
    expect(frame).toContain("5");
    expect(frame).toContain("850");
    expect(frame).toContain("1.0k");
    expect(frame).toContain("+150.00");
    expect(frame).not.toContain("$4.25");
  });

  test("shows flex cash summary once and hides unavailable margin metrics", async () => {
    const config = createPortfolioConfig("broker:ibkr-flex:DU12345", [createBrokerInstance("flex")]);
    await tui.render(<PaneFooterProvider>{(footer) => <Box flexDirection="column">
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
        paneHeight={23}
      />
      <PaneFooterBar footer={footer} focused width={100} />
    </Box>}</PaneFooterProvider>, { width: 100, height: 24 });

    await flushFrame();

    const frame = tui.frame();
    expect(frame).toContain("Cash & Margin");
    expect(frame.match(/Cash -50.0k/g)).toHaveLength(1);
    expect(frame.match(/Net Liq 125.0k/g)).toHaveLength(1);
    expect(frame).toContain("Flex Mar 27");
    expect(frame).toContain("-351,957.025");
    expect(frame).not.toContain("Avail");
    expect(frame).not.toContain("JPY");
  });

  test("ages quotes on a once-a-second clock while AGE is shown", async () => {
    let clock = Date.parse("2026-09-14T18:00:00Z");
    quoteClock = spyOn(Date, "now").mockImplementation(() => clock);
    const config = createPortfolioConfigWithColumns(
      "broker:ibkr-flex:DU12345",
      ["ticker", "price", "latency"],
      [createBrokerInstance("flex")],
    );

    await tui.render(
      <PortfolioHarness
        config={config}
        collectionId="broker:ibkr-flex:DU12345"
        quote={makeQuote({ lastUpdated: clock - 3_000, receivedAt: clock - 2_000 })}
      />,
      { width: 60, height: 8 },
    );
    await flushFrame();
    expect(tui.frame()).toMatch(/AAPL\s+125\.00\s+2s/);

    // A quote received since the clock last ticked reads its true age on the next tick.
    clock += 5_000;
    await act(async () => {
      await Bun.sleep(AGE_CLOCK_MS + 50);
    });
    await flushFrame();
    expect(tui.frame()).toMatch(/AAPL\s+125\.00\s+7s/);
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
    const { promise: financialsPromise, resolve: resolveFinancials } = Promise.withResolvers<TickerFinancials>();
    const provider: DataProvider = createTestDataProvider({
      async getTickerFinancials(symbol) {
        calls += 1;
        return financialsPromise;
      },
      async getQuote() {
        return makeQuote();
      },
      subscribeQuotes() {
        return () => {};
      },
    });
    sharedCoordinator = new MarketDataCoordinator(provider);
    const instrument = instrumentFromTicker(seededTicker, seededTicker.metadata.ticker);
    if (!instrument) throw new Error("expected ticker instrument");
    sharedCoordinator.primeCachedFinancials([{
      instrument,
      financials: createTestFinancials({ quote: seededQuote }),
    }]);
    setSharedMarketDataCoordinator(sharedCoordinator);

    await tui.render(
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
      resolveFinancials(createTestFinancials({
        priceHistory: [{ date: new Date("2026-03-28T00:00:00Z"), close: 124 }],
        quote: makeQuote({
          symbol: "AAPL",
          marketCap: 2_000_000_000,
        }),
        fundamentals: {
          trailingPE: 25,
          forwardPE: 22,
        },
      }));
      await Promise.resolve();
    });
    await flushFrame();

    const frame = tui.frame();
    expect(calls).toBeGreaterThan(0);
    expect(frame).toContain("2.00B");
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
    const provider: DataProvider = createTestDataProvider({
      async getTickerFinancials() {
        return createTestFinancials({ quote: oldQuote });
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
      subscribeQuotes() {
        return () => {};
      },
    });
    sharedCoordinator = new MarketDataCoordinator(provider);
    setSharedMarketDataCoordinator(sharedCoordinator);

    await tui.render(
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
    expect(tui.frame()).toContain("126");
  });

  test("shows cached market cap on reopen for broker-linked rows", async () => {
    quoteClock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-14T18:00:00Z"));
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
    const cloudProvider: DataProvider = createTestDataProvider({
      id: "cloud",
      name: "Cloud",
      priority: 100,
      async getTickerFinancials() {
        return createTestFinancials({
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
        });
      },
      async getQuote() {
        return makeQuote({
          symbol: "AAPL",
          price: 125,
        });
      },
    });
    const gloomProvider: DataProvider = {
      ...cloudProvider,
      id: "gloom",
      name: "Gloom",
      priority: 1000,
      async getTickerFinancials() {
        return createTestFinancials({
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
        });
      },
    };

    const seedRouter = new AssetDataRouter(gloomProvider, [cloudProvider], persistence.resources);
    await seedRouter.getTickerFinancials("AAPL", "NASDAQ", {
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-live",
      instrument,
    });

    let liveCalls = 0;
    const cachedRouter = new AssetDataRouter({
      ...gloomProvider,
      async getTickerFinancials() {
        liveCalls += 1;
        throw new Error("expected cached gloom snapshot");
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

    await tui.render(
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

    const frame = tui.frame();
    expect(liveCalls).toBe(0);
    expect(frame).toContain("2.00B");
    expect(frame).toContain("25.0");
    expect(frame).toContain("22.0");

    persistence.close();
  });

  test("updates a non-selected broker-linked row from streamed quotes", async () => {
    let observationNow = Date.parse("2026-09-14T11:00:00Z");
    quoteClock = spyOn(Date, "now").mockImplementation(() => observationNow);
    const config = createPortfolioConfigWithColumns(
      "broker:ibkr-live:DU12345",
      ["ticker", "price", "change_pct", "latency"],
      [createBrokerInstance("gateway", "ibkr-live")],
    );
    let streamed: ((target: { symbol: string; exchange?: string; context?: unknown }, quote: Quote) => void) | null = null;
    const provider: DataProvider = createTestDataProvider({
      async getTickerFinancials(symbol) {
        if (symbol === "AAPL") {
          return createTestFinancials({
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
          });
        }
        return createTestFinancials({
          quote: makeQuote({
            symbol: "MSFT",
            price: 315,
            change: 2,
            changePercent: 0.64,
            previousClose: 313,
            marketState: "PRE",
            preMarketPrice: 315,
            name: "Microsoft",
          }),
        });
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
            marketState: "PRE",
            preMarketPrice: 315,
            name: "Microsoft",
          });
      },
      subscribeQuotes(_targets, onQuote) {
        streamed = onQuote as typeof streamed;
        return () => {};
      },
    });
    sharedCoordinator = new MarketDataCoordinator(provider);
    setSharedMarketDataCoordinator(sharedCoordinator);

    await tui.render(
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

    observationNow += 1_000;
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
          lastUpdated: Date.now(),
        }),
      );
      await Promise.resolve();
    });
    await flushFrame();

    const frame = tui.frame();
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
    const provider: DataProvider = createTestDataProvider({
      async getTickerFinancials(symbol) {
        return createTestFinancials({ quote: makeQuote({ symbol }) });
      },
      async getQuote(symbol) {
        return makeQuote({ symbol });
      },
      subscribeQuotes(targets) {
        subscribedTargets = targets;
        return () => {};
      },
    });
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

    await tui.render(
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
