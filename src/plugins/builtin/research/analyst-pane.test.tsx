import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { AnalystResearchData } from "../../../types/financials";
import type { DataProvider } from "../../../types/data-provider";
import type { TickerRecord } from "../../../types/ticker";
import { Box } from "../../../ui";
import { AnalystResearchView } from "./analyst-pane";
import { TestPaneProvider, createTestTicker, createTestPaneConfig } from "../../../test-support/pane";

const TEST_PANE_ID = "analyst-research:NKE";
const WIDTH = 96;
const HEIGHT = 20;

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

const research: AnalystResearchData = {
  providerId: "test",
  symbol: "NKE",
  currency: "USD",
  priceTarget: { current: 38.4, average: 50.46, low: 23, median: 46.5, high: 94, currency: "USD" },
  recommendationRating: 6.1,
  recommendations: [],
  ratings: [
    {
      date: "2026-08-26",
      firm: "Truist Securities",
      action: "Downgrade",
      current: "Hold",
      prior: "Buy",
      currentPriceTarget: 42,
      priorPriceTarget: 47,
    },
    {
      date: "2026-08-25",
      firm: "Solo Target",
      action: "Initiates",
      current: "Buy",
      currentPriceTarget: 61,
    },
    {
      date: "2026-08-24",
      firm: "No Target",
      action: "Reiterates",
      current: "Buy",
      prior: "Buy",
    },
  ],
  earningsEstimates: [],
  revenueEstimates: [],
};

function makeTicker(symbol: string): TickerRecord {
  return createTestTicker(symbol, symbol, {
    exchange: "NYSE"
  });
}

function AnalystHarness({ provider }: { provider: DataProvider }) {
  const config = createTestPaneConfig("/tmp/gloomberb-analyst-pane-test", {
    instanceId: TEST_PANE_ID,
    paneId: "analyst-research",
    binding: { kind: "fixed", symbol: "NKE" },
  });

  const state = createInitialState(config);
  state.focusedPaneId = TEST_PANE_ID;
  state.tickers = new Map([["NKE", makeTicker("NKE")]]);

  return (
    <TestPaneProvider state={state} paneId={TEST_PANE_ID} pluginId="ticker-research" runtime={createTestPluginRuntime({ getMarketData: () => provider })}>
      <Box flexDirection="column" width={WIDTH} height={HEIGHT}>
        <AnalystResearchView width={WIDTH} height={HEIGHT} focused />
      </Box>
    </TestPaneProvider>
  );
}

async function renderHarness(provider: DataProvider): Promise<void> {
  await act(async () => {
    testSetup = await testRender(<AnalystHarness provider={provider} />, { width: WIDTH, height: HEIGHT });
  });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await act(async () => {
      await Bun.sleep(1);
      await testSetup!.renderOnce();
    });
  }
}

afterEach(async () => {
  if (testSetup) {
    await act(async () => testSetup!.renderer.destroy());
    testSetup = undefined;
  }
});

/**
 * The pane used to reach a source that carries the aggregate price target but
 * no per-rating targets, so every TARGET cell rendered as a dash under a
 * header that advertised an average target.
 */
test("renders each rating's price target and only dashes the rows without one", async () => {
  await renderHarness({
    id: "test",
    name: "Test",
    getAnalystResearch: async () => research,
  } as unknown as DataProvider);

  const frame = testSetup!.captureCharFrame();
  expect(frame).toContain("$50.46 avg target");
  expect(frame).toContain("$47 → $42");
  expect(frame).toContain("$61");
  const noTargetRow = frame.split("\n").find((line) => line.includes("No Target"));
  expect(noTargetRow).toBeDefined();
  expect(noTargetRow).not.toMatch(/\$\d/);
  expect(noTargetRow).toContain("-");
});
