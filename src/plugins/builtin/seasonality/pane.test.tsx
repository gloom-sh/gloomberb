import { expect, test } from "bun:test";
import { act } from "react";
import { MemoryResourceStore } from "../../../data/memory-resource-store";
import { setSavedCopyFrameGate, setSavedCopyStore } from "../../../data/pane-saved-copies";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestPaneConfig, createTestTicker, TestPaneFrame } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { PricePoint } from "../../../types/financials";
import { SeasonalityPane } from "./pane";

const tui = createOpenTuiTestHarness();

test("the mounted seasonality pane saves its monthly returns and opens on them before refreshing", async () => {
  const width = 140;
  const height = 24;
  const paneId = "seasonality:saved-returns";
  const state = createInitialState(createTestPaneConfig("/unused/seasonality", {
    instanceId: paneId, paneId: "seasonality", binding: { kind: "fixed", symbol: "TEST" },
  }));
  state.tickers.set("TEST", createTestTicker("TEST", "Test", { exchange: "NASDAQ" }));
  const history = [100, 110, 121].map((close, month) => ({ date: new Date(Date.UTC(2025, month, 1)), close }));
  const loaded = new MarketDataCoordinator(createTestDataProvider({ getPriceHistoryForResolution: async () => history }));
  const pending = Promise.withResolvers<PricePoint[]>();
  let refreshes = 0;
  const reopened = new MarketDataCoordinator(createTestDataProvider({ getPriceHistoryForResolution: () => {
    refreshes += 1;
    return pending.promise;
  } }));
  const previous = setSavedCopyStore(new MemoryResourceStore());
  const drawn = Promise.withResolvers<void>();
  const runtime = createTestPluginRuntime();
  const pane = <TestPaneFrame width={width} height={height} state={state} paneId={paneId} pluginId="seasonality" runtime={runtime}>
    {(body) => <SeasonalityPane paneId={paneId} paneType="seasonality" focused {...body} />}
  </TestPaneFrame>;
  const draw = async () => { await act(async () => { await tui.setup().renderOnce(); }); };
  try {
    setSharedMarketDataCoordinator(loaded);
    await tui.render(pane, { width, height });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await draw();
      if (tui.frame().includes("+10.0%")) break;
      await Bun.sleep(1);
    }
    expect(tui.frame()).toContain("+10.0%");
    await tui.destroy();
    setSharedMarketDataCoordinator(reopened);
    setSavedCopyFrameGate(() => drawn.promise);
    await tui.render(pane, { width, height });
    await draw();
    expect(tui.frame()).toContain("+10.0%");
    expect(tui.frame()).toContain("saved copy from");
    expect(refreshes).toBe(0);
  } finally {
    await tui.destroy();
    drawn.resolve();
    pending.resolve(history);
    loaded.destroy();
    reopened.destroy();
    setSharedMarketDataCoordinator(null);
    setSavedCopyFrameGate(null);
    setSavedCopyStore(previous);
  }
});
