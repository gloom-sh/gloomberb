import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useReducer, type Dispatch } from "react";
import { apiClient } from "../../../api-client";
import type { MarketHeatmapAsset, MarketHeatmapResult } from "../../../api-client/market-discovery";
import { setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { buildQuoteKey } from "../../../market-data/selectors";
import { setPaneSetting } from "../../../pane-settings";
import { createRemoteUiRegistry, RemoteUiRegistryProvider } from "../../../remote/semantic-tree";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { IDLE_COORDINATOR_QUOTES } from "../../../test-support/quote-store";
import type { Quote } from "../../../types/financials";
import { resolveRegistryPaneQuickSettings, resolveRegistryPaneSettings } from "../../registry/pane-settings";
import { TestPaneFrame, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createOpenTuiTestHarness, settleFrame } from "../../../renderers/opentui/test-utils";
import { marketHeatmapPlugin } from "./index";
import { resetMarketHeatmapCache } from "./data";

const tui = createOpenTuiTestHarness();
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; resetMarketHeatmapCache(); setSharedMarketDataCoordinator(null); });

const stock = (symbol: string, size: number, changePercent: number, sector = "Technology"): MarketHeatmapAsset => ({
  symbol, name: symbol, price: 100, change: changePercent, changePercent, hasChange: true, size, sizeKind: "market-cap",
  volume: 1_000, currency: "USD", exchange: "NASDAQ", sector, industry: null, marketState: null, source: "gloom", regularChangePercent: changePercent,
});
/** Friday's board, put together after the close: every tile is that session's close and move. */
const fridayBoard = (assets: MarketHeatmapAsset[]): MarketHeatmapResult => ({
  universe: "us-equity", source: "gloom", fetchedAt: Date.parse("2026-10-09T22:15:15Z"), session: "CLOSED", regularSessionDate: "2026-10-09", assets,
});

/** The pane under a live reducer, so a setting can change under it as the settings dialog or pane.setSetting changes it. */
async function mountHeatmap(settings: Record<string, unknown>) {
  const id = "market-heatmap", Pane = marketHeatmapPlugin.panes![0]!.component;
  const initial = createInitialState(createTestPaneConfig(":memory:", { instanceId: id, paneId: id, settings: { universe: "us-equity", ...settings } }));
  initial.focusedPaneId = id;
  let footer: unknown;
  let current: AppState = initial;
  let dispatch: Dispatch<AppAction> = () => {};
  function Harness() {
    const [state, send] = useReducer(appReducer, initial);
    current = state;
    dispatch = send;
    return (
      <TestPaneFrame state={state} dispatch={send} paneId={id} pluginId={id}
        runtime={createTestPluginRuntime({ getMarketData: () => null })} width={120} height={20}>
        {(body, value) => { footer = value; return <Pane paneId={id} paneType={id} focused {...body} />; }}
      </TestPaneFrame>
    );
  }
  await act(async () => { await tui.render(<Harness />, { width: 120, height: 20 }); });
  await settleFrame(tui.setup(), 8);
  return {
    footer: () => JSON.stringify(footer),
    async setSetting(key: string, value: unknown) {
      await act(async () => {
        dispatch({ type: "SET_CONFIG", config: { ...current.config, layout: setPaneSetting(current.config.layout, id, key, value) } });
      });
      await settleFrame(tui.setup(), 6);
    },
  };
}

