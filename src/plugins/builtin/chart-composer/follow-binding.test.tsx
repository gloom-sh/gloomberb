import { afterEach, expect, test } from "bun:test";
import { act, useReducer, type Dispatch } from "react";
import { Text } from "../../../ui";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState, appReducer, type AppAction, type AppState } from "../../../state/app/context";
import { TestPaneProvider, createTestTicker } from "../../../test-support/pane";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createBrowserConfigStore, BROWSER_RESEARCH_CHART_ID as chartId, BROWSER_RESEARCH_PANE_ID as researchId } from "../../../renderers/browser/config-host";
import { setConfigStoreHost } from "../../../data/config/store";
import { flushPendingPersistence } from "../../../state/persist-scheduler";
import { getPaneDisplayTitle } from "../../../components/layout/pane/title";
import { updatePaneInstance } from "../../../pane-settings";
import { findPaneInstance, type AppConfig } from "../../../types/config";
import type { InstrumentRef } from "../../../market-data/request-types";
import { ChartComposerPane } from "./pane";
import { buildComparisonChartPreset, buildCustomChartPreset, buildPriceChartPreset } from "./presets";
import { CHART_FOLLOW_SERIES_SETTING_KEY, rebindFollowChartSpec, resolveFollowSeriesIds } from "./follow-binding";

const tui = createOpenTuiTestHarness();
let latest: AppState;
let dispatch: Dispatch<AppAction>;
afterEach(async () => {
  await flushPendingPersistence();
  setConfigStoreHost(null);
});

function store() {
  const data = new Map<string, string>();
  return createBrowserConfigStore({ getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } }, "?ticker=BTC-USD%3ACCC");
}

async function mount(config: AppConfig, requests: string[], contracts: number[] = []) {
  const history = [10, 1].map(days => ({ date: new Date(Date.now() - days * 86_400_000), close: 100 + days, volume: 100 }));
  const provider = createTestDataProvider({
    getTickerFinancials: async () => ({ annualStatements: [], quarterlyStatements: [], priceHistory: [] }),
    getPriceHistoryForResolution: async (symbol, exchange, _range, _resolution, context) => {
      requests.push(`${symbol}:${exchange}`);
      if (context?.instrument?.conId) contracts.push(context.instrument.conId);
      return history;
    },
  });
  const runtime = createTestPluginRuntime({ getMarketData: () => provider });
  function Harness() {
    [latest, dispatch] = useReducer(appReducer, config, createInitialState);
    const pane = findPaneInstance(latest.config.layout, chartId)!;
    return <TestPaneProvider state={latest} dispatch={dispatch} paneId={chartId} pluginId="ticker-research" runtime={runtime}>
      <Text>{getPaneDisplayTitle(latest, pane, { id: "chart-composer", name: "Chart", component: () => null, defaultPosition: "right" })}</Text>
      <ChartComposerPane paneId={chartId} paneType="chart-composer" focused width={110} height={25} />
    </TestPaneProvider>;
  }
  await tui.render(<Harness />, { width: 110, height: 28 });
}

async function settle(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    await act(async () => { await Bun.sleep(1); await tui.setup().renderOnce(); });
    if (predicate()) return;
  }
  throw new Error(`Chart did not settle: ${tui.frame()}`);
}

