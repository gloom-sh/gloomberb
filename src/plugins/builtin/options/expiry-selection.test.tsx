import { afterEach, expect, test } from "bun:test";
import { act, useReducer } from "react";
import { CachedQuery } from "../../../data/cached-query";
import type { DataProvider } from "../../../types/data-provider";
import { Box } from "../../../ui";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { takeSavedTextFile, testRender } from "../../../renderers/opentui/test-utils";
import { exportPaneTable } from "../../../state/pane-table-export-registry";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { appReducer, createInitialState, type AppState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { TestPaneProvider, createTestTicker, createTestPaneConfig } from "../../../test-support/pane";
import type { OptionContract, OptionsChain, TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import { OptionsView } from "./view";
import { optionsModule } from "./index";
import { draftFromParams } from "../options-calculator/model";

const PANE_ID = "options:expiry-selection";
const EXPIRIES = [Date.UTC(2026, 8, 18), Date.UTC(2026, 9, 16), Date.UTC(2026, 10, 20)].map((ms) => ms / 1000);
const EXPIRY_CODES = ["260918", "261016", "261120"];
let setup: Awaited<ReturnType<typeof testRender>> | undefined;
const realNow = Date.now;

afterEach(async () => {
  if (setup) await act(async () => setup!.renderer.destroy());
  setup = undefined;
  setSharedMarketDataCoordinator(null);
  Date.now = realNow;
});

async function settle() {
  for (let i = 0; i < 4; i += 1) await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await setup!.renderOnce();
  });
}

