import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { getSharedMarketDataCoordinator, MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import type { QueryEntry } from "../../../market-data/result-types";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestPaneConfig, createTestTicker, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { PricePoint } from "../../../types/financials";
import { BacktestPane } from "./pane";

const PANE_ID = "backtest:layout-test";
const SYMBOL = "BTTEST";
const tui = createOpenTuiTestHarness();
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

afterEach(() => {
  setSharedMarketDataCoordinator(previousCoordinator ?? null);
});

async function renderPane(width: number, height: number) {
  installCoordinator();
  const config = createTestPaneConfig("/tmp/gloomberb-backtest-pane-test", {
    instanceId: PANE_ID, paneId: "backtest", binding: { kind: "fixed", symbol: SYMBOL },
  });
  const state = createInitialState(config);
  state.tickers.set(SYMBOL, createTestTicker(SYMBOL, SYMBOL, { exchange: "NASDAQ", currency: "USD", assetCategory: "STK" }));
  await tui.render(
    <TestPaneProvider state={state} paneId={PANE_ID} pluginId="backtest" runtime={createTestPluginRuntime()}>
      <BacktestPane paneId={PANE_ID} paneType="backtest" focused width={width} height={height} />
    </TestPaneProvider>,
    { width, height },
  );
  for (let frame = 0; frame < 8; frame += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await tui.setup().renderOnce();
    });
  }
  return tui.frame();
}

/** The row holding the metrics table header. */
function metricsHeaderRow(frame: string) {
  const lines = frame.split("\n");
  const row = lines.findIndex((line) => line.includes("METRIC"));
  return { row, line: lines[row] ?? "" };
}

test("a wide pane body puts the metrics beside a chart that keeps its legend", async () => {
  const frame = await renderPane(130, 32);
  const { row, line } = metricsHeaderRow(frame);
  expect(row).toBeGreaterThanOrEqual(0);
  // Side by side: the chart legend and the table header share a row, the table right of the chart.
  expect(line.indexOf("• Buy & hold")).toBeGreaterThanOrEqual(0);
  expect(line.indexOf("METRIC")).toBeGreaterThan(130 - 68 - 1);
  // Every metric row fits beside the chart, the price return with what it leaves out.
  expect(frame).toContain("Average hold (sessions)");
  expect(frame).toContain("Price return (distributions not included)");
});

test("a default-size pane (118 cells in the terminal) stacks the metrics under the chart, the price return whole", async () => {
  const frame = await renderPane(118, 32);
  const { row, line } = metricsHeaderRow(frame);
  expect(row).toBeGreaterThan(8);
  expect(line.indexOf("METRIC")).toBeLessThan(4);
  expect(frame).toContain("Price return (distributions not included)");
});

test("a short stacked pane sizes the chart with the kit: the legend names the lines over the metrics' first rows", async () => {
  const frame = await renderPane(60, 16);
  const lines = frame.split("\n");
  const { row } = metricsHeaderRow(frame);
  expect(lines.slice(0, row).join("\n")).toContain("• Buy & hold");
  expect(lines.slice(0, row).join("\n")).toContain("+ Strategy");
  // The table keeps its header and four metrics under the chart.
  for (const label of ["Price return (distributions", "CAGR", "Volatility (ann.)", "Sharpe (0% cash)"]) {
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