test("follow chart retains range while switching BTC to SHOP, including saved reload and stale saved primary", async () => {
  const host = store(); setConfigStoreHost(host);
  const config = await host.loadConfig("browser://local");
  const requests: string[] = [];
  await mount(config, requests);
  await settle(() => requests.includes("BTC-USD:CCC"));
  // The chart's own keyboard range control persists the formerly implicit spec.
  await tui.emitKeypress({ name: "3", sequence: "3" });
  await settle(() => (findPaneInstance(latest.config.layout, chartId)?.settings?.chartSpec as any)?.viewport.range === "1M");
  const oldSettings = structuredClone(findPaneInstance(latest.config.layout, chartId)!.settings);
  const layout = updatePaneInstance(latest.config.layout, researchId, pane => ({ ...pane, binding: { kind: "fixed", symbol: "SHOP:XNAS" } }));
  await act(async () => dispatch({ type: "SET_CONFIG", config: { ...latest.config, layout } }));
  await settle(() => requests.includes("SHOP:NASDAQ") && tui.frame().includes("SHOP:XNAS Price"));
  expect(tui.frame()).toContain("Chart: SHOP:XNAS");
  expect(tui.frame()).not.toContain("BTC-USD:CCC Price");
  const selected = findPaneInstance(latest.config.layout, chartId)!.settings!.chartSpec as any;
  expect(selected.viewport.range).toBe("1M");
  expect(selected.studies).toEqual((oldSettings!.chartSpec as any).studies);
  await flushPendingPersistence();
  const restored = await host.loadConfig("browser://local");
  await tui.destroy();
  requests.length = 0;
  await mount(restored, requests);
  await settle(() => requests.includes("SHOP:NASDAQ"));
  expect(requests).not.toContain("BTC-USD:CCC");
  await tui.destroy();
  // Repair an existing saved mismatch on mount, before any BTC request.
  const staleLayout = updatePaneInstance(restored.layout, chartId, pane => ({ ...pane, settings: oldSettings }));
  requests.length = 0;
  await mount({ ...restored, layout: staleLayout }, requests);
  await settle(() => requests.includes("SHOP:NASDAQ"));
  expect(requests).not.toContain("BTC-USD:CCC");
});

// Each device has its own list cursor, so a follower's saved spec synced in from another device
// names that device's ticker. Saving the local rebind would push it back, and two devices would
// rewrite each other on every sync.
test("a follower shows a synced-in spec rebound to its own target without saving it, until unlinked", async () => {
  const host = store(); setConfigStoreHost(host);
  const config = await host.loadConfig("browser://local");
  const requests: string[] = [];
  await mount(config, requests);
  await settle(() => requests.includes("BTC-USD:CCC") && Boolean(findPaneInstance(latest.config.layout, chartId)?.settings?.chartSpec));
  const settings = findPaneInstance(latest.config.layout, chartId)!.settings!;
  const pulled = rebindFollowChartSpec(settings.chartSpec as any, null, { symbol: "SHOP", exchange: "NASDAQ" });
  const synced = updatePaneInstance(latest.config.layout, chartId, pane => ({ ...pane, settings: { ...settings, chartSpec: pulled } }));
  requests.length = 0;
  await act(async () => dispatch({ type: "SET_CONFIG", config: { ...latest.config, layout: synced } }));
  for (let i = 0; i < 5; i++) await act(async () => { await Bun.sleep(1); await tui.setup().renderOnce(); });
  expect(tui.frame()).toContain("BTC-USD:CCC Price");
  expect(requests).not.toContain("SHOP:NASDAQ");
  expect(findPaneInstance(latest.config.layout, chartId)!.settings!.chartSpec).toEqual(pulled);

  const unlinked = updatePaneInstance(latest.config.layout, chartId, pane => ({ ...pane, binding: { kind: "fixed", symbol: "BTC-USD:CCC" } }));
  await act(async () => dispatch({ type: "SET_CONFIG", config: { ...latest.config, layout: unlinked } }));
  await settle(() => (findPaneInstance(latest.config.layout, chartId)?.settings?.chartSpec as any)?.series[0].source.instrument.symbol === "BTC-USD");
  expect(requests).not.toContain("SHOP:NASDAQ");
});

