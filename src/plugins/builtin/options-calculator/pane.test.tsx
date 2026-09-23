import { afterEach, expect, test } from "bun:test";
import { useReducer } from "react";
import { act } from "react";
import { useShortcut } from "../../../react/input";
import { emitKeypress, testRender } from "../../../renderers/opentui/test-utils";
import { PaneKeyboardScrollController } from "../../../state/pane-scroll-registry";
import {
  AppContext,
  PaneInstanceProvider,
  appReducer,
  createInitialState,
} from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { PluginRenderProvider } from "../../runtime";
import { cloneLayout, createDefaultConfig } from "../../../types/config";
import { OPTIONS_CALCULATOR_PANE_ID } from "./model";
import { OptionsCalculatorPane } from "./pane";
import { valueBinomialOption } from "./binomial";
import { daysToExpiryFrom, draftFromParams, valueOption } from "./model";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { createTestDataProvider } from "../../../test-support/data-provider";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import type { Quote } from "../../../types/financials";

const TEST_PANE_ID = "options-calculator:test";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

function GlobalTabHandler() {
  useShortcut((event) => {
    if (event.name !== "tab") return;
    event.preventDefault();
    event.stopPropagation();
  }, { phase: "before" });
  return null;
}

function Harness({ params, settings, width = 90, height = 18 }: { params?: Record<string, string>; settings?: Record<string, unknown>; width?: number; height?: number }) {
  const config = createDefaultConfig("/tmp/gloomberb-options-calculator-test");
  config.layout = {
    dockRoot: { kind: "pane", instanceId: TEST_PANE_ID },
    instances: [{
      instanceId: TEST_PANE_ID,
      paneId: OPTIONS_CALCULATOR_PANE_ID,
      binding: { kind: "none" },
      params,
      settings,
    }],
    floating: [],
    detached: [],
  };
  config.layouts = [{ name: "Default", layout: cloneLayout(config.layout) }];

  const initialState = createInitialState(config);
  initialState.focusedPaneId = TEST_PANE_ID;
  const [state, dispatch] = useReducer(appReducer, initialState);

  return (
    <AppContext value={{ state, dispatch }}>
      <GlobalTabHandler />
      <PaneInstanceProvider paneId={TEST_PANE_ID}>
        <PaneKeyboardScrollController paneId={TEST_PANE_ID} focused />
        <PluginRenderProvider pluginId="ticker-research" runtime={createTestPluginRuntime()}>
          <OptionsCalculatorPane
            paneId={TEST_PANE_ID}
            paneType={OPTIONS_CALCULATOR_PANE_ID}
            focused
            width={width}
            height={height}
          />
        </PluginRenderProvider>
      </PaneInstanceProvider>
    </AppContext>
  );
}

async function render(params?: Record<string, string>, width = 90, height = 18, settings?: Record<string, unknown>) {
  await act(async () => {
    testSetup = await testRender(<Harness params={params} settings={settings} width={width} height={height} />, { width, height });
    await Promise.resolve();
    await testSetup.renderOnce();
  });
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await testSetup!.renderOnce();
    });
  }
}

afterEach(async () => {
  if (testSetup) {
    await act(async () => { testSetup!.renderer.destroy(); });
    testSetup = undefined;
  }
  setSharedMarketDataCoordinator(null);
});

