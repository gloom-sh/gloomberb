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
import { selectSurfaceExpiries } from "./client";

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

async function mount({ missingSelection = false, holdSecond = false, pinnedSelection = false, optionTicker = false } = {}) {
  const now = Date.now();
  const date = new Date(now);
  const expirations = (pinnedSelection ? Array.from({ length: 40 }, (_, index) => index + 1) : [45, 120])
    .map((days) => Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days) / 1000);
  const sample = selectSurfaceExpiries(expirations, 18, now);
  const pins = expirations.filter((expiration) => !sample.includes(expiration));
  const paneSymbol = optionTicker ? `${SYMBOL} ${new Date(expirations[0]! * 1000).toISOString().slice(2, 10).replaceAll("-", "")}C00100000` : SYMBOL;
  const held = deferred<OptionsChain>();
  const calls: (number | undefined)[] = [];
  const opened: { id: string; options: PaneTemplateCreateOptions | undefined }[] = [];
  let currentState!: AppState;
  let changeExpiration: (expiration: number) => void = () => {};
  let commits = 0;
  const financials: TickerFinancials = { quote: { symbol: SYMBOL, price: 100, currency: "USD",
    change: 0, changePercent: 0, lastUpdated: now, stale: false },
    annualStatements: [], quarterlyStatements: [], priceHistory: [] };
  const paneFinancials = optionTicker ? { ...financials, quote: { ...financials.quote!, symbol: paneSymbol, price: 5 } } : financials;
  const provider = createTestDataProvider({ id: "surface-pane-fixture",
    getTickerFinancials: async (symbol) => symbol === paneSymbol ? paneFinancials : financials,
    getQuote: async (symbol) => symbol === paneSymbol ? paneFinancials.quote! : financials.quote!,
    getOptionsChain: async (_symbol, _exchange, expiration) => {
      calls.push(expiration);
      return holdSecond && expiration === expirations[1] ? held.promise
        : quotedChain(expirations, expiration ?? expirations[0]!, now);
    },
  });
  previousCoordinator = getSharedMarketDataCoordinator();
  coordinator = new MarketDataCoordinator(provider);
  setSharedMarketDataCoordinator(coordinator);
  await coordinator.loadSnapshot({ symbol: SYMBOL, exchange: optionTicker ? "" : "NASDAQ" });
  treasury = spyOn(apiClient, "getCloudYieldCurve").mockResolvedValue([
    { maturity: "1M", maturityYears: 1 / 12, yield: 4, asOf: date.toISOString().slice(0, 10) },
    { maturity: "1Y", maturityYears: 1, yield: 4, asOf: date.toISOString().slice(0, 10) },
  ]);
  const absentExpiry = expirations[1]! + 7 * 86400;
  const config = createTestPaneConfig("/tmp/gloom-vol-surface-interaction-test", {
    instanceId: PANE_ID, paneId: "vol-surface", binding: { kind: "fixed", symbol: paneSymbol },
    ...(missingSelection || pinnedSelection ? { settings: { expiration: missingSelection ? absentExpiry : pins[0] } } : {}),
  });
  config.chartPreferences.renderer = "braille";
  config.refreshIntervalMinutes = 0;
  const initial = createInitialState(config);
  initial.tickers.set(paneSymbol, createTestTicker(paneSymbol, paneSymbol, {
    exchange: "NASDAQ", currency: "USD", assetCategory: optionTicker ? "OPT" : "STK",
  }));
  initial.financials.set(paneSymbol, paneFinancials);
  initial.focusedPaneId = PANE_ID;
  const runtime = createStatefulTestPluginRuntime({ getMarketData: () => provider,
    createPaneFromTemplate: (id, options) => { opened.push({ id, options }); },
  });
  function Harness() {
    const [state, dispatch] = useReducer(appReducer, initial);
    currentState = state;
    changeExpiration = (expiration) => dispatch({ type: "UPDATE_LAYOUT", layout: { ...state.config.layout,
      instances: state.config.layout.instances.map((instance) => instance.instanceId === PANE_ID
        ? { ...instance, settings: { ...instance.settings, expiration } } : instance) } });
    return <TestPaneProvider state={state} dispatch={dispatch} paneId={PANE_ID} pluginId="ticker-research" runtime={runtime}>
      <Profiler id="surface" onRender={() => { commits += 1; }}>
        <PaneFooterProvider>{() => <VolSurfacePane focused width={WIDTH} height={HEIGHT} />}</PaneFooterProvider>
      </Profiler>
    </TestPaneProvider>;
  }
  await act(async () => { setup = await testRender(<Harness />, { width: WIDTH, height: HEIGHT }); });
  await settle();
  return { now, expirations, absentExpiry, pins, paneSymbol, calls, opened, changeExpiration: (value: number) => changeExpiration(value), get state() { return currentState; },
    get commits() { return commits; }, finishSecond: () => held.resolve(quotedChain(expirations, expirations[1]!, now)) };
}