// Unlinking pins what was shown, but only an unlink: a fixed binding on another ticker arriving
// through sync or an undo carries its own saved spec, and rewriting it would save one ticker's
// data under another's title on every device.
test("another device's unlink on its own ticker keeps the synced spec", async () => {
  const host = store(); setConfigStoreHost(host);
  const config = await host.loadConfig("browser://local");
  const requests: string[] = [];
  await mount(config, requests);
  await settle(() => requests.includes("BTC-USD:CCC") && Boolean(findPaneInstance(latest.config.layout, chartId)?.settings?.chartSpec));
  const settings = findPaneInstance(latest.config.layout, chartId)!.settings!;
  const pulled = rebindFollowChartSpec(settings.chartSpec as any, null, { symbol: "SHOP", exchange: "NASDAQ" });
  const synced = updatePaneInstance(latest.config.layout, chartId, pane => ({ ...pane, settings: { ...settings, chartSpec: pulled } }));
  await act(async () => dispatch({ type: "SET_CONFIG", config: { ...latest.config, layout: synced } }));
  await settle(() => tui.frame().includes("BTC-USD:CCC Price"));
  const unlinked = updatePaneInstance(latest.config.layout, chartId, pane => ({ ...pane, binding: { kind: "fixed", symbol: "SHOP:XNAS" } }));
  await act(async () => dispatch({ type: "SET_CONFIG", config: { ...latest.config, layout: unlinked } }));
  await settle(() => requests.includes("SHOP:NASDAQ"));
  expect(tui.frame()).not.toContain("BTC-USD:CCC Price");
  expect(findPaneInstance(latest.config.layout, chartId)!.settings!.chartSpec).toEqual(pulled);
});

test("an undo back to the fixed chart keeps its saved spec", async () => {
  const host = store(); setConfigStoreHost(host);
  const config = await host.loadConfig("browser://local");
  const requests: string[] = [];
  await mount(config, requests);
  await settle(() => requests.includes("BTC-USD:CCC") && Boolean(findPaneInstance(latest.config.layout, chartId)?.settings?.chartSpec));
  const before = structuredClone(findPaneInstance(latest.config.layout, chartId)!.settings!);
  const moved = updatePaneInstance(latest.config.layout, researchId, pane => ({ ...pane, binding: { kind: "fixed", symbol: "SHOP:XNAS" } }));
  await act(async () => dispatch({ type: "SET_CONFIG", config: { ...latest.config, layout: moved } }));
  await settle(() => (findPaneInstance(latest.config.layout, chartId)?.settings?.chartSpec as any)?.series[0].source.instrument.symbol === "SHOP");
  // A list cursor is not part of the layout, so the source still shows SHOP after the undo.
  const undone = updatePaneInstance(latest.config.layout, chartId, pane => ({ ...pane,
    title: "GP BTC-USD:CCC", binding: { kind: "fixed", symbol: "BTC-USD:CCC" }, settings: before }));
  await act(async () => dispatch({ type: "SET_CONFIG", config: { ...latest.config, layout: undone } }));
  await settle(() => tui.frame().includes("BTC-USD:CCC Price"));
  expect(tui.frame()).not.toContain("SHOP:XNAS Price");
  expect(findPaneInstance(latest.config.layout, chartId)!.settings).toEqual(before);
});

test("fixed custom comparison does not follow the research pane", async () => {
  const host = store(); setConfigStoreHost(host);
  const config = await host.loadConfig("browser://local");
  const spec = buildComparisonChartPreset(["BTC-USD:CCC", "SPY:ARCX"]);
  const layout = updatePaneInstance(config.layout, chartId, pane => ({ ...pane,
    binding: { kind: "fixed", symbol: "BTC-USD:CCC" }, settings: { chartSpec: spec } }));
  const requests: string[] = [];
  await mount({ ...config, layout }, requests);
  await settle(() => requests.includes("BTC-USD:CCC"));
  const switched = updatePaneInstance(latest.config.layout, researchId, pane => ({ ...pane, binding: { kind: "fixed", symbol: "SHOP:XNAS" } }));
  await act(async () => dispatch({ type: "SET_CONFIG", config: { ...latest.config, layout: switched } }));
  await tui.setup().renderOnce();
  expect(findPaneInstance(latest.config.layout, chartId)!.settings!.chartSpec).toEqual(spec);
  expect(requests).not.toContain("SHOP:NASDAQ");
});

