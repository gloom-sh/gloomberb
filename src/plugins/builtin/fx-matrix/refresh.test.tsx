import { expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { AssetDataRouter } from "../../../sources/provider-router";
import { createInitialState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { TestPaneProvider, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { fxMatrixModule } from "./index";

const tui = createOpenTuiTestHarness();

test("the FX matrix refresh key updates cached cross rates without refetching on renders", async () => {
  const requests: string[] = [];
  let eurRate = 1.1;
  const source = createTestDataProvider({
    id: "controlled-fx",
    getExchangeRateSnapshot: async currency => {
      requests.push(currency);
      return {
        fromCurrency: currency, toCurrency: "USD", rate: currency === "EUR" ? eurRate : 1 / 150,
        source: "controlled-fx", asOf: new Date().toISOString(), fetchedAt: new Date().toISOString(), stale: false,
      };
    },
  });
  const provider = new AssetDataRouter(source);
  const coordinator = new MarketDataCoordinator(provider);
  setSharedMarketDataCoordinator(coordinator);
  const config = createTestPaneConfig("/tmp/fx-matrix-refresh-unused", {
    paneId: "fx-matrix", instanceId: "fx-matrix", settings: { currencies: ["USD", "EUR", "JPY"] },
  });
  config.refreshIntervalMinutes = 0;
  const state = createInitialState(config);
  const runtime = createTestPluginRuntime({ getMarketData: () => provider });
  const Pane = fxMatrixModule.panes![0]!.component;
  const settle = async () => {
    for (let frame = 0; frame < 4; frame++) await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
      await tui.setup().renderOnce();
    });
  };
  try {
    await act(async () => {
      await tui.render(
        <TestPaneProvider state={state} paneId="fx-matrix" runtime={runtime} pluginId="market-overview">
          <Pane paneId="fx-matrix" paneType="fx-matrix" focused width={80} height={14} />
        </TestPaneProvider>,
        { width: 80, height: 14 },
      );
    });
    await tui.waitForFrameToContain("1.1000");
    expect(requests.sort()).toEqual(["EUR", "JPY"]);

    eurRate = 1.2;
    await act(async () => { tui.setup().mockInput.pressKey("r"); });
    const refreshed = await tui.waitForFrameToContain("1.2000");
    expect(requests.length).toBe(4);
    expect(refreshed).toContain("180.00");
    expect(refreshed).toContain("0.8333");
    await settle();
    expect(requests.length).toBe(4);
  } finally {
    await tui.destroy();
    coordinator.destroy();
    setSharedMarketDataCoordinator(null);
  }
});

// `shot FXC --currencies TRY,USD,EUR,GBP` drew every 1D in USD cell as a dash: the pair quotes the move reads came
// only from a stream, and none was sending them. The pane reads them once, as `fn FXC` does.
test("the day's move in dollars is read from the pair quotes when no stream sends them", async () => {
  const now = Date.parse("2026-11-10T20:14:00Z");
  const source = createTestDataProvider({
    id: "controlled-fx",
    getExchangeRateSnapshot: async currency => ({
      fromCurrency: currency, toCurrency: "USD", rate: currency === "EUR" ? 1.1 : 1 / 150, source: "controlled-fx",
      asOf: new Date(now - 60_000).toISOString(), fetchedAt: new Date(now - 60_000).toISOString(), stale: false,
    }),
    getQuote: async (symbol) => ({
      symbol, currency: "USD", price: symbol === "EURUSD=X" ? 1.1 : 150, previousClose: symbol === "EURUSD=X" ? 1.1055 : 149,
      change: 0, changePercent: 0, lastUpdated: now, instrumentType: "CURRENCY",
    }),
  });
  const provider = new AssetDataRouter(source);
  const coordinator = new MarketDataCoordinator(provider);
  setSharedMarketDataCoordinator(coordinator);
  const config = createTestPaneConfig("/tmp/fx-matrix-move-unused", {
    paneId: "fx-matrix", instanceId: "fx-matrix", settings: { currencies: ["USD", "EUR", "JPY"] },
  });
  config.refreshIntervalMinutes = 0;
  const runtime = createTestPluginRuntime({ getMarketData: () => provider });
  const Pane = fxMatrixModule.panes![0]!.component;
  setSystemTime(new Date(now));
  try {
    await act(async () => {
      await tui.render(
        <TestPaneProvider state={createInitialState(config)} paneId="fx-matrix" runtime={runtime} pluginId="market-overview">
          <Pane paneId="fx-matrix" paneType="fx-matrix" focused width={100} height={14} />
        </TestPaneProvider>,
        { width: 100, height: 14 },
      );
    });
    // EUR 1.1000 from 1.1055, the yen at 150 from 149: each weaker against the dollar.
    const frame = await tui.waitForFrameToContain("-0.67%");
    expect(frame).toContain("-0.50%");
  } finally {
    setSystemTime();
    await tui.destroy();
    coordinator.destroy();
    setSharedMarketDataCoordinator(null);
  }
});
