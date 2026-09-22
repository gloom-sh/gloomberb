import { afterEach, expect, spyOn, test } from "bun:test";
import { act, Profiler, useReducer } from "react";
import { apiClient } from "../../../api-client";
import { PaneFooterProvider } from "../../../components/layout/pane/footer";
import { MarketDataCoordinator, getSharedMarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { emitKeypress, testRender } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestPaneConfig, createTestTicker, TestPaneProvider } from "../../../test-support/pane";
import { createStatefulTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { OptionContract, OptionsChain, TickerFinancials } from "../../../types/financials";
import type { PaneTemplateCreateOptions } from "../../../types/plugin";
import { DEFAULT_OPTION_CALC_DRAFT, daysToExpiryFrom, valueOption } from "../options-calculator/model";
import { VolSurfacePane } from "./pane";

const PANE_ID = "vol-surface:interaction-test";
const SYMBOL = "VOLTEST";
const WIDTH = 112, HEIGHT = 26;
let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let coordinator: MarketDataCoordinator | undefined;
let previousCoordinator: ReturnType<typeof getSharedMarketDataCoordinator>;
let treasury: ReturnType<typeof spyOn<typeof apiClient, "getCloudYieldCurve">> | undefined;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function quotedChain(expirations: number[], expiration: number, now: number): OptionsChain {
  const quote = (strike: number, side: "call" | "put"): OptionContract => {
    const price = valueOption({ ...DEFAULT_OPTION_CALC_DRAFT, spot: 100, strike, side,
      daysToExpiry: daysToExpiryFrom(expiration, now), rate: 0.04, dividendYield: 0.01, volatility: 0.32 }).price;
    return { contractSymbol: `${SYMBOL}-${expiration}-${side}-${strike}`, expiration, strike, currency: "USD",
      bid: price * 0.99, ask: price * 1.01, lastPrice: price, impliedVolatility: 0.32, openInterest: 100,
      volume: 10, lastTradeDate: now / 1000 - 60, change: 0, percentChange: 0,
      inTheMoney: side === "call" ? strike < 100 : strike > 100 };
  };
  // No 105 strike: selecting the interpolated 105 cell must not borrow the
  // nearest 100 or 110 contract's market price when opening the pricer.
  const strikes = [75, 85, 95, 100, 110, 120, 130];
  return { underlyingSymbol: SYMBOL, expirationDates: expirations,
    calls: strikes.map((strike) => quote(strike, "call")), puts: strikes.map((strike) => quote(strike, "put")),
    dataSource: "delayed", delayMinutes: 15, asOf: new Date(now).toISOString() };
}

async function settle(frames = 7) {
  for (let frame = 0; frame < frames; frame += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await setup!.renderOnce();
    });
  }
}

async function mount({ missingSelection = false, holdSecond = false } = {}) {
  const now = Date.now();
  const date = new Date(now);
  const expirations = [45, 120].map((days) => Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days) / 1000);
  const held = deferred<OptionsChain>();
  const calls: (number | undefined)[] = [];
  const opened: { id: string; options: PaneTemplateCreateOptions | undefined }[] = [];
  let currentState!: AppState;
  let commits = 0;
  const financials: TickerFinancials = { quote: { symbol: SYMBOL, price: 100, currency: "USD",
    change: 0, changePercent: 0, lastUpdated: now, stale: false },
    annualStatements: [], quarterlyStatements: [], priceHistory: [] };
  const provider = createTestDataProvider({ id: "surface-pane-fixture",
    getTickerFinancials: async () => financials, getQuote: async () => financials.quote!,
    getOptionsChain: async (_symbol, _exchange, expiration) => {
      calls.push(expiration);
      return holdSecond && expiration === expirations[1] ? held.promise
        : quotedChain(expirations, expiration ?? expirations[0]!, now);
    },
  });
  previousCoordinator = getSharedMarketDataCoordinator();
  coordinator = new MarketDataCoordinator(provider);
  setSharedMarketDataCoordinator(coordinator);
  await coordinator.loadSnapshot({ symbol: SYMBOL, exchange: "NASDAQ" });
  treasury = spyOn(apiClient, "getCloudYieldCurve").mockResolvedValue([
    { maturity: "1M", maturityYears: 1 / 12, yield: 4, asOf: date.toISOString().slice(0, 10) },
    { maturity: "1Y", maturityYears: 1, yield: 4, asOf: date.toISOString().slice(0, 10) },
  ]);
  const absentExpiry = expirations[1]! + 7 * 86400;
  const config = createTestPaneConfig("/tmp/gloom-vol-surface-interaction-test", {
    instanceId: PANE_ID, paneId: "vol-surface", binding: { kind: "fixed", symbol: SYMBOL },
    ...(missingSelection ? { settings: { expiration: absentExpiry } } : {}),
  });
  config.chartPreferences.renderer = "braille";
  config.refreshIntervalMinutes = 0;
  const initial = createInitialState(config);
  initial.tickers.set(SYMBOL, createTestTicker(SYMBOL));
  initial.financials.set(SYMBOL, financials);
  initial.focusedPaneId = PANE_ID;
  const runtime = createStatefulTestPluginRuntime({ getMarketData: () => provider,
    createPaneFromTemplate: (id, options) => { opened.push({ id, options }); },
  });
  function Harness() {
    const [state, dispatch] = useReducer(appReducer, initial);
    currentState = state;
    return <TestPaneProvider state={state} dispatch={dispatch} paneId={PANE_ID} pluginId="ticker-research" runtime={runtime}>
      <Profiler id="surface" onRender={() => { commits += 1; }}>
        <PaneFooterProvider>{() => <VolSurfacePane focused width={WIDTH} height={HEIGHT} />}</PaneFooterProvider>
      </Profiler>
    </TestPaneProvider>;
  }
  await act(async () => { setup = await testRender(<Harness />, { width: WIDTH, height: HEIGHT }); });
  await settle();
  return { now, expirations, absentExpiry, calls, opened, get state() { return currentState; },
    get commits() { return commits; }, finishSecond: () => held.resolve(quotedChain(expirations, expirations[1]!, now)) };
}