afterEach(async () => {
  if (setup) await act(async () => setup!.renderer.destroy());
  setup = undefined;
  coordinator?.destroy(); coordinator = undefined;
  setSharedMarketDataCoordinator(previousCoordinator ?? null);
  treasury?.mockRestore(); treasury = undefined;
});

test("a pinned unsampled expiry survives handback and loaded selections do not restart the surface", async () => {
  const context = await mount({ pinnedSelection: true });
  await emitKeypress(setup!, { name: "c", sequence: "c" }, { trackPropagation: true });
  expect(context.opened.at(-1)).toMatchObject({ id: "options-pane", options: {
    symbol: SYMBOL, values: { expiration: String(context.pins[0]) }, listing: { exchange: "NASDAQ", currency: "USD" },
    ticker: { metadata: { ticker: SYMBOL } },
  } });
  expect(context.calls.filter((value) => value === context.pins[0])).toHaveLength(1);
  expect(treasury).toHaveBeenCalledTimes(1);
  await act(async () => { context.changeExpiration(context.pins[1]!); });
  await settle();
  expect(context.calls.filter((value) => value === context.pins[1])).toHaveLength(1);
  expect(treasury).toHaveBeenCalledTimes(2);
  await act(async () => { context.changeExpiration(context.expirations[0]!); });
  await settle();
  expect(treasury).toHaveBeenCalledTimes(2);
  const completedCommits = context.commits;
  await settle();
  expect(context.commits).toBe(completedCommits);
  await emitKeypress(setup!, { name: "c", sequence: "c" }, { trackPropagation: true });
  expect(context.opened.at(-1)!.options!.values!.expiration).toBe(String(context.expirations[0]));
});

test("an option holding uses its underlying spot and retains its original scope on handback", async () => {
  const context = await mount({ optionTicker: true });
  await emitKeypress(setup!, { name: "p", sequence: "p" }, { trackPropagation: true });
  expect(context.opened.at(-1)!.options!.values!.spot).toBe("100");
  await emitKeypress(setup!, { name: "c", sequence: "c" }, { trackPropagation: true });
  expect(context.opened.at(-1)!.options).toMatchObject({ symbol: context.paneSymbol,
    ticker: { metadata: { ticker: context.paneSymbol, assetCategory: "OPT" } },
    values: { expiration: String(context.expirations[0]) },
  });
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

test("a missing handoff after loading warns and cannot reuse the previous selected contract", async () => {
  const context = await mount();
  await act(async () => context.changeExpiration(context.absentExpiry));
  await settle();
  expect(treasury).toHaveBeenCalledTimes(1);
  await emitKeypress(setup!, { name: "p", sequence: "p" }, { trackPropagation: true });
  expect(context.opened).toEqual([]);
  await emitKeypress(setup!, { name: "c", sequence: "c" }, { trackPropagation: true });
  expect(context.opened.at(-1)!.options!.values!.expiration).toBe(String(context.absentExpiry));
  await emitKeypress(setup!, { name: "!", sequence: "!" }, { trackPropagation: true });
  await settle();
  expect(setup!.captureCharFrame()).toContain("selected expiration unavailable");
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