async function fixture(width = 80, heldExpiry = 0, cached = false, delayedSeed?: number) {
  let now = Date.UTC(2026, 8, 17, 16);
  Date.now = () => now;
  let catalogue = [...EXPIRIES];
  const requests: Array<{ symbol: string; expiration: number | undefined }> = [];
  const launches: ReturnType<typeof draftFromParams>[] = [];
  const pending = new Map<number, Promise<OptionsChain>>();
  let wrongExpiry: number | undefined;
  let failure = false;
  const makeContract = (symbol: string, expiration: number, side: "C" | "P"): OptionContract => {
    const index = EXPIRIES.indexOf(expiration);
    return {
      contractSymbol: `${symbol}${EXPIRY_CODES[index]}${side}00340000`, strike: 340, currency: "USD",
      lastPrice: 10 + index * 10, change: 0, percentChange: 0, volume: 123, openInterest: 456,
      bid: 9 + index * 10, ask: 11 + index * 10, impliedVolatility: 0.25,
      inTheMoney: side === "P", expiration, lastTradeDate: now / 1000, lastUpdated: now,
    };
  };
  const chain = (symbol: string, expiration: number): OptionsChain => ({
    underlyingSymbol: symbol, expirationDates: [...catalogue],
    calls: [makeContract(symbol, expiration, "C")], puts: [makeContract(symbol, expiration, "P")],
  });
  const financials = (symbol: string): TickerFinancials => ({
    quote: { symbol, price: 330, currency: "USD", change: 0, changePercent: 0, lastUpdated: now, stale: false },
    annualStatements: [], quarterlyStatements: [], priceHistory: [],
  });
  const provider = createTestDataProvider({
    getTickerFinancials: async (symbol) => financials(symbol),
    getQuote: async (symbol) => financials(symbol).quote!,
    getOptionsChain: async (symbol, _exchange, expiration) => {
      requests.push({ symbol, expiration });
      if (failure) throw new Error("Options source offline");
      return expiration != null && pending.has(expiration)
        ? pending.get(expiration)! : chain(symbol, wrongExpiry ?? expiration ?? catalogue[0]!);
    },
  });
  if (cached) {
    const queries = new Map<string, CachedQuery<OptionsChain>>();
    provider.getCachedQuery = ((method, args) => {
      if (method !== "getOptionsChain") return undefined;
      const [symbol, exchange, expiration] = args as [string, string, number | undefined];
      const key = `${symbol}:${expiration ?? "default"}`;
      if (!queries.has(key)) queries.set(key, new CachedQuery({ read: () => null, fetch: async () => ({
        value: await provider.getOptionsChain!(symbol, exchange, expiration), fetchedAt: now,
        staleAt: now + 600_000, expiresAt: now + 3_600_000, source: "test-cache",
      }) }));
      return queries.get(key);
    }) as DataProvider["getCachedQuery"];
  }
  const coordinator = new MarketDataCoordinator(provider);
  setSharedMarketDataCoordinator(coordinator);
  const ticker = (symbol: string, expiry: number) => createTestTicker(`${symbol} ${EXPIRY_CODES[expiry]}C00340000`, symbol, {
    assetCategory: "OPT", positions: [{ portfolio: "fixture", shares: 1, side: "short", avgCost: 5, broker: "manual", multiplier: 100 }],
  });
  await coordinator.loadSnapshot({ symbol: "AAPL", exchange: "" });
  let switchTicker: (ticker: TickerRecord) => void = () => {};
  let seedExpiration: (expiration: number) => void = () => {};
  let currentState: AppState;
  const initialTicker = ticker("AAPL", heldExpiry);
  const config = createTestPaneConfig("/tmp/options-expiry-test", {
    instanceId: PANE_ID, paneId: "options", binding: { kind: "fixed", symbol: initialTicker.metadata.ticker },
    ...(delayedSeed == null ? {} : { settings: { expiration: delayedSeed } }),
  });
  const initial = createInitialState(config);
  initial.focusedPaneId = PANE_ID;
  initial.tickers = delayedSeed == null ? new Map([[initialTicker.metadata.ticker, initialTicker]]) : new Map();
  const runtime = createTestPluginRuntime({
    createPaneFromTemplate: (_id, options) => { launches.push(draftFromParams(options?.values)); },
  });
  function Harness() {
    const [state, dispatch] = useReducer(appReducer, currentState ?? initial);
    currentState = state;
    switchTicker = (selected) => {
      dispatch({ type: "SET_TICKERS", tickers: new Map([[selected.metadata.ticker, selected]]) });
      dispatch({ type: "UPDATE_LAYOUT", layout: { ...state.config.layout,
        instances: state.config.layout.instances.map((instance) => ({ ...instance,
          binding: { kind: "fixed", symbol: selected.metadata.ticker } })) } });
    };
    seedExpiration = (expiration) => {
      const pane = state.config.layout.instances[0]!;
      const symbol = pane.binding?.kind === "fixed" ? pane.binding.symbol : "AAPL";
      const incoming = optionsModule.paneTemplates![0]!.createInstance({
        config: state.config, layout: state.config.layout, focusedPaneId: PANE_ID,
        activeTicker: symbol, activeCollectionId: null,
      }, { symbol, values: { expiration: String(expiration) } })!;
      dispatch({ type: "UPDATE_LAYOUT", layout: { ...state.config.layout,
        instances: [{ ...pane, settings: { ...pane.settings, ...incoming.settings } }] } });
    };
    return <TestPaneProvider state={state} dispatch={dispatch} paneId={PANE_ID} pluginId="ticker-research" runtime={runtime}>
      <PaneFooterProvider>{(footer) => <Box width={width} height={18} flexDirection="column">
        <Box width={width} height={17}><OptionsView width={width} height={17} focused /></Box>
        <PaneFooterBar footer={footer} focused width={width} />
      </Box>}</PaneFooterProvider>
    </TestPaneProvider>;
  }
  await act(async () => { setup = await testRender(<Harness />, { width, height: 18 }); });
  await settle();
  async function key(key: "enter" | "left" | "right" | "c") {
    await act(async () => {
      if (key === "enter") setup!.mockInput.pressEnter();
      else if (key === "left" || key === "right") setup!.mockInput.pressArrow(key);
      else setup!.mockInput.pressKey(key);
    });
    await settle();
  }
  async function capture(label: string) {
    const count = launches.length;
    await key("c");
    await exportPaneTable(PANE_ID, `${label}.csv`);
    const csv = takeSavedTextFile()?.text ?? "";
    const frame = setup!.captureCharFrame();
    const result = { frame, csv, launch: launches.length > count ? launches.at(-1) : undefined, requests: [...requests] };
    const evidence = process.env.OPTIONS_EXPIRY_EVIDENCE;
    if (evidence) {
      await Bun.write(`${evidence}/${width}-${label}.txt`, frame);
      await Bun.write(`${evidence}/${width}-${label}.csv`, csv);
      await Bun.write(`${evidence}/${width}-${label}.json`, JSON.stringify(result, null, 2));
    }
    return result;
  }
  async function refresh(dates: number[], expiration?: number, advanceClock = true) {
    catalogue = dates;
    if (advanceClock) now += 1_000;
    await act(async () => { await coordinator.loadOptions({ instrument: { symbol: "AAPL", exchange: "" }, expirationDate: expiration }, { forceRefresh: true }); });
    await settle();
  }
  const request = (expiration?: number) => ({ instrument: { symbol: "AAPL", exchange: "" }, expirationDate: expiration });
  return { capture, key, refresh, pending, chain, requests,
    get state() { return currentState; },
    async handoff(expiration: number) { await act(async () => seedExpiration(expiration)); await settle(); },
    async hydrateTicker() { await act(async () => switchTicker(initialTicker)); await settle(); },
    setFailure: (value: boolean) => { failure = value; },
    async reread(expiration?: number) {
      await act(async () => { await coordinator.loadOptions(request(expiration)); }); await settle();
    },
    async batch(selected: number[], initial: number[]) {
      await act(async () => {
        catalogue = selected;
        await coordinator.loadOptions(request(EXPIRIES[1]), { forceRefresh: true });
        catalogue = initial;
        await coordinator.loadOptions(request(), { forceRefresh: true });
      }); await settle();
    },
    async remount() {
      await act(async () => setup!.renderer.destroy());
      await act(async () => { setup = await testRender(<Harness />, { width, height: 18 }); }); await settle();
    },
    setWrongExpiry: (expiration: number | undefined) => { wrongExpiry = expiration; },
    async switchUnderlying() {
      await coordinator.loadSnapshot({ symbol: "MSFT", exchange: "" });
      await act(async () => switchTicker(ticker("MSFT", 1)));
      await settle();
    },
  };
}

