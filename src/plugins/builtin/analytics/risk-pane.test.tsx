import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { act, useState } from "react";
import { apiClient } from "../../../api-client";
import { PaneFooterProvider } from "../../../components/layout/pane/footer";
import { emitKeypress, testRender } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createTestTicker } from "../../../test-support/ticker";
import { portfolioRiskCache } from "./risk-client";
import { PortfolioRiskPane } from "./risk-pane";
import { now, riskHistory, riskQuote } from "./risk-test-data";

const PANE_ID = "analytics:risk-test";
let setup: Awaited<ReturnType<typeof testRender>> | undefined;
const spies: Array<{ mockRestore(): void }> = [];

/** Each symbol wobbles on its own phase, so the basket, SPY and the factor spreads differ. */
function history(symbol: string, exchange: string) {
  const phase = [...symbol].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 7;
  const response = riskHistory();
  response.data = response.data.map((row, index) => {
    const close = 100 + index * (0.05 + phase / 100) + Math.sin(index / 3 + phase) * 3;
    return { ...row, open: close, high: close, low: close, close };
  });
  response.providerMeta = { ...response.providerMeta!, normalizedSymbol: symbol, normalizedExchange: exchange };
  return response;
}

beforeEach(() => {
  // The fixtures end the session before this, and the loader dates its requests from the clock.
  setSystemTime(now);
  portfolioRiskCache.reset();
  spies.push(
    spyOn(apiClient, "getCloudQuotesBatch").mockImplementation(async (requested) => ({
      status: "success",
      data: { items: requested.map((row) => ({ ...row, status: "success", data: riskQuote(row.symbol, row.exchange) })) },
    }) as never),
    spyOn(apiClient, "getCloudHistory").mockImplementation(async (symbol: string, exchange: string) => history(symbol, exchange)),
    spyOn(apiClient, "getCloudFredSeries").mockImplementation(async () => { throw new Error("FRED offline in tests"); }),
  );
});

afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  if (setup) {
    await act(async () => setup?.renderer.destroy());
    setup = undefined;
  }
  setSystemTime();
});

async function settle() {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await setup!.renderOnce();
    });
  }
}

async function renderPane(width: number, height: number, settings: Record<string, unknown> = {}) {
  const config = createTestPaneConfig("/tmp/gloomberb-risk-pane-test", {
    paneId: "analytics", instanceId: PANE_ID, params: { portfolioId: "main" }, settings: { analyticsView: "risk", ...settings },
  });
  config.portfolios = [{ id: "main", name: "Main", currency: "USD" }];
  const runtime = createTestPluginRuntime();
  function Harness() {
    const [paneState, setPaneState] = useState<AppState["paneState"]>({});
    const state = createInitialState(config);
    state.tickers = new Map([["AAPL", 40], ["XOM", 50]].map(([symbol, shares]) => [symbol as string, createTestTicker(symbol as string, symbol as string, {
      exchange: symbol === "XOM" ? "NYSE" : "NASDAQ", portfolios: ["main"],
      positions: [{ portfolio: "main", shares: shares as number, avgCost: 90, currency: "USD", broker: "manual" }],
    })]));
    state.paneState = paneState;
    const dispatch = (action: AppAction) => setPaneState((current) => appReducer({ ...state, paneState: current }, action).paneState);
    return (
      <TestPaneProvider state={state} dispatch={dispatch} paneId={PANE_ID} pluginId="analytics" runtime={runtime}>
        <PaneFooterProvider>{() => <PortfolioRiskPane paneId={PANE_ID} paneType="analytics" focused width={width} height={height} />}</PaneFooterProvider>
      </TestPaneProvider>
    );
  }
  await act(async () => {
    setup = await testRender(<Harness />, { width, height });
  });
  await settle();
  return () => setup!.captureCharFrame().split("\n");
}

/** The value a table row shows, read from its line below the table header. */
function rowValue(lines: string[], label: string): string {
  const header = lines.findIndex((line) => line.includes("METRIC"));
  const row = lines.slice(header + 1).find((line) => line.trimStart().startsWith(label));
  return row?.match(/(-?\d+\.\d+%)/)?.[1] ?? "";
}

test("the risk chart names the metric it plots and follows the selected row", async () => {
  // The default floating size's body.
  const frame = await renderPane(78, 28);
  let lines = frame();
  const basket = rowValue(lines, "60D basket return");
  const benchmark = rowValue(lines, "60D benchmark return");
  expect(basket).not.toBe("");
  // The return rows chart the basket against SPY over their window, ending on the rows' values.
  const legend = lines.findIndex((line) => line.includes("● 60D basket return"));
  expect(lines[legend]).toContain(`● 60D basket return ${basket}`);
  expect(lines[legend]).toContain(`● 60D benchmark return ${benchmark}`);
  expect(lines.findIndex((line) => line.includes("METRIC"))).toBeGreaterThan(legend + 6);

  // Another row plots its own history, named by the row.
  for (const _ of [1, 2]) {
    await emitKeypress(setup!, { name: "down" });
    await settle();
  }
  lines = frame();
  expect(lines.some((line) => line.includes(`● 60D active return ${rowValue(lines, "60D active return")}`))).toBe(true);
  expect(lines.some((line) => line.includes("● 60D basket return"))).toBe(false);
});

test("a short risk pane keeps every metric row and folds the chart into a strip", async () => {
  const lines = (await renderPane(60, 12))();
  const header = lines.findIndex((line) => line.includes("METRIC"));
  expect(lines.slice(0, header).some((line) => line.startsWith(" ● 60D basket return"))).toBe(true);
  expect(lines.slice(header + 1).filter((line) => /^ (60D|1D) /.test(line))).toHaveLength(8);
});

test("the performance tab charts the account TWR over its metrics", async () => {
  const evidence = {
    version: 1, portfolioId: "main", currency: "USD", source: "Dated account statement",
    performance: {
      flowTiming: "end-of-day", externalFlowsComplete: true,
      observations: Array.from({ length: 12 }, (_, index) => ({
        date: new Date(Date.UTC(2025, 9 + index, 1)).toISOString().slice(0, 10),
        value: 100_000 + index * 2_000 + (index % 3) * 1_500 + (index >= 6 ? 10_000 : 0),
        externalFlow: index === 6 ? 10_000 : 0,
      })),
    },
  };
  const lines = (await renderPane(78, 28, { riskView: "performance", riskEvidence: JSON.stringify(evidence) }))();
  const twr = rowValue(lines, "TWR");
  expect(twr).not.toBe("");
  const legend = lines.findIndex((line) => line.includes(`● TWR ${twr}`));
  expect(legend).toBeGreaterThan(0);
  expect(lines.findIndex((line) => line.includes("METRIC"))).toBeGreaterThan(legend + 6);
});
