import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { Box } from "../../../ui";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import type { ScrollBoxRenderable } from "@opentui/core";
import { takeSavedTextFile, testRender } from "../../../renderers/opentui/test-utils";
import { exportPaneTable, hasPaneTableExporter } from "../../../state/pane-table-export-registry";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { createInitialState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import type { OptionContract, OptionsChain, Quote, TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import { formatExpDate } from "../../../utils/options";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { OptionsView } from "./view";
import { TestPaneProvider, createTestTicker, createTestPaneConfig } from "../../../test-support/pane";

const TEST_PANE_ID = "ticker-detail:options-test";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
let setOptionsQuotePrice: ((price: number) => void) | null = null;

function makeTicker(symbol: string): TickerRecord {
  return createTestTicker(symbol, symbol, {
    assetCategory: "STK"
  });
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
  quoteStale,
  history,
  showFooter = false,
  width = 122,
  height = 14,
  onCapture = () => { },
}: {
  ticker: TickerRecord;
  quotePrice?: number;
  quoteStale?: boolean;
  history?: TickerFinancials["priceHistory"];
  showFooter?: boolean;
  width?: number;
  height?: number;
  onCapture?: (capturing: boolean) => void;
}) {
  const config = createTestPaneConfig("/tmp/gloomberb-options-test", {
    instanceId: TEST_PANE_ID,
    paneId: "ticker-detail",
    binding: { kind: "fixed", symbol: ticker.metadata.ticker },
  });

  const state = createInitialState(config);
  state.focusedPaneId = TEST_PANE_ID;
  state.tickers = new Map([[ticker.metadata.ticker, ticker]]);
  if (quotePrice != null) {
    const financials = makeFinancials(quotePrice);
    financials.quote.stale = quoteStale;
    if (history) financials.priceHistory = history;
    state.financials = new Map([[ticker.metadata.ticker, financials]]);
  }

  return (
    <TestPaneProvider state={state} paneId={TEST_PANE_ID} pluginId="ticker-research" runtime={createTestPluginRuntime()}>
      {showFooter ? <PaneFooterProvider>{(footer) => <Box width={width} height={height} flexDirection="column">
        <Box width={width} height={height - 1}><OptionsView width={width} height={height - 1} focused onCapture={onCapture} /></Box>
        <PaneFooterBar footer={footer} focused width={width} />
      </Box>}</PaneFooterProvider> : <OptionsView width={width} height={height} focused onCapture={onCapture} />}
    </TestPaneProvider>
  );
}

function RealtimeOptionsHarness({ ticker }: { ticker: TickerRecord }) {
  const [quotePrice, setQuotePrice] = useState(120.2);
  setOptionsQuotePrice = setQuotePrice;
  return <OptionsHarness ticker={ticker} quotePrice={quotePrice} height={20} />;
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

test("exposes exactly one exportable table so CSV export stays wired up", async () => {
  const provider = createTestDataProvider({
    getOptionsChain: async () => makeChain([100, 101], 101),
  });
  setSharedMarketDataCoordinator(new MarketDataCoordinator(provider));

  await act(async () => {
    testSetup = await testRender(
      <OptionsHarness ticker={makeTicker("AAPL")} quotePrice={101} />,
      { width: 124, height: 12 },
    );
  });
  await renderSettled();

  // `tableExport: true` on the options pane only works when the pane mounts a single
  // DataTable; a second concurrent table would silently disable the export action.
  expect(hasPaneTableExporter(TEST_PANE_ID)).toBe(true);

  const location = await exportPaneTable(TEST_PANE_ID, "options.csv");
  expect(location).toBe("~/Downloads/options.csv");

  const saved = takeSavedTextFile();
  expect(saved?.name).toBe("options.csv");
  expect(saved?.text.split("\n")[0]).toContain("STRIKE");
  expect(saved?.text).toContain("101");
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

test("keeps table geometry steady while a cold expiry has no contract context", async () => {
  const firstExpiry = 1_782_345_600;
  const nextExpiry = firstExpiry + 7 * 86400;
  const initial = makeChain(Array.from({ length: 100 }, (_, index) => 50 + index), 120, [firstExpiry, nextExpiry]);
  let finishNext!: (chain: OptionsChain) => void;
  const next = new Promise<OptionsChain>((resolve) => { finishNext = resolve; });
  const provider = createTestDataProvider({
    getOptionsChain: async (_symbol, _exchange, expiration) => expiration === nextExpiry ? next : initial,
  });
  setSharedMarketDataCoordinator(new MarketDataCoordinator(provider));
  await act(async () => {
    testSetup = await testRender(<OptionsHarness ticker={makeTicker("AAPL")} quotePrice={120} />, { width: 124, height: 16 });
  });
  await renderSettled();
  const tableHeight = () => (testSetup!.renderer.root.findDescendantById("options-table-body-scroll") as ScrollBoxRenderable).height;
  const before = tableHeight();
  await act(async () => { testSetup!.mockInput.pressEnter(); });
  await renderSettled();
  await act(async () => { testSetup!.mockInput.pressKey("l"); });
  await renderSettled();
  expect(testSetup!.captureCharFrame()).toContain("Loading strikes");
  expect(testSetup!.captureCharFrame()).not.toContain("AAPL260619C");
  expect(tableHeight()).toBe(before);
  await act(async () => { finishNext({ ...initial,
    calls: initial.calls.map((c) => ({ ...c, expiration: nextExpiry, contractSymbol: c.contractSymbol.replace("260619", "260626") })),
    puts: initial.puts.map((c) => ({ ...c, expiration: nextExpiry, contractSymbol: c.contractSymbol.replace("260619", "260626") })),
  }); });
  await renderSettled();
  expect(tableHeight()).toBe(before);
  expect(testSetup!.captureCharFrame()).toContain("AAPL260626C00120000");
  expect((testSetup!.renderer.root.findDescendantById("options-table-body-scroll") as ScrollBoxRenderable).scrollTop).toBeGreaterThan(0);
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
        height: 22,
      },
    );
  });
  await renderSettled();

  const subscribedTargets = subscriptions.at(-1) ?? [];
  expect(subscribedTargets.some((target) => target.symbol === "AAPL" && target.exchange !== "OPTIONS")).toBe(true);
  const targets = subscribedTargets.filter((target) => target.exchange === "OPTIONS");
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
      lastTradePrice: 99.9,
      lastTradeTime: Date.now(),
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
  expect(testSetup!.captureCharFrame()).toContain("99.9");

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

test("a standalone chain subscribes to its underlying and resolves ATM without a research pane", async () => {
  let targets: QuoteSubscriptionTarget[] = [];
  let emit: ((target: QuoteSubscriptionTarget, quote: Quote) => void) | undefined;
  const provider = createTestDataProvider({
    getTickerFinancials: async () => ({ annualStatements: [], quarterlyStatements: [], priceHistory: [] }),
    getOptionsChain: async () => makeChain(Array.from({ length: 100 }, (_, index) => 50 + index), 120),
    subscribeQuotes: (nextTargets, onQuote) => {
      targets = nextTargets;
      emit = onQuote;
      return () => {};
    },
  });
  setSharedMarketDataCoordinator(new MarketDataCoordinator(provider));
  await act(async () => {
    testSetup = await testRender(<OptionsHarness ticker={makeTicker("AAPL")} />, { width: 124, height: 16 });
  });
  await renderSettled();
  const underlying = targets.find((target) => target.symbol === "AAPL");
  expect(underlying).toBeDefined();
  await act(async () => { emit!(underlying!, makeFinancials(120.2).quote!); });
  await renderSettled();
  const scrollBox = testSetup!.renderer.root.findDescendantById("options-table-body-scroll") as ScrollBoxRenderable;
  expect(scrollBox.scrollTop).toBeGreaterThan(0);
  expect(testSetup!.captureCharFrame()).toContain("ATM IV 20.0%");
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

test("starts at a held contract's expiry and preserves a researcher-selected roll expiry", async () => {
  const expirationDates = [Date.UTC(2026, 8, 18), Date.UTC(2026, 9, 16), Date.UTC(2026, 10, 20)]
    .map((ms) => ms / 1000);
  const requestedExpirations: Array<number | undefined> = [];
  const provider = createTestDataProvider({
    getTickerFinancials: async () => makeFinancials(326.72),
    getOptionsChain: async (_ticker, _exchange, expirationDate) => {
      if (_ticker === "MSFT") return new Promise<OptionsChain>(() => {});
      requestedExpirations.push(expirationDate);
      const expiry = expirationDate ?? expirationDates[0]!;
      const chain = makeChain([330 + expirationDates.indexOf(expiry) * 10], 340, expirationDates);
      for (const contract of [...chain.calls, ...chain.puts]) contract.expiration = expiry;
      return chain;
    },
  });
  const coordinator = new MarketDataCoordinator(provider);
  setSharedMarketDataCoordinator(coordinator);
  const ticker = makeTicker("AAPL 261016C00340000");
  ticker.metadata.assetCategory = "OPT";
  ticker.metadata.positions = [
    { portfolio: "fixture", shares: 2, side: "short", avgCost: 5.52, broker: "manual", multiplier: 100 },
    { portfolio: "fixture", shares: -1, avgCost: 5.52, broker: "manual", multiplier: 100 },
    { portfolio: "fixture", shares: 1, side: "long", avgCost: 5.52, broker: "manual", multiplier: 100 },
  ];
  let selectTicker: (ticker: TickerRecord) => void = () => {};
  function SwitchingHarness() {
    const [selected, setSelected] = useState(ticker);
    selectTicker = setSelected;
    return <OptionsHarness ticker={selected} />;
  }
  await act(async () => {
    testSetup = await testRender(<SwitchingHarness />, { width: 124, height: 16 });
  });
  await renderSettled();
  expect(requestedExpirations.at(-1)).toBe(expirationDates[1]);
  expect(testSetup!.captureCharFrame()).toContain("Position: -2 call contracts (SHORT)");

  await act(async () => { testSetup!.mockInput.pressEnter(); });
  await renderSettled();
  await act(async () => { testSetup!.mockInput.pressArrow("right"); });
  await renderSettled();
  expect(requestedExpirations.at(-1)).toBe(expirationDates[2]);
  expect(testSetup!.captureCharFrame()).toContain("350");

  // A refreshed expiry catalogue must not undo the user's chosen roll date.
  await act(async () => {
    await coordinator.loadOptions({ instrument: { symbol: "AAPL", exchange: "" } }, { forceRefresh: true });
  });
  await renderSettled();
  expect(testSetup!.captureCharFrame()).toContain("350");
  await act(async () => { testSetup!.mockInput.pressArrow("left"); });
  await renderSettled();
  expect(testSetup!.captureCharFrame()).toContain("340");

  // Returning before another instrument's catalogue loads must initialize the
  // holding again, rather than retain that intermediate target's index zero.
  await act(async () => { selectTicker(makeTicker("MSFT")); });
  await renderSettled();
  expect(testSetup!.captureCharFrame()).toContain("Loading options chain");
  await act(async () => { selectTicker(ticker); });
  await renderSettled();
  expect(testSetup!.captureCharFrame()).toMatch(/34\.05\s+34\s+.*340/);
});

test("keeps the selected chain visible when its refresh fails", async () => {
  let failRefresh = false;
  const provider = createTestDataProvider({
    getOptionsChain: async () => {
      if (failRefresh) throw new Error("Options provider unavailable");
      return makeChain([100, 101], 101);
    },
  });
  const coordinator = new MarketDataCoordinator(provider);
  setSharedMarketDataCoordinator(coordinator);
  await act(async () => {
    testSetup = await testRender(
      <OptionsHarness ticker={makeTicker("AAPL")} quotePrice={101} />,
      { width: 124, height: 16 },
    );
  });
  await renderSettled();
  failRefresh = true;
  await act(async () => {
    const entry = await coordinator.loadOptions({ instrument: { symbol: "AAPL", exchange: "NASDAQ" }, expirationDate: 1_782_345_600 }, { forceRefresh: true });
    expect(entry.error?.message).toContain("Options provider unavailable");
  });
  await renderSettled();
  const frame = testSetup!.captureCharFrame();
  expect(frame).toContain("C LAST");
  expect(frame).toContain("101");
  expect(frame).not.toContain("Options chain unavailable.");
});


test("stale underlying preserves contract observations but cannot seed current Greeks or calculator", async () => {
  const provider = createTestDataProvider({ getOptionsChain: async () => makeChain([100, 101], 101) });
  setSharedMarketDataCoordinator(new MarketDataCoordinator(provider));
  let setStale!: (value: boolean) => void;
  function FreshnessHarness() {
    const [stale, updateStale] = useState(true);
    setStale = updateStale;
    return <OptionsHarness ticker={makeTicker("AAPL")} quotePrice={101} quoteStale={stale} showFooter height={20} width={160} />;
  }
  await act(async () => {
    testSetup = await testRender(<FreshnessHarness />, { width: 160, height: 20 });
  });
  await renderSettled();
  const frame = testSetup!.captureCharFrame();
  if (process.env.OPTIONS_AUDIT_EVIDENCE) await Bun.write(`${process.env.OPTIONS_AUDIT_EVIDENCE}/stale-underlying.txt`, frame);
  expect(frame).toContain("ATM IV —");
  expect(frame).toContain("Underlying quote stale");
  expect(frame).not.toContain("[c]alc");
  await exportPaneTable(TEST_PANE_ID, "stale-options.csv");
  const saved = takeSavedTextFile()!.text;
  if (process.env.OPTIONS_AUDIT_EVIDENCE) await Bun.write(`${process.env.OPTIONS_AUDIT_EVIDENCE}/stale-underlying.csv`, saved);
  const lines = saved.trim().split("\n").map((line) => line.split(","));
  const deltaColumns = lines[0]!.flatMap((cell, i) => cell.includes("Δ") ? [i] : []);
  expect(deltaColumns).toHaveLength(2);
  for (const row of lines.slice(1)) for (const i of deltaColumns) expect(row[i]).toBe("—");
  expect(saved).toContain("10.05,10.15,10.1");
  await act(async () => { setStale(false); });
  await renderSettled();
  const recovered = testSetup!.captureCharFrame();
  expect(recovered).toContain("ATM IV 20.0%");
  expect(recovered).toContain("[c]alc");
  expect(recovered).not.toContain("Underlying quote stale");
  if (process.env.OPTIONS_AUDIT_EVIDENCE) await Bun.write(`${process.env.OPTIONS_AUDIT_EVIDENCE}/underlying-recovery.txt`, recovered);
});


test("rejected history disables HV and IV/HV without discarding healthy chain analytics", async () => {
  const provider = createTestDataProvider({ getOptionsChain: async () => makeChain([100, 101], 101) });
  setSharedMarketDataCoordinator(new MarketDataCoordinator(provider));
  const history = Array.from({ length: 31 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, i + 1)), close: 100 + i % 2,
    ...(i === 15 ? { high: 90, low: 110 } : {}),
  }));
  await act(async () => {
    testSetup = await testRender(<OptionsHarness ticker={makeTicker("AAPL")} quotePrice={101} history={history} showFooter height={20} width={160} />, { width: 160, height: 20 });
  });
  await renderSettled();
  const frame = testSetup!.captureCharFrame();
  if (process.env.OPTIONS_AUDIT_EVIDENCE) await Bun.write(`${process.env.OPTIONS_AUDIT_EVIDENCE}/rejected-history.txt`, frame);
  expect(frame).toContain("ATM IV 20.0%");
  expect(frame).toContain("HV30 —");
  expect(frame).toContain("IV/HV —");
  expect(frame).toContain("HV30 unavailable: inconsistent OHLC history");
  expect(frame).toContain("[c]alc");
});