test.each([48, 80, 120])("retains a chosen expiry across unchanged, reordered and shortened catalogues at %i columns", async (width) => {
  const f = await fixture(width);
  await f.key("enter"); await f.key("right");
  for (const [label, catalogue] of [
    ["chosen", EXPIRIES], ["reordered", [EXPIRIES[2]!, EXPIRIES[0]!, EXPIRIES[1]!]], ["prior-removed", EXPIRIES.slice(1)],
  ] as const) {
    await f.refresh([...catalogue]);
    const result = await f.capture(label);
    expect(result.launch?.marketReference?.expiration).toBe(EXPIRIES[1]);
    expect(result.launch?.marketPrice).toBe(20);
    expect(result.csv).toContain("19,21,10.0%,20");
    expect(result.frame).not.toContain("AAPL261120");
  }
});

test("selected-chain refresh uses the same date identities for the catalogue, table and navigation", async () => {
  const f = await fixture(); await f.key("enter"); await f.key("right");
  await f.refresh(EXPIRIES.slice(1), EXPIRIES[1]);
  const selected = await f.capture("selected-query-refresh");
  expect(selected.launch?.marketReference?.expiration).toBe(EXPIRIES[1]);
  await f.key("right");
  expect((await f.capture("next-after-refresh")).launch?.marketReference?.expiration).toBe(EXPIRIES[2]);
});

test.each([48, 80, 120])("a removed selected expiry cannot seed another contract and can recover at %i columns", async (width) => {
  const f = await fixture(width); await f.key("enter"); await f.key("right");
  await f.refresh([EXPIRIES[0]!, EXPIRIES[2]!]);
  const missing = await f.capture("selected-removed");
  expect(missing.launch).toBeUndefined();
  expect(missing.frame).toContain("Selected expiration unavailable.");
  expect(missing.csv.split("\n")).toHaveLength(1);
  await f.refresh(EXPIRIES);
  const recovered = await f.capture("selected-recovered");
  expect(recovered.launch?.marketReference?.expiration).toBe(EXPIRIES[1]);
  expect(recovered.frame).not.toContain("Selected expiration unavailable.");
});

