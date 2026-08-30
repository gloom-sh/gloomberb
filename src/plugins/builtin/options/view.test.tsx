import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { testRender } from "../../../renderers/opentui/test-utils";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { AppContext, PaneInstanceProvider, createInitialState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { cloneLayout, createDefaultConfig } from "../../../types/config";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import type { OptionContract, OptionsChain, Quote, TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import { formatExpDate } from "../../../utils/options";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { PluginRenderProvider } from "../../runtime";
import { OptionsView } from "./view";

const TEST_PANE_ID = "ticker-detail:options-test";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
let setOptionsQuotePrice: ((price: number) => void) | null = null;

function makeTicker(symbol: string): TickerRecord {
  return {
    metadata: {
      ticker: symbol,
      exchange: "NASDAQ",
      currency: "USD",
      name: symbol,
      assetCategory: "STK",
      portfolios: [],
      watchlists: [],
      positions: [],
      custom: {},
      tags: [],
    },
  };
}

function makeContract(strike: number, side: "C" | "P", atmStrike = 101): OptionContract {
  return {
    contractSymbol: `AAPL260619${side}${String(strike * 1000).padStart(8, "0")}`,
    strike,
    currency: "USD",
    lastPrice: strike / 10,
    change: 0,
    percentChange: 0,
    volume: strike * 10,
    openInterest: strike * 20,
    bid: strike / 10 - 0.05,
    ask: strike / 10 + 0.05,
    impliedVolatility: 0.2,
    inTheMoney: side === "C" ? strike < atmStrike : strike > atmStrike,
    expiration: 1_782_345_600,
    lastTradeDate: 1_782_000_000,
  };
}

function makeChain(
  strikes = [100, 101],
  atmStrike = 101,
  expirationDates = [1_782_345_600],
): OptionsChain {
  return {
    underlyingSymbol: "AAPL",
    expirationDates,
    calls: strikes.map((strike) => makeContract(strike, "C", atmStrike)),
    puts: strikes.map((strike) => makeContract(strike, "P", atmStrike)),
  };
}

function makeFinancials(price: number): TickerFinancials {
  return {
    quote: {
      symbol: "AAPL",
      price,
      currency: "USD",
      change: 0,
      changePercent: 0,
      lastUpdated: Date.now(),
    },
    annualStatements: [],
    quarterlyStatements: [],
    priceHistory: [],
  };
}

function OptionsHarness({
  ticker,
  quotePrice,
  width = 122,
  onCapture = () => {},
}: {
  ticker: TickerRecord;
  quotePrice?: number;
  width?: number;
  onCapture?: (capturing: boolean) => void;
}) {
  const config = createDefaultConfig("/tmp/gloomberb-options-test");
  config.layout = {
    dockRoot: { kind: "pane", instanceId: TEST_PANE_ID },
    instances: [{
      instanceId: TEST_PANE_ID,
      paneId: "ticker-detail",
      binding: { kind: "fixed", symbol: ticker.metadata.ticker },
    }],
    floating: [],
    detached: [],
  };
  config.layouts = [{ name: "Default", layout: cloneLayout(config.layout) }];

  const state = createInitialState(config);
  state.focusedPaneId = TEST_PANE_ID;
  state.tickers = new Map([[ticker.metadata.ticker, ticker]]);
  if (quotePrice != null) {
    state.financials = new Map([[ticker.metadata.ticker, makeFinancials(quotePrice)]]);
  }

  return (
    <AppContext value={{ state, dispatch: () => {} }}>
      <PaneInstanceProvider paneId={TEST_PANE_ID}>
        <PluginRenderProvider pluginId="ticker-research" runtime={createTestPluginRuntime()}>
          <OptionsView width={width} height={14} focused onCapture={onCapture} />
        </PluginRenderProvider>
      </PaneInstanceProvider>
    </AppContext>
  );
}

function RealtimeOptionsHarness({ ticker }: { ticker: TickerRecord }) {
  const [quotePrice, setQuotePrice] = useState(120.2);
  setOptionsQuotePrice = setQuotePrice;
  return <OptionsHarness ticker={ticker} quotePrice={quotePrice} />;
}

async function renderSettled() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await testSetup!.renderOnce();
    });
  }
}

afterEach(async () => {
  if (testSetup) {
    await act(async () => {
      testSetup!.renderer.destroy();
    });
    testSetup = undefined;
  }
  setOptionsQuotePrice = null;
  setSharedMarketDataCoordinator(null);
});