test("a chain-seeded calculator follows the contract and underlying until the user edits them", async () => {
  const targets: QuoteSubscriptionTarget[] = [];
  let emit: ((target: QuoteSubscriptionTarget, quote: Quote) => void) | undefined;
  setSharedMarketDataCoordinator(new MarketDataCoordinator(createTestDataProvider({
    subscribeQuotes: (next, onQuote) => { targets.splice(0, targets.length, ...next); emit = onQuote; return () => {}; },
  })));
  const expiration = Math.floor(Date.now() / 86_400_000) * 86_400 + 30 * 86_400;
  await render({ symbol: "COST", side: "call", spot: "900", strike: "905", days: "30", volatility: "0.25", rate: "0.04",
    marketPrice: "20", marketPriceSource: "mid", marketReference: JSON.stringify({ contractSymbol: "COST261023C00905000",
      expiration, currency: "USD", bid: 19.9, ask: 20.1, lastPrice: 20, lastTradeDate: Math.floor(Date.now() / 1000) - 600 }) }, 90, 24);
  const contract = targets.find((target) => target.symbol === "COST261023C00905000")!;
  const underlying = targets.find((target) => target.symbol === "COST")!;
  expect(contract).toBeDefined();
  expect(underlying).toBeDefined();
  const quote = (symbol: string, fields: Partial<Quote>): Quote => ({ symbol, price: 0, currency: "USD", change: 0, changePercent: 0,
    lastUpdated: Date.now(), receivedAt: Date.now(), dataSource: "live", delivery: "stream", stale: false, ...fields });
  const settle = async () => {
    for (let index = 0; index < 4; index += 1) await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await testSetup!.renderOnce();
    });
  };
  // A streaming underlying alone never marks the saved contract price to it.
  await act(async () => { emit!(underlying, quote("COST", { price: 910 })); });
  await settle();
  let frame = testSetup!.captureCharFrame();
  expect(frame).toMatch(/Spot\s+900/);
  expect(frame).toContain("Snapshot:");
  expect(frame).not.toContain("real-time market");
  await act(async () => { emit!(contract, quote(contract.symbol, { price: 24, bid: 23.9, ask: 24.1 })); });
  await settle();
  frame = testSetup!.captureCharFrame();
  expect(frame).toMatch(/Mid\s+24(?!\.)/);
  expect(frame).toMatch(/Spot\s+910/);
  // The contract context is the live quote now, not a saved snapshot.
  expect(frame).not.toContain("Snapshot:");
  expect(frame).toContain("Bid 23.9 · Ask 24.1");
  const liveIv = frame.match(/Implied IV\s+([\d.]+)%/)![1];
  const expected = valueOption({ ...draftFromParams({}), side: "call", spot: 910, strike: 905, rate: 0.04,
    daysToExpiry: daysToExpiryFrom(expiration, Date.now()), volatility: Number(liveIv) / 100, dividendYield: 0 }).price;
  expect(expected).toBeCloseTo(24, 1);

  // A typed spot is the user's: later underlying ticks no longer move it.
  await emitKeypress(testSetup!, { name: "tab", sequence: "\t" });
  await act(async () => { await testSetup!.mockInput.typeText("905"); testSetup!.mockInput.pressEnter(); });
  await act(async () => { await testSetup!.renderOnce(); });
  await emitKeypress(testSetup!, { name: "escape", sequence: "\u001B" });
  await act(async () => { emit!(underlying, quote("COST", { price: 915 })); });
  await settle();
  frame = testSetup!.captureCharFrame();
  expect(frame).toMatch(/Spot\s+905/);
  expect(frame).toMatch(/Mid\s+24(?!\.)/);
});

test("narrow results keep contract context reachable while scrolling Greeks and editing fixed inputs", async () => {
  await render({
    symbol: "COST:XNAS", side: "call", spot: "902.63", strike: "905", days: "14.1784",
    volatility: "0.269", rate: "0.04", marketPrice: "18.075", marketPriceSource: "mid",
    marketReference: JSON.stringify({ contractSymbol: "COST260925C00905000", expiration: 1790294400,
      currency: "USD", bid: 17.2, ask: 18.95, lastPrice: 18.67, lastTradeDate: 1789139450 }),
  }, 48, 16);
  expect(testSetup!.captureCharFrame()).toContain("COST260925C00905000");
  await emitKeypress(testSetup!, { name: "end", sequence: "\u001B[F" });
  const bottom = testSetup!.captureCharFrame();
  expect(bottom).toMatch(/Theta\s+-[\d.]+\s+per day/);
  expect(bottom).toMatch(/Vega\s+[\d.]+\s+per vol pt/);
  expect(bottom).toMatch(/Rho\s+[+\d.]+\s+per rate pt/);

  // Inputs stay reachable while the researcher reads the bottom of the results.
  await emitKeypress(testSetup!, { name: "tab", sequence: "\t" });
  await act(async () => { await testSetup!.mockInput.typeText("910"); testSetup!.mockInput.pressEnter(); });
  await act(async () => { await testSetup!.renderOnce(); });
  expect(testSetup!.captureCharFrame()).toMatch(/Spot\s+910/);
  await emitKeypress(testSetup!, { name: "escape", sequence: "\u001B" });
  await emitKeypress(testSetup!, { name: "home", sequence: "\u001B[H" });
  expect(testSetup!.captureCharFrame()).toContain("COST260925C00905000");
});

test("prices the seeded contract and solves its implied volatility", async () => {
  await render({
    symbol: "AAPL",
    side: "put",
    spot: "100",
    strike: "100",
    days: "365",
    rate: "0.05",
    volatility: "0.2",
    marketPrice: "5.5735",
  });

  const frame = testSetup!.captureCharFrame();
  expect(frame).toContain("AAPL");
  expect(frame).toContain("5.5735");
  // The seeded market price is exactly the model put value, so IV solves back to 20%.
  expect(frame).toMatch(/Implied IV\s+20\.00%/);
});

test("shows the remaining fraction of a day for a live near-expiry contract", async () => {
  await render({ days: "0.25" });
  const frame = testSetup!.captureCharFrame();
  expect(frame).toMatch(/Days\s+0\.25\s*d/);
  expect(frame).toMatch(/Implied IV\s+--/);
});

test("displays fractional strikes and spot prices without rounding them to whole dollars", async () => {
  await render({ spot: "217.987", strike: "217.5", marketPrice: "100.125", marketPriceSource: "mid" });
  const frame = testSetup!.captureCharFrame();
  expect(frame).toMatch(/Spot\s+217\.987/);
  expect(frame).toMatch(/Strike\s+217\.5/);
  expect(frame).toMatch(/Mid\s+100\.125/);
  expect(frame).toContain("per unit");
});

