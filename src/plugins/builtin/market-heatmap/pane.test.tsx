import { afterEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient } from "../../../api-client";
import type { MarketHeatmapResult } from "../../../api-client/market-discovery";
import { createInitialState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
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