test("defaults the table around the nearest strike to the current quote", async () => {
  const strikes = Array.from({ length: 25 }, (_, index) => 50 + index * 5);
  const provider = createTestDataProvider({
    getOptionsChain: async () => makeChain(strikes, 120),
  });
  setSharedMarketDataCoordinator(new MarketDataCoordinator(provider));

  await act(async () => {
    testSetup = await testRender(
      <OptionsHarness ticker={makeTicker("AAPL")} quotePrice={121.2} />,
      {
        width: 124,
        height: 12,
      },
    );
  });

  await renderSettled();

  const frame = testSetup!.captureCharFrame();
  expect(frame).toContain("120");
  expect(frame).not.toContain(" 50 ");
});

test("shows volatility statistics and mirrored default Greeks", async () => {
  const provider = createTestDataProvider({
    getOptionsChain: async () => makeChain([100, 101], 101),
  });
  setSharedMarketDataCoordinator(new MarketDataCoordinator(provider));

  await act(async () => {
    testSetup = await testRender(
      <OptionsHarness ticker={makeTicker("AAPL")} quotePrice={101} />,
      { width: 124, height: 16 },
    );
  });
  await renderSettled();

  const frame = testSetup!.captureCharFrame();
  expect(frame).toContain("ATM IV 20.0%");
  expect(frame).toContain("HV30 —");
  expect(frame).toContain("EXP VOL");
  expect(frame).toContain("C Δ");
  expect(frame).toContain("C Γ");
  expect(frame).toContain("P Γ");
  expect(frame).toContain("P Δ");
});

test("streams live quotes without resetting manual scroll", async () => {
  const strikes = Array.from({ length: 100 }, (_, index) => 50 + index);
  const subscriptions: QuoteSubscriptionTarget[][] = [];
  let emitQuote:
    | ((target: QuoteSubscriptionTarget, quote: Quote) => void)
    | null = null;
  const provider = createTestDataProvider({
    getOptionsChain: async () => makeChain(strikes, 120),
    subscribeQuotes: (targets, onQuote) => {
      subscriptions.push(targets);
      emitQuote = onQuote;
      return () => {};
    },
  });
  const coordinator = new MarketDataCoordinator(provider);
  setSharedMarketDataCoordinator(coordinator);

  await act(async () => {
    testSetup = await testRender(
      <RealtimeOptionsHarness ticker={makeTicker("AAPL")} />,
      {
        width: 124,
        height: 16,
      },
    );
  });
  await renderSettled();

  const targets = subscriptions.at(-1) ?? [];
  expect(targets.length).toBeGreaterThan(16);
  expect(targets.length).toBeLessThanOrEqual(80);
  expect(targets.filter((target) => target.visible === true).length).toBeGreaterThan(16);
  expect(
    targets.every(
      (target) => target.exchange === "OPTIONS" && target.surface === "options",
    ),
  ).toBe(true);
  const selectedCall = targets.find(
    (target) => target.symbol === makeContract(120, "C").contractSymbol,
  );
  expect(selectedCall).toMatchObject({ selected: true });

  await act(async () => {
    emitQuote?.(selectedCall!, {
      symbol: selectedCall!.symbol,
      providerId: "gloomberb-cloud",
      price: 99.9,
      mark: 99.99,
      bid: 99.98,
      ask: 100,
      currency: "USD",
      change: 0,
      changePercent: 0,
      lastUpdated: Date.now(),
      dataSource: "live",
      delivery: "stream",
      stale: false,
    });
    await Promise.resolve();
    await testSetup!.renderOnce();
  });
  await renderSettled();

  expect(
    coordinator.getQuoteEntry({
      symbol: selectedCall!.symbol,
      exchange: "OPTIONS",
    }).data?.mark,
  ).toBe(99.99);
  expect(testSetup!.captureCharFrame()).toContain("99.99");

  const bodyScroll = testSetup!.renderer.root.findDescendantById("options-table-body-scroll") as ScrollBoxRenderable;
  await act(async () => {
    bodyScroll.scrollTo(0);
    await testSetup!.renderOnce();
  });
  await renderSettled();

  await act(async () => {
    setOptionsQuotePrice?.(120.3);
    await testSetup!.renderOnce();
  });
  await renderSettled();
  expect(bodyScroll.scrollTop).toBe(0);
});

