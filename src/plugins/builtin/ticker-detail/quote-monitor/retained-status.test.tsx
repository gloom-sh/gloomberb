import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../../../../renderers/opentui/test-utils";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../../market-data/coordinator";
import { createTestDataProvider } from "../../../../test-support/data-provider";
import { createTestPluginRuntime } from "../../../../test-support/plugin-runtime";
import { TestPaneProvider, createTestPaneConfig } from "../../../../test-support/pane";
import { createInitialState } from "../../../../state/app/context";
import type { Quote, TickerFinancials } from "../../../../types/financials";
import { QuoteMonitorPane } from "./index";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let coordinator: MarketDataCoordinator | undefined;
const symbol = "EURUSD=X";
const instrument = { symbol, exchange: "" };

async function frame() {
  for (let i = 0; i < 3; i++) await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await setup!.renderOnce();
  });
  return setup!.captureCharFrame();
}

afterEach(async () => {
  if (setup) await act(async () => { setup!.renderer.destroy(); });
  setup = undefined;
  coordinator?.destroy();
  coordinator = undefined;
  setSharedMarketDataCoordinator(null);
});

async function render(width: number, getQuote: () => Promise<Quote>, cached?: Quote, height = 7, targetSymbol = symbol) {
  const provider = createTestDataProvider({ getQuote });
  coordinator = new MarketDataCoordinator(provider);
  setSharedMarketDataCoordinator(coordinator);
  const config = createTestPaneConfig("/tmp/gloom-qm-retained-status", {
    instanceId: "qm:test", paneId: "quote-monitor", binding: { kind: "none" },
    settings: { symbols: [targetSymbol], liveStreaming: false },
  });
  const state = createInitialState(config);
  if (cached) state.financials.set(targetSymbol, {
    quote: cached, annualStatements: [], quarterlyStatements: [], priceHistory: [],
  } satisfies TickerFinancials);
  await act(async () => {
    setup = await testRender(<TestPaneProvider state={state} paneId="qm:test" pluginId="ticker-research"
      runtime={createTestPluginRuntime({ getMarketData: () => provider })}>
      <QuoteMonitorPane paneId="qm:test" paneType="quote-monitor" focused width={width} height={height} />
    </TestPaneProvider>, { width, height });
  });
  return frame();
}

function quote(price = 1.160227): Quote {
  return { symbol, price, currency: "USD", instrumentType: "CURRENCY", change: -0.001078,
    changePercent: -0.09, lastUpdated: Date.now() };
}

test.each([80, 120])("retained provider quote exposes refresh failure and clears it on recovery at %i columns", async (width) => {
  let fail = false;
  let price = 1.160227;
  let calls = 0;
  const initial = await render(width, async () => {
    calls++;
    if (fail) throw new Error("FX feed disconnected");
    return quote(price);
  });
  expect(calls).toBeGreaterThan(0);
  expect(initial).toContain("$1.160227");
  expect(initial).not.toContain("disconnected");

  fail = true;
  await act(async () => { await coordinator!.loadQuotesBatch([instrument], { forceRefresh: true }); });
  const entry = coordinator!.getQuoteEntry(instrument);
  expect(entry.error?.message).toBe("FX feed disconnected");
  expect(entry.lastGoodData?.price).toBe(1.160227);
  const failed = await frame();
  expect(failed).toContain("$1.160227");
  expect(failed).toContain("FX feed disconnected");

  fail = false;
  price = 1.170227;
  await act(async () => { await coordinator!.loadQuotesBatch([instrument], { forceRefresh: true }); });
  const recovered = await frame();
  expect(recovered).toContain("$1.170227");
  expect(recovered).not.toContain("disconnected");
  expect(coordinator!.getQuoteEntry(instrument).error).toBeNull();
});

test("explicit stale cached quote is identified while its provider refresh is pending", async () => {
  let complete!: (value: Quote) => void;
  const pending = new Promise<Quote>((resolve) => { complete = resolve; });
  const retained = await render(80, () => pending, { ...quote(), stale: true });
  expect(retained).toContain("$1.160227");
  expect(retained).toContain("Stale quote");
  await act(async () => { complete(quote(1.170227)); });
  const recovered = await frame();
  expect(recovered).toContain("$1.170227");
  expect(recovered).not.toContain("Stale quote");
});

test.each(["NaN", "Infinity", "future"] as const)("retained quote with %s source time stays visibly stale until a valid observation arrives", async kind => {
  let complete!: (value: Quote) => void;
  const pending = new Promise<Quote>(resolve => { complete = resolve; });
  const invalidTime = kind === "NaN" ? NaN : kind === "Infinity" ? Infinity : Date.now() + 86_400_000;
  const cached = { ...quote(), lastUpdated: invalidTime, receivedAt: Date.now() };
  const retained = await render(80, () => pending, cached);
  expect(retained).toContain("$1.160227");
  expect(retained).toContain("Stale quote");
  expect(Object.is(cached.lastUpdated, invalidTime)).toBe(true);
  await act(async () => { complete(quote(1.170227)); });
  const recovered = await frame();
  expect(recovered).toContain("$1.170227");
  expect(recovered).not.toContain("Stale quote");
});

// Dense boards can allocate only three rows to a narrow card. The failure must
// remain visible there without pushing the retained quote off the card.
test.each(["error", "stale"] as const)("compact retained card identifies %s without wrapping a long symbol", async (kind) => {
  const longSymbol = "LRCX260918C01200000";
  const optionQuote: Quote = { ...quote(14.23), symbol: longSymbol, instrumentType: "OPTION", change: -0.07 };
  let finish!: (value: Quote) => void;
  const pending = new Promise<Quote>((resolve) => { finish = resolve; });
  const result = await render(30, () => kind === "error" ? Promise.reject(new Error("FX feed disconnected")) : pending,
    { ...optionQuote, stale: kind === "stale" }, 3, longSymbol);
  expect(result).toContain(longSymbol);
  expect(result).toContain("-0.07");
  expect(result).toContain("$14.23");
  expect(result).toContain(kind === "stale" ? "STALE" : "ERROR");
  if (kind === "stale") {
    await act(async () => { finish({ ...optionQuote, price: 14.5, lastUpdated: Date.now() }); });
    expect(await frame()).not.toContain("STALE");
  }
});