test("follow ownership survives a comparison collision, range change and reload before another switch", async () => {
  const host = store(); setConfigStoreHost(host);
  const config = await host.loadConfig("browser://local");
  const comparison = buildComparisonChartPreset(["ASML:XAMS", "SPY:ARCX"]);
  const initial = updatePaneInstance(config.layout, researchId, pane => ({ ...pane, binding: { kind: "fixed", symbol: "ASML:XAMS" } }));
  const layout = updatePaneInstance(initial, chartId, pane => ({ ...pane, settings: { chartSpec: comparison } }));
  const requests: string[] = [];
  await mount({ ...config, layout }, requests);
  await settle(() => requests.includes("ASML:AMS") && Boolean(findPaneInstance(latest.config.layout, chartId)?.settings?.[CHART_FOLLOW_SERIES_SETTING_KEY]));
  const firstSwitch = updatePaneInstance(latest.config.layout, researchId, pane => ({ ...pane, binding: { kind: "fixed", symbol: "SPY:ARCX" } }));
  await act(async () => dispatch({ type: "SET_CONFIG", config: { ...latest.config, layout: firstSwitch } }));
  await settle(() => (findPaneInstance(latest.config.layout, chartId)?.settings?.chartSpec as any)?.series[0].source.instrument.symbol === "SPY");
  await tui.emitKeypress({ name: "3", sequence: "3" });
  await settle(() => (findPaneInstance(latest.config.layout, chartId)?.settings?.chartSpec as any)?.viewport.range === "1M");
  await flushPendingPersistence();
  const restored = await host.loadConfig("browser://local");
  expect(findPaneInstance(restored.layout, chartId)?.settings?.[CHART_FOLLOW_SERIES_SETTING_KEY]).toEqual([comparison.series[0]!.id]);
  await tui.destroy();
  await mount(restored, requests);
  await settle(() => tui.frame().includes("SPY:ARCX"));
  const secondSwitch = updatePaneInstance(latest.config.layout, researchId, pane => ({ ...pane, binding: { kind: "fixed", symbol: "SHOP:XNAS" } }));
  await act(async () => dispatch({ type: "SET_CONFIG", config: { ...latest.config, layout: secondSwitch } }));
  await settle(() => requests.includes("SHOP:NASDAQ"));
  const saved = findPaneInstance(latest.config.layout, chartId)!.settings!.chartSpec as any;
  expect(saved.series[0].source.instrument).toMatchObject({ symbol: "SHOP", exchange: "NASDAQ" });
  expect(saved.series[1]).toEqual(comparison.series[1]);
  expect(saved.viewport.range).toBe("1M");
  expect(saved.studies).toEqual(comparison.studies);
});

test("an unresolved followed contract hides old data without overwriting the authored chart, then recovers", async () => {
  const host = store(); setConfigStoreHost(host);
  const config = await host.loadConfig("browser://local");
  const requests: string[] = [], contracts: number[] = [];
  await mount(config, requests, contracts);
  await settle(() => requests.includes("BTC-USD:CCC") && Boolean(findPaneInstance(latest.config.layout, chartId)?.settings?.chartSpec));
  const saved = structuredClone(findPaneInstance(latest.config.layout, chartId)!.settings);
  const contract = (conId: number) => ({ brokerId: "ibkr", brokerInstanceId: "fixture-account", symbol: "ES", secType: "FUT", conId, exchange: "CME" });
  const ticker = createTestTicker("ES", "E-mini", { exchange: "CME", assetCategory: "FUT", broker_contracts: [contract(10), contract(20)] });
  const unresolved = updatePaneInstance(latest.config.layout, researchId, pane => ({ ...pane, binding: { kind: "fixed", symbol: "ES" } }));
  requests.length = 0;
  await act(async () => {
    dispatch({ type: "SET_TICKERS", tickers: new Map([["ES", ticker]]) });
    dispatch({ type: "SET_CONFIG", config: { ...latest.config, layout: unresolved } });
  });
  await settle(() => tui.frame().includes("Choose a contract in search."));
  expect(tui.frame()).not.toContain("BTC-USD:CCC Price");
  expect(requests).toEqual([]);
  expect(findPaneInstance(latest.config.layout, chartId)!.settings).toEqual(saved);
  const resolved = updatePaneInstance(latest.config.layout, researchId, pane => ({ ...pane,
    binding: { kind: "fixed", symbol: "ES", instrument: contract(20) } }));
  await act(async () => dispatch({ type: "SET_CONFIG", config: { ...latest.config, layout: resolved } }));
  await settle(() => contracts.includes(20));
  expect(requests).not.toContain("BTC-USD:CCC");
  expect(contracts).not.toContain(10);
});