test("lets the expiration tab row use the full available width", async () => {
  const expirationDates = Array.from({ length: 9 }, (_, index) => (
    Math.floor(Date.UTC(2026, index, 20) / 1000)
  ));
  const provider = createTestDataProvider({
    getOptionsChain: async () => makeChain([100, 101], 101, expirationDates),
  });
  setSharedMarketDataCoordinator(new MarketDataCoordinator(provider));

  await act(async () => {
    testSetup = await testRender(
      <OptionsHarness ticker={makeTicker("AAPL")} width={122} />,
      {
        width: 124,
        height: 16,
      },
    );
  });

  await renderSettled();

  const frame = testSetup!.captureCharFrame();
  expect(frame).toContain(formatExpDate(expirationDates.at(-1)!));
});

test("keeps expiration tabs independently scrollable from a narrow strike table", async () => {
  const expirationDates = Array.from({ length: 12 }, (_, index) => (
    Math.floor(Date.UTC(2026, index, 20) / 1000)
  ));
  const requestedExpirations: Array<number | undefined> = [];
  const provider = createTestDataProvider({
    getOptionsChain: async (_ticker, _exchange, expirationDate) => {
      requestedExpirations.push(expirationDate);
      return makeChain([100, 101], 101, expirationDates);
    },
  });
  setSharedMarketDataCoordinator(new MarketDataCoordinator(provider));
  const captures: boolean[] = [];

  await act(async () => {
    testSetup = await testRender(
      <OptionsHarness ticker={makeTicker("AAPL")} width={54} onCapture={(capturing) => captures.push(capturing)} />,
      {
        width: 56,
        height: 16,
      },
    );
  });

  await renderSettled();
  const bodyScroll = testSetup!.renderer.root.findDescendantById("options-table-body-scroll") as ScrollBoxRenderable | undefined;
  const expirationTabsScroll = testSetup!.renderer.root.findDescendantById("options-expiration-tabs-scroll") as ScrollBoxRenderable | undefined;
  expect(bodyScroll?.horizontalScrollBar.visible).toBe(true);
  expect(expirationTabsScroll?.horizontalScrollBar.visible).toBe(false);
  expect(testSetup!.captureCharFrame()).not.toContain(formatExpDate(expirationDates.at(-1)!));

  await act(async () => {
    testSetup!.mockInput.pressEnter();
    await testSetup!.renderOnce();
  });
  await renderSettled();
  expect(captures).toContain(true);
  expect(captures.at(-1)).toBe(true);

  for (let index = 1; index < expirationDates.length; index += 1) {
    await act(async () => {
      testSetup!.mockInput.pressKey("l");
      await testSetup!.renderOnce();
    });
    await renderSettled();
  }

  expect(bodyScroll?.horizontalScrollBar.visible).toBe(true);
  expect(bodyScroll?.scrollLeft ?? 0).toBe(0);
  expect(expirationTabsScroll?.scrollLeft ?? 0).toBeGreaterThan(0);
  expect(requestedExpirations).toContain(expirationDates.at(-1));
  expect(testSetup!.captureCharFrame()).toContain(formatExpDate(expirationDates.at(-1)!));
});

test("clicking the option table focuses expiration tabs for arrow navigation", async () => {
  const expirationDates = Array.from({ length: 3 }, (_, index) => (
    Math.floor(Date.UTC(2026, index, 20) / 1000)
  ));
  const requestedExpirations: Array<number | undefined> = [];
  const provider = createTestDataProvider({
    getOptionsChain: async (_ticker, _exchange, expirationDate) => {
      requestedExpirations.push(expirationDate);
      return makeChain([100, 101], 101, expirationDates);
    },
  });
  setSharedMarketDataCoordinator(new MarketDataCoordinator(provider));
  const captures: boolean[] = [];

  await act(async () => {
    testSetup = await testRender(
      <OptionsHarness ticker={makeTicker("AAPL")} width={80} onCapture={(capturing) => captures.push(capturing)} />,
      {
        width: 82,
        height: 16,
      },
    );
  });

  await renderSettled();

  await act(async () => {
    await testSetup!.mockMouse.click(8, 4);
    await testSetup!.renderOnce();
  });
  await renderSettled();
  expect(captures.at(-1)).toBe(true);

  await act(async () => {
    testSetup!.mockInput.pressArrow("right");
    await testSetup!.renderOnce();
  });
  await renderSettled();

  expect(requestedExpirations).toContain(expirationDates[1]);
});