afterEach(async () => {
  if (setup) await act(async () => setup!.renderer.destroy());
  setup = undefined;
  coordinator?.destroy(); coordinator = undefined;
  setSharedMarketDataCoordinator(previousCoordinator ?? null);
  treasury?.mockRestore(); treasury = undefined;
});

test("surface text fallback navigates cells and expiries and seeds the selected fitted contract", async () => {
  const context = await mount();
  await emitKeypress(setup!, { name: "right", sequence: "\u001b[C" }, { trackPropagation: true });
  await emitKeypress(setup!, { name: "down", sequence: "\u001b[B" }, { trackPropagation: true });
  await emitKeypress(setup!, { name: "p", sequence: "p" }, { trackPropagation: true });
  expect(context.opened).toHaveLength(1);
  const seed = context.opened[0]!;
  expect(seed.id).toBe("options-calculator-pane");
  const values = seed.options!.values!;
  expect(Number(values.strike)).toBe(105);
  expect(Number(values.days)).toBeCloseTo(daysToExpiryFrom(context.expirations[1]!, context.now), 3);
  expect(Number(values.rate)).toBeCloseTo(0.04, 9);
  expect(Number(values.dividendYield)).toBeCloseTo(0.01, 6);
  expect(Number(values.volatility)).toBeCloseTo(0.32, 4);
  expect(values.marketPrice).toBeUndefined();
  expect(context.calls).toHaveLength(2);
});

test("an explicitly saved missing expiry cannot silently seed a different expiry", async () => {
  const context = await mount({ missingSelection: true });
  await emitKeypress(setup!, { name: "p", sequence: "p" }, { trackPropagation: true });
  expect(context.opened).toEqual([]);
  expect(context.state.config.layout.instances[0]!.settings?.expiration).toBe(context.absentExpiry);
  // An explicit navigation choice restores a valid contract and enables pricing.
  await emitKeypress(setup!, { name: "]", sequence: "]" }, { trackPropagation: true });
  await emitKeypress(setup!, { name: "p", sequence: "p" }, { trackPropagation: true });
  expect(context.opened).toHaveLength(1);
  expect(Number(context.opened[0]!.options!.values!.days)).toBeCloseTo(daysToExpiryFrom(context.expirations[0]!, context.now), 3);
});

test("partial expiry progress settles without reloading or rendering indefinitely", async () => {
  const context = await mount({ holdSecond: true });
  expect(context.calls).toHaveLength(2);
  await emitKeypress(setup!, { name: "p", sequence: "p" }, { trackPropagation: true });
  expect(context.opened).toHaveLength(1);
  expect(Number(context.opened[0]!.options!.values!.days)).toBeCloseTo(daysToExpiryFrom(context.expirations[0]!, context.now), 3);
  const partialCommits = context.commits;
  await settle();
  expect(context.commits).toBe(partialCommits);
  await act(async () => { context.finishSecond(); });
  await settle();
  const completedCommits = context.commits;
  expect(completedCommits).toBeGreaterThan(partialCommits);
  await settle();
  expect(context.commits).toBe(completedCommits);
  expect(context.calls).toHaveLength(2);
});
