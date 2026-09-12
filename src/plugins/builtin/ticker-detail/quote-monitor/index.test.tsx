import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../../../../renderers/opentui/test-utils";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../../market-data/coordinator";
import { createTestDataProvider } from "../../../../test-support/data-provider";
import type { PricePoint, TickerFinancials } from "../../../../types/financials";
import { createDefaultConfig, TICKER_RESEARCH_PANE_ID } from "../../../../types/config";
import { createInitialState } from "../../../../state/app/context";
import { QuoteMonitorPane } from "./index";
import type { PluginRuntimeAccess } from "../../../runtime";
import type { PinTickerOptions } from "../../../../types/plugin";
import { TestPaneProvider, createTestTicker as makeTicker } from "../../../../test-support/pane";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(async () => {
  setSharedMarketDataCoordinator(null);
  if (testSetup) {
    await act(async () => {
      testSetup!.renderer.destroy();
    });
    testSetup = undefined;
  }
});

interface PinTickerCall {
  symbol: string;
  options?: PinTickerOptions;
}

function makeRuntime(options: {
  pinCalls?: PinTickerCall[];
  settingsCalls?: Array<string | undefined>;
} = {}): PluginRuntimeAccess {
  return {
    getMarketData: () => null,
    getCapability: () => null,
    getBrokerAdapter: () => null,
    connectBrokerInstance: async () => {},
    updateBrokerInstance: async () => {},
    syncBrokerInstance: async () => {},
    removeBrokerInstance: async () => {},
    pinTicker: (symbol, pinOptions) => {
      options.pinCalls?.push({ symbol, options: pinOptions });
    },
    navigateTicker: () => {},
    selectTicker: () => {},
    switchTab: () => {},
    switchPanel: () => {},
    openCommandBar: () => {},
    showPane: () => {},
    createPaneFromTemplate: () => {},
    hidePane: () => {},
    openPaneSettings: (paneId) => {
      options.settingsCalls?.push(paneId);
    },
    openPluginCommandWorkflow: () => {},
    notify: () => {},
    subscribeResumeState: () => () => {},
    getResumeState: () => null,
    setResumeState: () => {},
    deleteResumeState: () => {},
    getConfigState: () => null,
    setConfigState: async () => {},
    setConfigStates: async () => {},
    deleteConfigState: async () => {},
    getConfigStateKeys: () => [],
  };
}

function makePriceHistory(price: number): PricePoint[] {
  return Array.from({ length: 12 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 0, index + 1)),
    close: price - 6 + index,
  }));
}

function makeFinancials(
  symbol: string,
  price: number,
  change: number,
  changePercent: number,
  priceHistory = makePriceHistory(price),
): TickerFinancials {
  return {
    quote: {
      symbol,
      price,
      currency: "USD",
      change,
      changePercent,
      lastUpdated: Date.now(),
    },
    annualStatements: [],
    quarterlyStatements: [],
    priceHistory,
  };
}

function createQuoteMonitorHarness(options: {
  width?: number;
  symbols?: string[];
  financials?: Map<string, TickerFinancials>;
  pinCalls?: PinTickerCall[];
  settingsCalls?: Array<string | undefined>;
} = {}) {
  const symbols = options.symbols ?? ["MSFT"];
  const config = createDefaultConfig("/tmp/gloomberb-test");
  (config.layout as typeof config.layout & { docked: Array<{ instanceId: string; columnIndex: number; order: number }> }).docked = [
    { instanceId: "ticker-detail:main", columnIndex: 0, order: 0 },
    { instanceId: "quote-monitor:test", columnIndex: 1, order: 0 },
  ];
  config.layout.instances.push({
    instanceId: "quote-monitor:test",
    paneId: "quote-monitor",
    title: symbols.join(" · "),
    binding: { kind: "fixed", symbol: symbols[0]! },
    settings: {
      symbol: symbols[0]!,
      symbols,
      symbolsText: symbols.join(", "),
    },
  });

  const state = createInitialState(config);

  const tickers = [
    makeTicker("MSFT", "Microsoft"),
    makeTicker("AAPL", "Apple"),
  ];
  state.tickers = new Map(tickers.map((ticker) => [ticker.metadata.ticker, ticker]));
  state.financials = options.financials ?? new Map([
    ["MSFT", makeFinancials("MSFT", 356.15, -9.82, -2.68)],
    ["AAPL", makeFinancials("AAPL", 202.12, 3.05, 1.53)],
  ]);

  return (
    <TestPaneProvider state={state} paneId="quote-monitor:test" pluginId="ticker-research" runtime={makeRuntime({
      pinCalls: options.pinCalls,
      settingsCalls: options.settingsCalls,
    })}>
      <QuoteMonitorPane paneId="quote-monitor:test" paneType="quote-monitor" focused width={options.width ?? 72} height={7} />
    </TestPaneProvider>
  );
}

