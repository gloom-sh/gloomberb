import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness, testRender } from "../../../../renderers/opentui/test-utils";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../../market-data/coordinator";
import { createTestDataProvider } from "../../../../test-support/data-provider";
import type { PricePoint, TickerFinancials } from "../../../../types/financials";
import { createDefaultConfig, TICKER_RESEARCH_PANE_ID } from "../../../../types/config";
import { createInitialState } from "../../../../state/app/context";
import { QuoteMonitorPane, quoteMonitorLabel } from "./index";
import { createTestTicker } from "../../../../test-support/ticker";
import type { PluginRuntimeAccess } from "../../../runtime";
import type { PinTickerOptions } from "../../../../types/plugin";
import { TestPaneProvider, createTestTicker as makeTicker } from "../../../../test-support/pane";
import { createTestPluginRuntime } from "../../../../test-support/plugin-runtime";

const tui = createOpenTuiTestHarness();

afterEach(() => {
  setSharedMarketDataCoordinator(null);
});

interface PinTickerCall {
  symbol: string;
  options?: PinTickerOptions;
}

function makeRuntime(options: {
  pinCalls?: PinTickerCall[];
  settingsCalls?: Array<string | undefined>;
} = {}): PluginRuntimeAccess {
  return createTestPluginRuntime({
    pinTicker: (symbol, pinOptions) => {
      options.pinCalls?.push({ symbol, options: pinOptions });
    },
    openPaneSettings: (paneId) => {
      options.settingsCalls?.push(paneId);
    },
  });
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
    await tui.render(node, options);
  });
}

async function renderOnce() {
  await act(async () => {
    await tui.setup().renderOnce();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function flushFrames(count: number) {
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await tui.setup().renderOnce();
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
    const frame = tui.frame();
    expect(frame).toContain("$1.16023");
    expect(frame).toContain("-0.00108");
  });

  test("opens a Ticker Research pane on the second card click", async () => {
    const pinCalls: PinTickerCall[] = [];
    await renderHarness(createQuoteMonitorHarness({ pinCalls }), {
      width: 72,
      height: 7,
    });

    await renderOnce();
    const frame = tui.frame();
    const row = frame.split("\n").findIndex((line) => line.includes("MSFT"));
    expect(row).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await tui.setup().mockMouse.click(3, row);
      await tui.setup().renderOnce();
      await tui.setup().mockMouse.click(3, row);
      await tui.setup().renderOnce();
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

    const frame = tui.frame();
    expect(loadCalls).toContainEqual({ symbol: "MSFT", exchange: "NASDAQ", range: "1M" });
    expect(frame).toContain("MSFT");
    expect(frame).toMatch(/[⠁-⣿]/);
  });

  test("moves a keyboard cursor across the grid and opens the card under it on Enter", async () => {
    const pinCalls: PinTickerCall[] = [];
    // Two columns: MSFT AAPL on the first row, GOOG alone on the second.
    await renderHarness(createQuoteMonitorHarness({ pinCalls, symbols: ["MSFT", "AAPL", "GOOG"] }), {
      width: 72,
      height: 7,
    });
    await renderOnce();

    await act(async () => {
      tui.setup().mockInput.pressKey("l");
      tui.setup().mockInput.pressKey("j");
      tui.setup().mockInput.pressEnter();
      await tui.setup().renderOnce();
    });

    // Down from the second column of a full row lands on the shorter row's last card.
    expect(pinCalls).toEqual([{
      symbol: "GOOG",
      options: { paneType: TICKER_RESEARCH_PANE_ID, floating: true },
    }]);
  });
});

// a board of Tokyo names read "8058" on the card added from a saved row and "8031:JPX" on the rest.
test("every card on a board is headed in one form: a listing abroad with its venue, a US listing or an index by its symbol", () => {
  expect(quoteMonitorLabel("8058", createTestTicker("8058", "Mitsubishi Corporation", { exchange: "JPX", currency: "JPY" }))).toBe("8058:JPX");
  expect(quoteMonitorLabel("8031:JPX", null)).toBe("8031:JPX");
  // A key saved under the venue's MIC reads by its code, as titles name it.
  expect(quoteMonitorLabel("9992:XHKG", null)).toBe("9992:HKEX");
  expect(quoteMonitorLabel("9992", createTestTicker("9992", "Pop Mart", { exchange: "XHKG", currency: "HKD" }))).toBe("9992:HKEX");
  expect(quoteMonitorLabel("AAPL", createTestTicker("AAPL"))).toBe("AAPL");
  expect(quoteMonitorLabel("^N225", createTestTicker("^N225", "Nikkei 225", { exchange: "OSAKA", currency: "JPY" }))).toBe("^N225");
});