test("deleting the followed primary leaves the authored comparison independent on subsequent switches", async () => {
  const host = store(); setConfigStoreHost(host);
  const config = await host.loadConfig("browser://local");
  const comparison = buildComparisonChartPreset(["ASML:XAMS", "SPY:ARCX"]);
  const initial = updatePaneInstance(config.layout, researchId, pane => ({ ...pane, binding: { kind: "fixed", symbol: "ASML:XAMS" } }));
  const layout = updatePaneInstance(initial, chartId, pane => ({ ...pane, settings: { chartSpec: comparison } }));
  const requests: string[] = [];
  await mount({ ...config, layout }, requests);
  await settle(() => Boolean(findPaneInstance(latest.config.layout, chartId)?.settings?.[CHART_FOLLOW_SERIES_SETTING_KEY]));
  const withoutPrimary = { ...comparison, series: [comparison.series[1]!] };
  const deleted = updatePaneInstance(latest.config.layout, chartId, pane => ({ ...pane,
    settings: { ...pane.settings, chartSpec: withoutPrimary } }));
  await act(async () => dispatch({ type: "SET_CONFIG", config: { ...latest.config, layout: deleted } }));
  await settle(() => (findPaneInstance(latest.config.layout, chartId)?.settings?.[CHART_FOLLOW_SERIES_SETTING_KEY] as unknown[])?.length === 0);
  const switched = updatePaneInstance(latest.config.layout, researchId, pane => ({ ...pane, binding: { kind: "fixed", symbol: "SHOP:XNAS" } }));
  requests.length = 0;
  await act(async () => dispatch({ type: "SET_CONFIG", config: { ...latest.config, layout: switched } }));
  await settle(() => tui.frame().includes("Chart: SHOP:XNAS"));
  expect(findPaneInstance(latest.config.layout, chartId)!.settings!.chartSpec).toEqual(withoutPrimary);
  expect(findPaneInstance(latest.config.layout, chartId)!.settings![CHART_FOLLOW_SERIES_SETTING_KEY]).toEqual([]);
  expect(requests).not.toContain("SHOP:NASDAQ");
  expect(requests).not.toContain("ASML:AMS");
});

test("mounted follower reacts to a different broker contract with the same ticker and venue", async () => {
  const host = store(); setConfigStoreHost(host);
  const config = await host.loadConfig("browser://local");
  const contract = (conId: number) => ({ brokerId: "ibkr", brokerInstanceId: "fixture-account", symbol: "ES", secType: "FUT", conId, exchange: "CME" });
  const layout = updatePaneInstance(config.layout, researchId, pane => ({ ...pane,
    binding: { kind: "fixed", symbol: "ES", instrument: contract(10), listing: { name: "E-mini S&P 500", exchange: "CME", currency: "USD", type: "FUT" } } }));
  const requests: string[] = [], contracts: number[] = [];
  await mount({ ...config, layout }, requests, contracts);
  await settle(() => contracts.includes(10));
  const switched = updatePaneInstance(latest.config.layout, researchId, pane => ({ ...pane,
    binding: { kind: "fixed", symbol: "ES", instrument: contract(20), listing: { name: "E-mini S&P 500", exchange: "CME", currency: "USD", type: "FUT" } } }));
  contracts.length = 0;
  await act(async () => dispatch({ type: "SET_CONFIG", config: { ...latest.config, layout: switched } }));
  await settle(() => contracts.includes(20));
  expect(contracts).not.toContain(10);
  const spec = findPaneInstance(latest.config.layout, chartId)!.settings!.chartSpec as any;
  expect(spec.series[0].source.instrument.instrument).toEqual(contract(20));
});