test("retained heatmap rows stay visible with a stale footer until a fresh snapshot arrives", async () => {
  const result: MarketHeatmapResult = { universe: "us-equity", source: "gloom", fetchedAt: Date.now() - 3_600_000, stale: true, assets: [{
    symbol: "ACME", name: "Acme", price: 100, change: 1, changePercent: 1, hasChange: true,
    size: 2e9, sizeKind: "market-cap", volume: 100, currency: "USD", exchange: "NASDAQ",
    sector: null, industry: null, marketState: null, source: "gloom",
  }] };
  const api = spyOn(apiClient, "getMarketHeatmap").mockResolvedValue({ status: "success", data: result });
  restore = () => api.mockRestore();
  const id = "market-heatmap", Pane = marketHeatmapPlugin.panes![0]!.component;
  const state = createInitialState(createTestPaneConfig(":memory:", { instanceId: id, paneId: id, settings: { universe: "us-equity", liveStreaming: false } }));
  state.focusedPaneId = id;
  let footer: any;
  await act(async () => { await tui.render(
    <TestPaneFrame state={state} dispatch={() => {}} paneId={id} pluginId={id}
      runtime={createTestPluginRuntime({ getMarketData: () => null })} width={100} height={16}>
      {(body, value) => { footer = value; return <Pane paneId={id} paneType={id} focused {...body} />; }}
    </TestPaneFrame>, { width: 100, height: 16 }); });
  await settleFrame(tui.setup(), 8);
  expect(tui.frame()).toContain("ACME");
  expect(JSON.stringify(footer)).toContain('"text":"stale","tone":"warning"');

  api.mockResolvedValue({ status: "success", data: { ...result, stale: false, fetchedAt: Date.now() } });
  await tui.emitKeypress({ name: "r", sequence: "r" });
  await settleFrame(tui.setup(), 6);
  expect(tui.frame()).toContain("ACME");
  expect(JSON.stringify(footer)).not.toContain('"text":"stale"');
});

test("portfolio tab draws the list selected in the portfolio pane", async () => {
  const api = spyOn(apiClient, "getMarketHeatmap");
  restore = () => api.mockRestore();
  const id = "market-heatmap";
  const Pane = marketHeatmapPlugin.panes![0]!.component;
  const config = createTestPaneConfig(":memory:", {
    instanceId: id,
    paneId: id,
    settings: { universe: "portfolio", liveStreaming: false },
  });
  config.layout.instances.push({
    instanceId: "portfolio-list:main",
    paneId: "portfolio-list",
    params: { collectionId: "main" },
    binding: { kind: "none" },
  });
  const state = createInitialState(config);
  state.paneState["portfolio-list:main"] = { collectionId: "watchlist" };
  state.tickers.set("NVDA", createTestTicker("NVDA", "NVIDIA", { watchlists: ["watchlist"] }));
  state.tickers.set("AAPL", createTestTicker("AAPL", "Apple", {
    portfolios: ["main"],
    positions: [{ portfolio: "main", shares: 1, marketValue: 100, broker: "manual" }],
  }));
  state.focusedPaneId = id;
  await act(async () => {
    await tui.render(
      <TestPaneFrame state={state} dispatch={() => {}} paneId={id} pluginId={id}
        runtime={createTestPluginRuntime({ getMarketData: () => null })} width={100} height={16}>
        {(body) => <Pane paneId={id} paneType={id} focused {...body} />}
      </TestPaneFrame>,
      { width: 100, height: 16 },
    );
  });
  await settleFrame(tui.setup(), 8);
  const frame = tui.frame();
  expect(frame).toContain("NVDA");
  expect(frame).toContain("Watchlist");
  expect(frame).not.toContain("AAPL");
  expect(api).not.toHaveBeenCalled();
});

