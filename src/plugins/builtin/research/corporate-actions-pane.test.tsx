import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { testRender, emitKeypress } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { TestPaneProvider, createTestTicker, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { CorporateActionsData } from "../../../types/financials";
import { Box } from "../../../ui";
import { CorporateActionsView } from "./corporate-actions-pane";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;

async function frame() {
  await act(async () => { await Bun.sleep(1); });
  await act(async () => { await setup!.renderOnce(); });
}

async function render(actions: CorporateActionsData, variant: "corporate-actions" | "earnings-estimates", width = 80) {
  const paneId = `${variant}:TEST`;
  const config = createTestPaneConfig("/tmp/gloom-corporate-actions-pane-test", {
    instanceId: paneId, paneId: variant, binding: { kind: "fixed", symbol: "TEST" },
  });
  const state = createInitialState(config);
  state.focusedPaneId = paneId;
  state.tickers = new Map([["TEST", createTestTicker("TEST", "Test", { exchange: "ASX", currency: "AUD" })]]);
  const provider = createTestDataProvider({
    getCorporateActions: async () => actions,
    getAnalystResearch: async () => ({ symbol: "TEST", recommendations: [], ratings: [], earningsEstimates: [], revenueEstimates: [] }),
  });
  await act(async () => {
    setup = await testRender(
      <TestPaneProvider state={state} paneId={paneId} pluginId="ticker-research" runtime={createTestPluginRuntime({ getMarketData: () => provider })}>
        <Box width={width} height={24} flexDirection="column">
          <CorporateActionsView focused width={width} height={24} variant={variant} footerPaneId={variant} />
        </Box>
      </TestPaneProvider>,
      { width, height: 24 },
    );
  });
  for (let index = 0; index < 4; index++) await frame();
}

afterEach(async () => {
  if (setup) await act(async () => { setup!.renderer.destroy(); });
  setup = undefined;
});

test("opening a fiscal-period row cannot select a same-day pending announcement", async () => {
  await render({ symbol: "TEST", dividends: [], splits: [], earnings: [
    { date: "2026-09-30", dateType: "announcement", epsEstimate: 2.2 },
    { date: "2026-09-30", dateType: "fiscal-period-end", epsActual: 2, epsEstimate: 1.8, currency: "USD" },
  ] }, "earnings-estimates", 120);
  await emitKeypress(setup!, { name: "down" });
  await frame();
  await emitKeypress(setup!, { name: "return" });
  await frame();
  expect(setup!.captureCharFrame()).toContain("Actual: 2 USD | Consensus: 1.8 USD");
  expect(setup!.captureCharFrame()).not.toContain("Actual: - | Consensus: 2.2");
});

test.each(["corporate-actions", "earnings-estimates"] as const)("%s preserves unavailable source status with no visible rows", async (variant) => {
  await render({ symbol: "TEST", earnings: [], splits: [],
    dividends: variant === "earnings-estimates" ? [{ exDate: "2026-09-30", amount: 0.1 }] : [],
    coverage: { dividends: "available", splits: "unavailable", earnings: "unavailable" },
  }, variant);
  expect(setup!.captureCharFrame()).toContain(variant === "earnings-estimates" ? "Unavailable: earnings" : "Unavailable: splits, earnings");
});
