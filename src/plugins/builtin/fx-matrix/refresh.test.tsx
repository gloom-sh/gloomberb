import { expect, test } from "bun:test";
import { act } from "react";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { AssetDataRouter } from "../../../sources/provider-router";
import { createInitialState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { TestPaneProvider, createTestPaneConfig } from "../../../test-support/pane";
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
  const runtime = { getMarketData: () => provider };
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