test("US Stocks draws sector blocks, and the arrows and Enter reach tiles across them", async () => {
  const stock = (symbol: string, size: number, sector: string, industry: string, changePercent: number) => ({
    symbol, name: symbol, price: 100, change: 0, changePercent, hasChange: true, size, sizeKind: "market-cap" as const,
    volume: 1_000, currency: "USD", exchange: "NASDAQ", sector, industry, marketState: null, source: "gloom" as const,
  });
  const result: MarketHeatmapResult = { universe: "us-equity", source: "gloom", fetchedAt: Date.now(), assets: [
    stock("AAAA", 400, "Technology", "Chips", 1.2), stock("BBBB", 200, "Technology", "Software", -0.4),
    stock("CCCC", 300, "Energy", "Oil", 2.1), stock("DDDD", 100, "Energy", "Oil", -1.5),
  ] };
  const api = spyOn(apiClient, "getMarketHeatmap").mockResolvedValue({ status: "success", data: result });
  restore = () => api.mockRestore();
  const pinned: string[] = [];
  const id = "market-heatmap", Pane = marketHeatmapPlugin.panes![0]!.component;
  const state = createInitialState(createTestPaneConfig(":memory:", { instanceId: id, paneId: id, settings: { universe: "us-equity", liveStreaming: false } }));
  state.focusedPaneId = id;
  let footer: any;
  await act(async () => { await tui.render(
    <TestPaneFrame state={state} dispatch={() => {}} paneId={id} pluginId={id}
      runtime={createTestPluginRuntime({ getMarketData: () => null, pinTicker: (symbol: string) => { pinned.push(symbol); } })} width={100} height={20}>
      {(body, value) => { footer = value; return <Pane paneId={id} paneType={id} focused {...body} />; }}
    </TestPaneFrame>, { width: 100, height: 20 }); });
  await settleFrame(tui.setup(), 8);
  const frame = tui.frame();
  expect(frame).toContain("TECHNOLOGY");
  expect(frame).toContain("ENERGY");
  expect(frame).toContain("+1.2%");
  expect(api).toHaveBeenCalledWith("us-equity", 500);
  const selected = () => JSON.stringify(footer).match(/"text":"([A-Z]{4})","tone":"label"/)?.[1];
  expect(selected()).toBe("AAAA");

  for (let step = 0; step < 3 && !["CCCC", "DDDD"].includes(selected() ?? ""); step += 1) {
    await tui.emitKeypress({ name: "right", sequence: "\u001b[C" });
    await settleFrame(tui.setup(), 2);
  }
  expect(["CCCC", "DDDD"]).toContain(selected()!);
  await tui.emitKeypress({ name: "return", sequence: "\r" });
  expect(pinned).toEqual([selected()!]);
});

test("the size quick setting reads square root until the pane saves a choice", () => {
  const settings = marketHeatmapPlugin.panes![0]!.settings as (context: any) => { values?: Record<string, unknown> };
  expect(settings({ settings: {} }).values?.sizeBy).toBe("sqrt-market-cap");
  expect(settings({ settings: { sizeBy: "market-cap" } }).values?.sizeBy).toBe("market-cap");
});

/** Renders the portfolio tab on the list the portfolio pane shows, and returns what the pane publishes as its kind. */
async function publishedCollectionKind(collectionId: string): Promise<unknown> {
  const id = "market-heatmap", Pane = marketHeatmapPlugin.panes![0]!.component;
  const config = createTestPaneConfig(":memory:", { instanceId: id, paneId: id, settings: { universe: "portfolio", liveStreaming: false } });
  config.layout.instances.push({ instanceId: "portfolio-list:main", paneId: "portfolio-list", params: { collectionId }, binding: { kind: "none" } });
  const state = createInitialState(config);
  state.paneState["portfolio-list:main"] = { collectionId };
  state.focusedPaneId = id;
  const published: Record<string, unknown> = {};
  const dispatch = (action: any) => {
    if (action.type === "UPDATE_PANE_STATE" && action.paneId === id) Object.assign(published, action.patch);
  };
  await act(async () => { await tui.render(
    <TestPaneFrame state={state} dispatch={dispatch} paneId={id} pluginId={id}
      runtime={createTestPluginRuntime({ getMarketData: () => null })} width={100} height={16}>
      {(body) => <Pane paneId={id} paneType={id} focused {...body} />}
    </TestPaneFrame>, { width: 100, height: 16 }); });
  await settleFrame(tui.setup(), 4);
  return published.collectionKind;
}

function sizeControlShown(universe: string, paneState: Record<string, unknown> = {}): boolean {
  const pane = marketHeatmapPlugin.panes![0]!;
  const config = createTestPaneConfig(":memory:", { instanceId: pane.id, paneId: pane.id, settings: { universe } });
  const resolved = resolveRegistryPaneSettings({
    config,
    getConfigState: () => null,
    getPaneRuntimeState: (paneId) => (paneId === pane.id ? paneState : null),
    layout: config.layout,
    paneDefs: new Map([[pane.id, pane]]),
    paneOwners: new Map(),
    resolvePaneTarget: () => pane.id,
    requestedPaneId: pane.id,
  });
  return resolveRegistryPaneQuickSettings(resolved).some((setting) => setting.key === "sizeBy");
}

