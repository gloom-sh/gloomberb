import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { getSharedMarketDataCoordinator, MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import type { QueryEntry } from "../../../market-data/result-types";
import { testRender } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestPaneConfig, createTestTicker, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { PricePoint } from "../../../types/financials";
import { BacktestPane } from "./pane";

const PANE_ID = "backtest:layout-test";
const SYMBOL = "BTTEST";
let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let previousCoordinator: ReturnType<typeof getSharedMarketDataCoordinator>;

/** Three years of sessions that trend up with a dip, so both rules fire. */
function history(): PricePoint[] {
  const start = Date.UTC(2023, 0, 2);
  return Array.from({ length: 900 }, (_, index) => {
    const close = 100 + index * 0.2 + Math.sin(index / 40) * 12;
    return { date: new Date(start + index * 86_400_000), open: close, high: close, low: close, close, volume: 1_000 };
  });
}

function installCoordinator() {
  previousCoordinator = getSharedMarketDataCoordinator();
  const points = history();
  const entry: QueryEntry<PricePoint[]> = {
    phase: "ready", data: points, lastGoodData: points, source: "test", fetchedAt: Date.now(),
    staleAt: null, error: null, attempts: [],
  };
  const coordinator = new MarketDataCoordinator(createTestDataProvider({ id: "backtest-pane-fixture" }));
  coordinator.loadChart = async () => entry;
  setSharedMarketDataCoordinator(coordinator);
}

afterEach(async () => {
  if (setup) {
    await act(async () => {
      setup!.renderer.destroy();
    });
    setup = undefined;
  }
  setSharedMarketDataCoordinator(previousCoordinator ?? null);
});

async function renderPane(width: number, height: number) {
  installCoordinator();
  const config = createTestPaneConfig("/tmp/gloomberb-backtest-pane-test", {
    instanceId: PANE_ID, paneId: "backtest", binding: { kind: "fixed", symbol: SYMBOL },
  });
  const state = createInitialState(config);
  state.tickers.set(SYMBOL, createTestTicker(SYMBOL, SYMBOL, { exchange: "NASDAQ", currency: "USD", assetCategory: "STK" }));
  setup = await testRender(
    <TestPaneProvider state={state} paneId={PANE_ID} pluginId="backtest" runtime={createTestPluginRuntime()}>
      <BacktestPane paneId={PANE_ID} paneType="backtest" focused width={width} height={height} />
    </TestPaneProvider>,
    { width, height },
  );
  for (let frame = 0; frame < 8; frame += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await setup!.renderOnce();
    });
  }
  return setup.captureCharFrame();
}

/** The row holding the metrics table header. */
function metricsHeaderRow(frame: string) {
  const lines = frame.split("\n");
  const row = lines.findIndex((line) => line.includes("METRIC"));
  return { row, line: lines[row] ?? "" };
}

test("a default-size pane body (118 cells in the terminal) puts the metrics beside the chart", async () => {
  const frame = await renderPane(118, 32);
  const { row, line } = metricsHeaderRow(frame);
  expect(row).toBeGreaterThanOrEqual(0);
  // Side by side: the chart legend and the table header share a row, the table right of the chart.
  expect(line.indexOf("● Buy & hold")).toBeGreaterThanOrEqual(0);
  expect(line.indexOf("METRIC")).toBeGreaterThan(118 - 50 - 1);
  // Every metric row fits beside the chart.
  expect(frame).toContain("Average hold (sessions)");
});

test("a narrower pane stacks the metrics under the chart", async () => {
  const frame = await renderPane(100, 32);
  const { row, line } = metricsHeaderRow(frame);
  expect(row).toBeGreaterThan(8);
  expect(line.indexOf("METRIC")).toBeLessThan(4);
});

test("a short stacked pane sizes the chart with the kit: the legend names the lines over the metrics' first rows", async () => {
  const frame = await renderPane(60, 16);
  const lines = frame.split("\n");
  const { row } = metricsHeaderRow(frame);
  expect(lines.slice(0, row).join("\n")).toContain("● Buy & hold");
  expect(lines.slice(0, row).join("\n")).toContain("● Strategy");
  // The table keeps its header and four metrics under the chart.
  for (const label of ["Total return", "CAGR", "Volatility (ann.)", "Sharpe (0% cash)"]) {
    expect(lines.slice(row).join("\n")).toContain(label);
  }
});

test("a pane too short for the chart keeps the metrics and shows the strategy as a strip", async () => {
  const frame = await renderPane(60, 10);
  const lines = frame.split("\n");
  const { row } = metricsHeaderRow(frame);
  const strip = lines[row - 1]!;
  expect(strip).toContain("● Strategy");
  expect(strip).toMatch(/×\d/);
  expect(lines.slice(row).join("\n")).toContain("Max drawdown");
});
