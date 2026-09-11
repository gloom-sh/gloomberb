import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../../state/app/context";
import { createTestDataProvider } from "../../../../test-support/data-provider";
import { createTestPaneConfig, createTestTicker, TestPaneProvider } from "../../../../test-support/pane";
import { createTestPluginRuntime } from "../../../../test-support/plugin-runtime";
import { HistoricalPricesPane } from "./historical-prices";

test("historical table preserves tiny prices and signed changes inside its numeric columns", async () => {
  const paneId = "history:test";
  const symbol = "SHIB-USD:CCC";
  const config = createTestPaneConfig("/tmp/gloom-history-precision-test", {
    instanceId: paneId, paneId: "historical-prices", binding: { kind: "fixed", symbol },
  });
  const state = createInitialState(config);
  state.tickers.set(symbol, createTestTicker(symbol));
  const provider = createTestDataProvider({
    getPriceHistory: async () => [
      { date: new Date("2026-09-09"), close: 0.00000531 },
      { date: new Date("2026-09-10"), open: 0.00000531, high: 0.00000542, low: 0.00000501, close: 0.00000532 },
      { date: new Date("2026-09-11"), close: 0.0000053 },
    ],
  });
  const runtime = createTestPluginRuntime({ getMarketData: () => provider });
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => { setup = await testRender(
    <TestPaneProvider state={state} dispatch={() => {}} paneId={paneId} pluginId="ticker-research" runtime={runtime}>
      <HistoricalPricesPane paneId={paneId} paneType="historical-prices" focused width={110} height={10} />
    </TestPaneProvider>, { width: 110, height: 10 },
  ); });
  try {
    await act(async () => { await Promise.resolve(); await setup.renderOnce(); });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("0.00000532");
    expect(frame).toContain("0.00000542");
    expect(frame).toContain("0.00000501");
    expect(frame).toContain("-2e-8");
    expect(frame).toContain("0.00000001");
  } finally { await act(async () => { setup.renderer.destroy(); }); }
});