test("the square-root control shows on US Stocks, US ETFs and a watchlist, never on a portfolio", async () => {
  const spy = spyOn(apiClient, "getMarketHeatmap");
  restore = () => spy.mockRestore();
  expect(sizeControlShown("us-equity")).toBe(true);
  expect(sizeControlShown("us-etf")).toBe(true);

  const watchlist = await publishedCollectionKind("watchlist");
  expect(sizeControlShown("portfolio", { collectionKind: watchlist })).toBe(true);
  const portfolio = await publishedCollectionKind("main");
  expect(sizeControlShown("portfolio", { collectionKind: portfolio })).toBe(false);
  // Before the pane has said which list it shows, an inert control does not flash up.
  expect(sizeControlShown("portfolio")).toBe(false);
});


/** Renders the pane on a tab and returns the chart-data evidence it publishes for `gloomberb shot`. */
async function publishedEvidence(universe: string): Promise<Record<string, unknown> | undefined> {
  const id = "market-heatmap", Pane = marketHeatmapPlugin.panes![0]!.component;
  const registry = createRemoteUiRegistry();
  const state = createInitialState(createTestPaneConfig(":memory:", { instanceId: id, paneId: id, settings: { universe, liveStreaming: false } }));
  state.focusedPaneId = id;
  await act(async () => { await tui.render(
    <RemoteUiRegistryProvider registry={registry}>
      <TestPaneFrame state={state} dispatch={() => {}} paneId={id} pluginId={id}
        runtime={createTestPluginRuntime({ getMarketData: () => null })} width={100} height={20}>
        {(body) => <Pane paneId={id} paneType={id} focused {...body} />}
      </TestPaneFrame>
    </RemoteUiRegistryProvider>, { width: 100, height: 20 }); });
  await settleFrame(tui.setup(), 8);
  return registry.snapshot().find((node) => node.role === "chart-data" && node.metadata?.kind === "market-heatmap")?.metadata;
}

test("the pane publishes the tiles and sectors it drew, and nothing complete without a board", async () => {
  const stock = (symbol: string, sector: string, size: number) => ({
    symbol, name: symbol, price: 100, change: 1, changePercent: 1, hasChange: true, size, sizeKind: "market-cap" as const,
    volume: 1_000, currency: "USD", exchange: "NASDAQ", sector, industry: null, marketState: null, source: "gloom" as const,
  });
  const result: MarketHeatmapResult = { universe: "us-equity", source: "gloom", fetchedAt: Date.now(), assets: [
    stock("AAAA", "Technology", 400), stock("BBBB", "Technology", 200), stock("CCCC", "Energy", 300),
  ] };
  const api = spyOn(apiClient, "getMarketHeatmap").mockResolvedValue({ status: "success", data: result });
  restore = () => api.mockRestore();
  expect(await publishedEvidence("us-equity")).toMatchObject({ complete: true, plottedValueCount: 3, tiles: 3, sectors: 2, moved: 3, tab: "us-equity" });

  api.mockRejectedValue(new Error("down"));
  resetMarketHeatmapCache();
  expect(await publishedEvidence("us-etf")).toMatchObject({ complete: false, plottedValueCount: 0, tab: "us-etf" });
  // A portfolio without positions is an empty board, not a pending one.
  expect(await publishedEvidence("portfolio")).toMatchObject({ complete: false, plottedValueCount: 0, tab: "portfolio", ready: true });
});

test("the footer dates the session and the snapshot apart from the last check that succeeded, and a failed check keeps both", async () => {
  const api = spyOn(apiClient, "getMarketHeatmap").mockRejectedValueOnce(new Error("down"))
    .mockResolvedValue({ status: "success", data: fridayBoard([stock("AAAA", 400, -0.52), stock("BBBB", 200, 1.1)]) });
  restore = () => api.mockRestore();
  const pane = await mountHeatmap({ liveStreaming: false });
  // Nothing has been checked yet, so nothing claims it was.
  expect(pane.footer()).not.toContain("checked");

  await tui.emitKeypress({ name: "r", sequence: "r" });
  await settleFrame(tui.setup(), 6);
  const caption = "top 2 · Oct 9 session · snapshot 18:15 ET · checked just now";
  expect(pane.footer()).toContain(caption);
  expect(pane.footer()).not.toContain("updated");

  api.mockRejectedValue(new Error("down"));
  await tui.emitKeypress({ name: "r", sequence: "r" });
  await settleFrame(tui.setup(), 6);
  expect(pane.footer()).toContain('"text":"refresh failed","tone":"warning"');
  expect(pane.footer()).toContain(caption);
});