test("a new underlying initializes its held expiry after a researcher chose another date", async () => {
  const f = await fixture(80, 1);
  expect((await f.capture("held-initial")).launch?.marketReference?.expiration).toBe(EXPIRIES[1]);
  await f.key("enter"); await f.key("right");
  expect((await f.capture("held-roll")).launch?.marketReference?.expiration).toBe(EXPIRIES[2]);
  await f.switchUnderlying();
  const changed = await f.capture("new-underlying");
  expect(changed.launch?.symbol).toBe("MSFT");
  expect(changed.launch?.marketReference?.expiration).toBe(EXPIRIES[1]);
  expect(changed.frame).not.toContain("AAPL");
});

test("repeated surface handoffs override persisted local choices without resetting ordinary selection", async () => {
  const f = await fixture();
  await f.handoff(EXPIRIES[1]!);
  expect((await f.capture("first-handoff")).launch?.marketReference?.expiration).toBe(EXPIRIES[1]);
  await f.key("enter"); await f.key("right");
  expect(f.state.config.layout.instances[0]!.settings?.expiration).toBe(EXPIRIES[2]);
  await f.refresh(EXPIRIES);
  expect((await f.capture("local-after-handoff")).launch?.marketReference?.expiration).toBe(EXPIRIES[2]);
  await f.remount();
  expect((await f.capture("persisted-local-choice")).launch?.marketReference?.expiration).toBe(EXPIRIES[2]);
  await f.handoff(EXPIRIES[1]!);
  expect((await f.capture("repeated-handoff")).launch?.marketReference?.expiration).toBe(EXPIRIES[1]);
  await f.handoff(EXPIRIES[0]!);
  expect((await f.capture("changed-handoff")).launch?.marketReference?.expiration).toBe(EXPIRIES[0]);
  await f.switchUnderlying();
  expect((await f.capture("handoff-target-changed")).launch?.marketReference?.expiration).toBe(EXPIRIES[1]);
});

test("a saved surface seed waits for ticker hydration before claiming its instrument scope", async () => {
  const f = await fixture(80, 0, false, EXPIRIES[2]);
  expect(f.state.config.layout.instances[0]!.settings?.expirationTargetKey).toBeUndefined();
  await f.hydrateTicker();
  expect((await f.capture("hydrated-handoff")).launch?.marketReference?.expiration).toBe(EXPIRIES[2]);
  expect(f.state.config.layout.instances[0]!.settings?.expirationTargetKey).toContain("AAPL");
});

test("late and wrong-expiry responses cannot replace a newly selected contract", async () => {
  const f = await fixture();
  let finish: (chain: OptionsChain) => void = () => {};
  f.pending.set(EXPIRIES[1]!, new Promise((resolve) => { finish = resolve; }));
  await f.key("enter"); await f.key("right");
  const loading = await f.capture("cold-expiry");
  expect(loading.launch).toBeUndefined();
  expect(loading.csv.split("\n")).toHaveLength(1);
  await f.key("right");
  expect((await f.capture("newer-selection")).launch?.marketReference?.expiration).toBe(EXPIRIES[2]);
  await act(async () => finish(f.chain("AAPL", EXPIRIES[1]!))); await settle();
  expect((await f.capture("late-response")).launch?.marketReference?.expiration).toBe(EXPIRIES[2]);
  f.setWrongExpiry(EXPIRIES[1]);
  await f.refresh(EXPIRIES, EXPIRIES[2]);
  const wrong = await f.capture("wrong-expiry");
  expect(wrong.launch).toBeUndefined();
  expect(wrong.frame).toContain("Selected expiration unavailable.");
  expect(wrong.csv.split("\n")).toHaveLength(1);
});