test("follow projection preserves comparisons, studies, qualified venues and distinct broker contracts", () => {
  const comparison = buildComparisonChartPreset(["ASML:XAMS", "SPY:ARCX"]);
  const changed = rebindFollowChartSpec(comparison, { symbol: "ASML", exchange: "AMS" }, { symbol: "ASML", exchange: "NASDAQ" });
  expect(changed.series[0]!.source).toMatchObject({ instrument: { symbol: "ASML", exchange: "NASDAQ" } });
  expect(changed.series[1]).toBe(comparison.series[1]);
  expect(changed.studies).toBe(comparison.studies);
  expect(changed.viewport).toBe(comparison.viewport);
  const primary = comparison.series[0]!;
  const grouped = { ...comparison, series: [...comparison.series, { ...primary, id: "primary-volume", source: {
    ...primary.source, kind: "security" as const, instrument: { symbol: "ASML", exchange: "AMS" }, fieldId: "market.volume",
  } }] };
  const ownerIds = resolveFollowSeriesIds(grouped, { symbol: "ASML", exchange: "AMS" }, { symbol: "SPY", exchange: "ARCA" });
  const collision = rebindFollowChartSpec(grouped, null, { symbol: "SPY", exchange: "ARCA" }, ownerIds);
  const afterCollision = rebindFollowChartSpec(collision, null, { symbol: "SHOP", exchange: "NASDAQ" }, ownerIds);
  expect(afterCollision.series[0]!.source).toMatchObject({ instrument: { symbol: "SHOP" } });
  expect(afterCollision.series[1]).toBe(comparison.series[1]);
  expect(afterCollision.series[2]!.source).toMatchObject({ fieldId: "market.volume", instrument: { symbol: "SHOP" } });
  const economic = buildCustomChartPreset("FRED:CPIAUCSL");
  expect(rebindFollowChartSpec(economic, null, { symbol: "SHOP" })).toBe(economic);
  expect(rebindFollowChartSpec(comparison, null, { symbol: "SPY", exchange: "ARCA" })).toBe(comparison);
  const contract = (conId: number): InstrumentRef => ({ symbol: "ES", exchange: "CME", brokerId: "ibkr", brokerInstanceId: "account",
    instrument: { brokerId: "ibkr", brokerInstanceId: "account", symbol: "ES", secType: "FUT", conId, exchange: "CME" } });
  const first = contract(10), second = contract(20), next = contract(30);
  const price = buildPriceChartPreset("ES:CME");
  const brokerSpec = { ...price, series: [first, second].map((instrument, i) => ({ ...price.series[0]!, id: `contract-${i}`, label: i === 0 ? "ES" : "Custom comparison",
    source: { kind: "security" as const, instrument, fieldId: "market.close" } })) };
  for (const previous of [first, next]) {
    const rebound = rebindFollowChartSpec(brokerSpec, previous, next);
    expect(rebound.series[0]!.source).toMatchObject({ instrument: next });
    expect(rebound.series[1]).toBe(brokerSpec.series[1]);
  }
  const publicNext = rebindFollowChartSpec(brokerSpec, first, { symbol: "SHOP", exchange: "NASDAQ", instrument: null });
  expect(publicNext.series[0]!.source).toMatchObject({ instrument: { symbol: "SHOP", instrument: null } });
  expect((publicNext.series[0]!.source as any).instrument.brokerId).toBeUndefined();
  expect(publicNext.series[1]).toBe(brokerSpec.series[1]);
  expect(publicNext.series[0]!.label).toBe("SHOP:XNAS");
  expect(publicNext.series[1]!.label).toBe("Custom comparison");
});