async function renderHarness(
  node: ReturnType<typeof createQuoteMonitorHarness>,
  options: Parameters<typeof testRender>[1],
) {
  await act(async () => {
    testSetup = await testRender(node, options);
  });
}

async function renderOnce() {
  await act(async () => {
    await testSetup!.renderOnce();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function flushFrames(count: number) {
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await testSetup!.renderOnce();
    });
  }
}

describe("QuoteMonitorPane", () => {
  test.each([80, 120])("uses returned FX instrument type when no ticker metadata exists at %s columns", async (width) => {
    const symbol = "EURUSD=X";
    const financials = makeFinancials(symbol, 1.1602274179458618, -0.0010778820541381684, -0.09281642425451501, []);
    financials.quote!.instrumentType = "CURRENCY";
    await renderHarness(createQuoteMonitorHarness({ width, symbols: [symbol], financials: new Map([[symbol, financials]]) }), { width, height: 7 });
    await renderOnce();
    const frame = testSetup!.captureCharFrame();
    expect(frame).toContain("$1.160227");
    expect(frame).toContain("-0.001078");
  });

  test("opens a Ticker Research pane on the second card click", async () => {
    const pinCalls: PinTickerCall[] = [];
    await renderHarness(createQuoteMonitorHarness({ pinCalls }), {
      width: 72,
      height: 7,
    });

    await renderOnce();
    const frame = testSetup.captureCharFrame();
    const row = frame.split("\n").findIndex((line) => line.includes("MSFT"));
    expect(row).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await testSetup!.mockMouse.click(3, row);
      await testSetup!.renderOnce();
      await testSetup!.mockMouse.click(3, row);
      await testSetup!.renderOnce();
    });

    expect(pinCalls).toEqual([{
      symbol: "MSFT",
      options: { paneType: TICKER_RESEARCH_PANE_ID, floating: true },
    }]);
  });

  test("loads chart history for quote-only cards", async () => {
    const loadCalls: Array<{ symbol: string; exchange: string; range: string }> = [];
    const chartHistory = makePriceHistory(356.15);
    setSharedMarketDataCoordinator(new MarketDataCoordinator(createTestDataProvider({
      getTickerFinancials: async (symbol) => makeFinancials(symbol, 356.15, -9.82, -2.68, []),
      getPriceHistory: async (symbol, exchange, range) => {
        loadCalls.push({ symbol, exchange, range });
        return chartHistory;
      },
    })));

    await renderHarness(createQuoteMonitorHarness({
      financials: new Map([
        ["MSFT", makeFinancials("MSFT", 356.15, -9.82, -2.68, [])],
      ]),
    }), {
      width: 72,
      height: 7,
    });

    await renderOnce();
    await flushFrames(3);

    const frame = testSetup.captureCharFrame();
    expect(loadCalls).toContainEqual({ symbol: "MSFT", exchange: "NASDAQ", range: "1M" });
    expect(frame).toContain("MSFT");
    expect(frame).toMatch(/[⠁-⣿]/);
  });

  test("opens pane settings when t is pressed", async () => {
    const settingsCalls: Array<string | undefined> = [];
    await renderHarness(createQuoteMonitorHarness({ settingsCalls }), {
      width: 72,
      height: 7,
    });

    await renderOnce();

    await act(async () => {
      testSetup!.mockInput.pressKey("t");
      await testSetup!.renderOnce();
    });

    expect(settingsCalls).toEqual(["quote-monitor:test"]);
  });
});