test("same-millisecond catalogue refresh retains a removed selection as unavailable", async () => {
  const f = await fixture(); await f.key("enter"); await f.key("right");
  await f.refresh([EXPIRIES[0]!, EXPIRIES[2]!], undefined, false);
  const removed = await f.capture("equal-time-removal");
  expect(removed.launch).toBeUndefined();
  expect(removed.frame).toContain("Selected expiration unavailable.");
  await f.refresh(EXPIRIES, undefined, false);
  expect((await f.capture("equal-time-recovery")).launch?.marketReference?.expiration).toBe(EXPIRIES[1]);
});

test("visiting a cached expiry cannot restore an older catalogue, and an empty refresh disables the selected contract", async () => {
  const f = await fixture(); await f.key("enter"); await f.key("right"); await f.key("right");
  await f.key("left");
  await f.refresh(EXPIRIES.slice(1), EXPIRIES[1]);
  await f.key("right");
  const cached = await f.capture("cached-expiry");
  expect(cached.launch?.marketReference?.expiration).toBe(EXPIRIES[2]);
  expect(cached.frame).not.toContain("Sep 18 '26");
  await f.refresh([], EXPIRIES[2]);
  const empty = await f.capture("empty-catalogue");
  expect(empty.launch).toBeUndefined();
  expect(empty.frame).toContain("Selected expiration unavailable.");
  expect(empty.csv.split("\n")).toHaveLength(1);
});


test("the existing expiry selector can leave an unavailable date for an explicitly chosen contract", async () => {
  const f = await fixture(); await f.key("enter"); await f.key("right");
  await f.refresh([EXPIRIES[0]!, EXPIRIES[2]!]);
  expect((await f.capture("explicit-selection-before")).launch).toBeUndefined();
  await f.key("right");
  const selected = await f.capture("explicit-selection-after");
  expect(selected.launch?.marketReference?.expiration).toBe(EXPIRIES[2]);
  expect(selected.launch?.marketPrice).toBe(30);
  expect(selected.frame).not.toContain("Selected expiration unavailable.");
});


test("an ordinary CachedQuery read cannot revive an expiry removed by a later same-time response", async () => {
  const f = await fixture(80, 0, true); await f.key("enter"); await f.key("right");
  await f.refresh([EXPIRIES[0]!, EXPIRIES[2]!], undefined, false);
  expect((await f.capture("cached-read-removed")).launch).toBeUndefined();
  const calls = f.requests.length;
  await f.reread(EXPIRIES[1]);
  const read = await f.capture("cached-read-retained");
  expect(f.requests).toHaveLength(calls);
  expect(read.launch).toBeUndefined();
  expect(read.csv.split("\n")).toHaveLength(1);
});

test.each([false, true])("batched equal-time responses honor completion order with cached provider %s", async (cached) => {
  const f = await fixture(80, 0, cached); await f.key("enter"); await f.key("right");
  await f.batch(EXPIRIES, [EXPIRIES[0]!, EXPIRIES[2]!]);
  const removed = await f.capture(`batch-${cached}`);
  expect(removed.launch).toBeUndefined();
  expect(removed.csv.split("\n")).toHaveLength(1);
  await f.refresh(EXPIRIES, EXPIRIES[1], false);
  expect((await f.capture(`batch-recovered-${cached}`)).launch?.marketReference?.expiration).toBe(EXPIRIES[1]);
});

test.each([false, true])("empty and removed catalogues survive failed refreshes and remount with cached provider %s", async (cached) => {
  const f = await fixture(80, 1, cached);
  expect((await f.capture(`remount-chosen-${cached}`)).launch?.marketReference?.expiration).toBe(EXPIRIES[1]);
  for (const [label, dates] of [["removed", [EXPIRIES[0]!, EXPIRIES[2]!]], ["empty", []]] as const) {
    f.setFailure(false);
    await f.refresh([...dates], EXPIRIES[1]);
    f.setFailure(true);
    await f.refresh(EXPIRIES, EXPIRIES[1]);
    await f.refresh(EXPIRIES);
    await f.remount();
    const remounted = await f.capture(`remount-${label}-${cached}`);
    expect(remounted.launch).toBeUndefined();
    expect(remounted.csv.split("\n")).toHaveLength(1);
    expect(remounted.frame).toContain("Selected expiration unavailable.");
  }
});