test("tabs into fields and edits them from the keyboard", async () => {
  await render();

  await act(async () => {
    testSetup!.mockInput.pressTab();
    await testSetup!.renderOnce();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await testSetup!.renderOnce();
    await testSetup!.renderOnce();
  });
  await act(async () => {
    await testSetup!.mockInput.typeText("120");
    testSetup!.mockInput.pressEnter();
    await testSetup!.renderOnce();
    await testSetup!.renderOnce();
  });

  expect(testSetup!.captureCharFrame()).toMatch(/Spot\s+120/);
});

test("model switching restores the cash schedule and reprices under the selected exercise rule", async () => {
  const params = { side: "put", spot: "100", strike: "100", days: "365", rate: "0.05", volatility: "0.2",
    model: "american", dividends: "30:1;120:1", steps: "100" };
  await render(params);
  const draft = draftFromParams(params);
  const american = valueBinomialOption(draft, { steps: 100, dividends: [{ days: 30, amount: 1 }, { days: 120, amount: 1 }] }).price.toFixed(4);
  expect(testSetup!.captureCharFrame()).toMatch(new RegExp(`Model\\s+${american.replace(".", "\\.")}`));
  await emitKeypress(testSetup!, { name: "m", sequence: "m" }, { afterCommit: true });
  expect(testSetup!.captureCharFrame()).toMatch(new RegExp(`Model\\s+${valueOption(draft).price.toFixed(4).replace(".", "\\.")}`));
  await emitKeypress(testSetup!, { name: "m", sequence: "m" }, { afterCommit: true });
  expect(testSetup!.captureCharFrame()).toMatch(new RegExp(`Model\\s+${american.replace(".", "\\.")}`));
  expect(testSetup!.captureCharFrame()).toContain("30:1;120:1");

  // Moving expiry ahead of a stored payment invalidates the American schedule.
  for (let i = 0; i < 3; i++) await emitKeypress(testSetup!, { name: "tab", sequence: "\t" });
  await act(async () => { await testSetup!.mockInput.typeText("10"); testSetup!.mockInput.pressEnter(); });
  await act(async () => { await testSetup!.renderOnce(); });
  expect(testSetup!.captureCharFrame()).toMatch(/Model\s+--/);
  await emitKeypress(testSetup!, { name: "escape", sequence: "\u001B" }, { afterCommit: true });
  await emitKeypress(testSetup!, { name: "m", sequence: "m" }, { afterCommit: true });
  expect(testSetup!.captureCharFrame()).toMatch(/Model\s+\d+\.\d+/);
});

test("surface selection without an underlying hides input-IV prices and recovers when input is selected", async () => {
  await render({ spot: "100", strike: "100", volatility: "0.2" });
  const before = testSetup!.captureCharFrame().match(/Model\s+(\d+\.\d+)/)?.[1];
  expect(before).toBeDefined();
  await emitKeypress(testSetup!, { name: "v", sequence: "v" }, { afterCommit: true });
  expect(testSetup!.captureCharFrame()).toMatch(/Fit IV\s+--/);
  expect(testSetup!.captureCharFrame()).toMatch(/Model\s+--/);
  await emitKeypress(testSetup!, { name: "escape", sequence: "\u001B" }, { afterCommit: true });
  await emitKeypress(testSetup!, { name: "v", sequence: "v" }, { afterCommit: true });
  expect(testSetup!.captureCharFrame().match(/Model\s+(\d+\.\d+)/)?.[1]).toBe(before);
});

test("an invalid seeded cash schedule stays editable and only blocks its active model", async () => {
  await render({ model: "american", dividends: "30:1;bad", days: "365" });
  expect(testSetup!.captureCharFrame()).toContain("30:1;bad");
  expect(testSetup!.captureCharFrame()).toMatch(/Model\s+--/);
  await emitKeypress(testSetup!, { name: "m", sequence: "m" }, { afterCommit: true });
  expect(testSetup!.captureCharFrame()).toMatch(/Model\s+\d+\.\d+/);
  await emitKeypress(testSetup!, { name: "m", sequence: "m" }, { afterCommit: true });
  expect(testSetup!.captureCharFrame()).toContain("30:1;bad");
  expect(testSetup!.captureCharFrame()).toMatch(/Model\s+--/);
});

test("a screenshot prices the frozen surface volatility instead of input IV or a new market request", async () => {
  const draft = { ...draftFromParams({ symbol: "AAPL", spot: "120", strike: "110", days: "365", volatility: "0.2" }), volSource: "surface" as const };
  const surface = { volatility: .35, rate: .04, dividendYield: .01, sourceSpot: 115, spotAsOf: Date.UTC(2026, 8, 22),
    asOf: "2026-09-22", rateAsOf: ["2026-09-21"], source: "OVDV midpoint", warnings: [], error: null };
  await render(undefined, 100, 20, { calculatorSnapshot: { draft, surface } });
  const frame = testSetup!.captureCharFrame();
  expect(frame).toMatch(/Fit IV\s+35\.0/);
  expect(frame).toMatch(/Spot\s+120/);
  const expected = valueOption({ ...draft, volatility: surface.volatility }).price.toFixed(4);
  expect(frame.match(/Model\s+(\d+\.\d+)/)?.[1]).toBe(expected);
});
