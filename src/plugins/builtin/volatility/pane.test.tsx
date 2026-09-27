import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act, useState } from "react";
import { apiClient } from "../../../api-client";
import { PaneFooterProvider } from "../../../components/layout/pane/footer";
import { setSharedMarketDataCoordinator, type MarketDataCoordinator } from "../../../market-data/coordinator";
import type { ChartRequest } from "../../../market-data/request-types";
import { createIdleEntry, type QueryEntry } from "../../../market-data/result-types";
import { emitKeypress, testRender } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { PricePoint } from "../../../types/financials";
import { VolatilityPane } from "./pane";

const DAY_MS = 86_400_000;
// Business days from late July to Friday Sep 25; the look-backs land on Sep 18 and Aug 25.
const DAYS = Array.from({ length: 62 }, (_, index) => new Date(Date.parse("2026-07-27") + index * DAY_MS))
  .filter((date) => date.getUTCDay() !== 0 && date.getUTCDay() !== 6).map((date) => date.toISOString().slice(0, 10));
const LEVELS: Record<string, { base: number; "2026-09-25": number; "2026-09-18": number; "2026-08-25": number }> = {
  "^VIX9D": { base: 13, "2026-09-25": 12.76, "2026-09-18": 12.27, "2026-08-25": 13.45 },
  "^VIX": { base: 15, "2026-09-25": 14.87, "2026-09-18": 14.81, "2026-08-25": 15.45 },
  "^VIX3M": { base: 18, "2026-09-25": 17.93, "2026-09-18": 18.24, "2026-08-25": 18.21 },
  "^VIX6M": { base: 20, "2026-09-25": 20.01, "2026-09-18": 20.21, "2026-08-25": 20.84 },
};

function history(symbol: string): PricePoint[] {
  const levels = LEVELS[symbol];
  // The 1Y index has a single print, so its look-backs are gaps.
  if (!levels) return symbol === "^VIX1Y" ? [{ date: new Date("2026-09-25T20:15:00Z"), close: 21.6 }] : [];
  return DAYS.map((date, index) => ({ date: new Date(`${date}T20:15:00Z`),
    close: levels[date as "2026-09-25"] ?? levels.base + (index % 4) / 10 }));
}

function ready(data: PricePoint[]): QueryEntry<PricePoint[]> {
  return { phase: "ready", data, lastGoodData: data, source: "test", fetchedAt: 1, staleAt: null, error: null, attempts: [] };
}

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let spies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
  setSharedMarketDataCoordinator({
    subscribe: () => () => {},
    subscribeKeys: () => () => {},
    getVersion: () => 1,
    subscribeQuotes: () => () => {},
    getQuoteEntry: () => createIdleEntry(),
    loadQuotesBatch: async () => {},
    getChartEntry: () => createIdleEntry(),
    loadChart: async (request: ChartRequest) => ready(history(request.instrument.symbol)),
  } as unknown as MarketDataCoordinator);
  spies = [
    spyOn(apiClient, "getCloudFredSeries").mockImplementation(async () => { throw new Error("offline"); }),
    spyOn(apiClient, "impliedVolatility").mockImplementation(async () => ({ series: [] }) as never),
  ];
});

afterEach(async () => {
  if (setup) await act(async () => setup?.renderer.destroy());
  setup = undefined;
  setSharedMarketDataCoordinator(null);
  for (const spy of spies) spy.mockRestore();
});

/** Long enough for the table to commit a keyboard move, which it holds back 150ms. */
async function settle() {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); await setup!.renderOnce(); });
  }
}

async function renderPane(width: number, height: number) {
  const paneId = "volatility:curve";
  const state = createInitialState(createTestPaneConfig("/tmp/gloomberb-vix-pane-test", {
    instanceId: paneId, paneId: "volatility-term-structure", binding: { kind: "none" }, settings: { initialTab: "curve" },
  }));
  const runtime = createTestPluginRuntime();
  function Harness() {
    const [paneState, setPaneState] = useState(state.paneState);
    state.paneState = paneState;
    return <TestPaneProvider state={state} dispatch={(action) => setPaneState(appReducer(state, action).paneState)} paneId={paneId}
      pluginId="volatility" runtime={runtime}>
      <PaneFooterProvider>{() => <VolatilityPane paneId={paneId} paneType="volatility-term-structure" width={width} height={height} focused />}</PaneFooterProvider>
    </TestPaneProvider>;
  }
  await act(async () => { setup = await testRender(<Harness />, { width, height }); });
  await settle();
}

const lines = () => setup!.captureCharFrame().replace(/\n+$/, "").split("\n");
const readout = () => lines().find((line) => /^ \d+[DMY] \d+\.\d\d/.test(line))?.trim() ?? "";
const tenorRows = () => lines().filter((line) => /^ (9D|30D|3M|6M|1Y) +\d+\.\d\d/.test(line));

test("the curve names IV and its look-backs, and the tenors show how far each moved", async () => {
  await renderPane(108, 32);
  const frame = setup!.captureCharFrame();
  expect(frame).toMatch(/IV % by tenor {3}● IV {3}● 1W ago {3}● 1M ago/);
  expect(frame).toMatch(/\n9D +30D +3M +6M +1Y +\n/);
  expect(frame).toMatch(/TENOR +IV +1W CHG +1M CHG/);
  expect(frame).toMatch(/30D +14\.87 +\+0\.06 +-0\.58/);
  // One close of the 1Y index: no week or month back to compare with.
  expect(frame).toMatch(/1Y +21\.60 +-- +--/);
  // The default selection is the VIX itself, so the curve's point is the 30D.
  expect(readout()).toBe("30D 14.87  1W ago +0.06  1M ago -0.58");
  expect(frame).not.toContain("yAxis");
});

test("the selected tenor is the curve's point", async () => {
  await renderPane(108, 32);
  await emitKeypress(setup!, { name: "down" });
  await settle();
  expect(readout()).toBe("3M 17.93  1W ago -0.31  1M ago -0.28");
  await emitKeypress(setup!, { name: "up" });
  await settle();
  await emitKeypress(setup!, { name: "up" });
  await settle();
  expect(readout()).toBe("9D 12.76  1W ago +0.49  1M ago -0.69");
  // The tab strip keeps Left and Right, as in any pane with tabs.
  await emitKeypress(setup!, { name: "right" });
  await settle();
  expect(readout()).toBe("");
});

test("a short pane keeps every tenor and turns the curve into a strip, then drops it", async () => {
  await renderPane(40, 10);
  let rows = lines();
  expect(rows.some((line) => /^ ● IV % .*30D 14\.87/.test(line))).toBe(true);
  expect(tenorRows()).toHaveLength(5);
  await act(async () => setup?.renderer.destroy());
  await renderPane(40, 7);
  rows = lines();
  expect(rows.some((line) => line.includes("●"))).toBe(false);
  expect(tenorRows().length).toBeGreaterThanOrEqual(4);
});
