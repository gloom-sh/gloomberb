import { afterEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient } from "../../../api-client";
import type { MarketHeatmapResult } from "../../../api-client/market-discovery";
import { createInitialState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createOpenTuiTestHarness, settleFrame } from "../../../renderers/opentui/test-utils";
import { marketHeatmapPlugin } from "./index";
import { resetMarketHeatmapCache } from "./data";

const tui = createOpenTuiTestHarness();
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; resetMarketHeatmapCache(); });

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