test("Names asks for that many, and the footer counts the board on screen until the next one arrives", async () => {
  const names = (count: number) => Array.from({ length: count }, (_, index) => stock(`S${index}`, 1_000 - index, 1, index % 2 ? "Energy" : "Technology"));
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof apiClient.getMarketHeatmap>>>();
  const api = spyOn(apiClient, "getMarketHeatmap").mockImplementation((_universe, count = 80) => (count === 500
    ? pending.promise
    : Promise.resolve({ status: "success", data: fridayBoard(names(count)) })));
  restore = () => api.mockRestore();
  const pane = await mountHeatmap({ liveStreaming: false, maxNames: "100" });
  expect(api).toHaveBeenLastCalledWith("us-equity", 100);
  expect(pane.footer()).toContain("top 100 ·");

  // As pane.setSetting sends it, a number.
  await pane.setSetting("maxNames", 500);
  expect(api).toHaveBeenLastCalledWith("us-equity", 500);
  expect(pane.footer()).toContain("top 100 ·");
  expect(pane.footer()).toContain('"text":"loading"');

  await act(async () => { pending.resolve({ status: "success", data: fridayBoard(names(500)) }); });
  await settleFrame(tui.setup(), 6);
  expect(pane.footer()).toContain("top 500 ·");
});

test("Colour by moves a streaming tile between its after-hours move and the regular session's, without waiting for a tick", async () => {
  const afterHours: Quote = { symbol: "AAAA", currency: "USD", listingExchangeName: "NASDAQ", marketState: "POST", price: 99.77, change: -0.23,
    changePercent: -0.23, previousClose: 100, regularClose: 99.48, regularCloseSessionDate: "2026-10-09", regularChange: -0.52,
    regularChangePercent: -0.52, changeSessionDate: "2026-10-09", postMarketPrice: 99.77, postMarketChange: 0.29, postMarketChangePercent: 0.2915,
    lastUpdated: Date.parse("2026-10-09T22:58:00Z") };
  const entry = { phase: "ready" as const, data: afterHours, lastGoodData: afterHours, source: "test", fetchedAt: 1, staleAt: null, error: null, attempts: [] };
  setSharedMarketDataCoordinator({
    ...IDLE_COORDINATOR_QUOTES, subscribe: () => () => {}, getVersion: () => 1,
    getQuoteEntry: (instrument: Parameters<typeof buildQuoteKey>[0]) => (buildQuoteKey(instrument) === buildQuoteKey({ symbol: "AAAA", exchange: "NASDAQ" })
      ? entry
      : IDLE_COORDINATOR_QUOTES.getQuoteEntry()),
  } as never);
  const api = spyOn(apiClient, "getMarketHeatmap").mockResolvedValue({ status: "success",
    data: fridayBoard([{ ...stock("AAAA", 400, -0.52), price: 99.48 }, stock("BBBB", 200, 1.1)]) });
  restore = () => api.mockRestore();
  const selected = (footer: string) => footer.match(/"text":"AAAA","tone":"label"\},\{"text":"([^"]+)"/)?.[1];

  const pane = await mountHeatmap({});
  expect(selected(pane.footer())).toBe("+0.29%");
  expect(pane.footer()).toContain('"text":"AH","tone":"muted"');
  expect(tui.frame()).toContain("+0.3%");

  await pane.setSetting("sessionBasis", "regular-session");
  expect(selected(pane.footer())).toBe("-0.52%");
  expect(pane.footer()).not.toContain('"text":"AH"');
  expect(tui.frame()).toContain("-0.5%");
  expect(tui.frame()).not.toContain("+0.3%");

  await pane.setSetting("sessionBasis", "active-session");
  expect(selected(pane.footer())).toBe("+0.29%");
  expect(tui.frame()).toContain("+0.3%");
});
