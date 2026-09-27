import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { emitKeypress, testRender } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { AnalystRatingRecord, AnalystResearchData } from "../../../types/financials";
import type { DataProvider } from "../../../types/data-provider";
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

function AnalystHarness({ provider, height }: { provider: DataProvider; height: number }) {
  const config = createTestPaneConfig("/tmp/gloomberb-analyst-pane-test", {
    instanceId: TEST_PANE_ID,
    paneId: "analyst-research",
    binding: { kind: "fixed", symbol: "NKE" },
  });

  const state = createInitialState(config);
  state.focusedPaneId = TEST_PANE_ID;
  state.tickers = new Map([["NKE", createTestTicker("NKE", "NKE", { exchange: "NYSE" })]]);

  return (
    <TestPaneProvider state={state} paneId={TEST_PANE_ID} pluginId="ticker-research" runtime={createTestPluginRuntime({ getMarketData: () => provider })}>
      <PaneFooterProvider>
        {(footer) => (
          <Box flexDirection="column" width={WIDTH} height={height}>
            <Box width={WIDTH} height={height - 1}>
              <AnalystResearchView width={WIDTH} height={height - 1} focused />
            </Box>
            <PaneFooterBar footer={footer} focused width={WIDTH} />
          </Box>
        )}
      </PaneFooterProvider>
    </TestPaneProvider>
  );
}

async function renderHarness(data: AnalystResearchData, height = HEIGHT): Promise<void> {
  const provider = {
    id: "test",
    name: "Test",
    getAnalystResearch: async () => data,
  } as unknown as DataProvider;
  await act(async () => {
    testSetup = await testRender(<AnalystHarness provider={provider} height={height} />, { width: WIDTH, height });
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
    ...research,
    recommendations: [{ period: "0m", strongBuy: 5, buy: 10, hold: 8, sell: 1, strongSell: 1 }],
  });

  const frame = testSetup!.captureCharFrame();
  expect(frame).toMatch(/Consensus\s+\$50\.46/);
  // Strong ratings fold into Buy and Sell, drawn as one split bar.
  expect(frame).toMatch(/Ratings\s+15 Buy · 8 Hold · 2 Sell █+/);
  expect(frame).toContain("$47 → $42");
  expect(frame).toContain("$61");
  const noTargetRow = frame.split("\n").find((line) => line.includes("No Target"));
  expect(noTargetRow).toBeDefined();
  expect(noTargetRow).not.toMatch(/\$\d/);
  expect(noTargetRow).toContain("-");
});

/**
 * The consensus context used to sit in a fixed block above a table that could
 * not be moved through at all, because the pane declared no row selection.
 */
test("arrows walk the actions while the consensus context stays in the status bar", async () => {
  // Newest first, one action a day, so row order follows the firm number.
  const ratings: AnalystRatingRecord[] = Array.from({ length: 40 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 7, 26) - index * 86_400_000).toISOString().slice(0, 10),
    firm: `Firm ${String(index).padStart(2, "0")}`,
    action: "Raises",
    current: "Buy",
    currentPriceTarget: 40 + index,
  }));
  await renderHarness({ ...research, ratings, fetchedAt: "2026-08-27T10:00:00Z" }, 24);

  const before = testSetup!.captureCharFrame();
  expect(before).toContain("low $23.00 med $46.50 high $94.00");
  expect(before).toContain("rating 6.1/10");
  expect(before).toContain("upside vs $38.40");
  // The reported consensus is the one target figure; the rebuilt mean's line
  // is named with its firm count and leaves its level to the axis.
  expect(before).toMatch(/Consensus\s+\$50\.46/);
  expect(before).toMatch(/● Mean target\s+40 firms/);
  expect(before).not.toMatch(/Mean target \$/);
  expect(before).not.toContain("Upside reference price");

  const offscreenFirm = "Firm 20";
  expect(before).toContain("Firm 00");
  expect(before).not.toContain(offscreenFirm);
  for (let step = 0; step < 20; step += 1) {
    await emitKeypress(testSetup!, { name: "down", sequence: "\u001b[B" }, { frames: 2 });
  }
  await act(async () => { await Bun.sleep(200); await testSetup!.renderOnce(); });
  expect(testSetup!.captureCharFrame()).toContain(offscreenFirm);
});

test("the selected action is the mean-target cursor, and a short pane keeps the actions", async () => {
  const ratings: AnalystRatingRecord[] = Array.from({ length: 12 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 7, 26) - index * 86_400_000).toISOString().slice(0, 10),
    firm: `Firm ${String(index).padStart(2, "0")}`,
    action: "Raises",
    current: "Buy",
    currentPriceTarget: 40 + index,
  }));
  await renderHarness({ ...research, ratings }, 24);
  // Every firm's latest target: 40 through 51.
  expect(testSetup!.captureCharFrame()).toMatch(/● Mean target\s+12 firms/);
  await emitKeypress(testSetup!, { name: "down", sequence: "\u001b[B" }, { frames: 2 });
  await act(async () => { await Bun.sleep(200); await testSetup!.renderOnce(); });
  // The day before, Firm 00 had not published: 41 through 51.
  expect(testSetup!.captureCharFrame()).toMatch(/● Mean target\s+11 firms/);
  await emitKeypress(testSetup!, { name: "left" }, { frames: 2 });
  await act(async () => { await Bun.sleep(50); await testSetup!.renderOnce(); });
  expect(testSetup!.captureCharFrame()).toMatch(/● Mean target\s+10 firms/);
  await act(async () => testSetup!.renderer.destroy());

  // Eleven rows: the figures, the strip, then the table's header and rows.
  await renderHarness({ ...research, ratings }, 11);
  const lines = testSetup!.captureCharFrame().split("\n");
  expect(lines[1]).toMatch(/^ ● Mean target [⠀-⣿]+\s*$/);
  expect(lines[2]).toContain("FIRM");
  expect(lines.filter((line) => line.includes("Raises")).length).toBeGreaterThanOrEqual(4);
});
