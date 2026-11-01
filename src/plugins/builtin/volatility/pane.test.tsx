import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { act, useState } from "react";
import { apiClient } from "../../../api-client";
import { setSharedMarketDataCoordinator, type MarketDataCoordinator } from "../../../market-data/coordinator";
import type { ChartRequest } from "../../../market-data/request-types";
import { createIdleEntry, type QueryEntry } from "../../../market-data/result-types";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { setAppVisible } from "../../../state/app/activity";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { PricePoint } from "../../../types/financials";
import { DataServiceUnreachableError } from "../../../utils/network-failure";
import { ApiRequestError } from "../../../api-client/errors";
import { attachFredSeriesPersistence, resetFredSeriesPersistence } from "../../../sources/gloomberb-cloud/fred-series";
import { outage } from "../../../test-support/outage";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
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

const tui = createOpenTuiTestHarness();
let spies: Array<{ mockRestore(): void }> = [];
/** The live re-reads of index levels in session, which fail while `levelReadFails` is set. */
let levelReads = 0;
let levelReadFails = false;

beforeEach(() => {
  levelReads = 0;
  levelReadFails = false;
  setSharedMarketDataCoordinator({
    subscribe: () => () => {},
    subscribeKeys: () => () => {},
    getVersion: () => 1,
    subscribeQuotes: () => () => {},
    getQuoteEntry: () => createIdleEntry(),
    loadQuotesBatch: async () => {
      levelReads += 1;
      if (levelReadFails) throw new DataServiceUnreachableError(new Error("offline"));
    },
    getChartEntry: () => createIdleEntry(),
    loadChart: async (request: ChartRequest) => ready(history(request.instrument.symbol)),
  } as unknown as MarketDataCoordinator);
  spies = [
    spyOn(apiClient, "getCloudFredSeries").mockImplementation(async () => { throw new Error("offline"); }),
    spyOn(apiClient, "impliedVolatility").mockImplementation(async () => ({ series: [] }) as never),
  ];
});

afterEach(() => {
  resetFredSeriesPersistence();
  setSystemTime();
  setAppVisible(true);
  setSharedMarketDataCoordinator(null);
  for (const spy of spies) spy.mockRestore();
});

/** Long enough for the table to commit a keyboard move, which it holds back 150ms. */
async function settle() {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); await tui.setup().renderOnce(); });
  }
}

async function renderPane(width: number, height: number, initialTab = "curve") {
  const paneId = "volatility:curve";
  const state = createInitialState(createTestPaneConfig("/tmp/gloomberb-vix-pane-test", {
    instanceId: paneId, paneId: "volatility-term-structure", binding: { kind: "none" }, settings: { initialTab },
  }));
  const runtime = createTestPluginRuntime();
  // The pane's own height, with the footer bar and its keys under it.
  function Harness() {
    const [paneState, setPaneState] = useState(state.paneState);
    state.paneState = paneState;
    return <TestPaneFrame state={state} dispatch={(action) => setPaneState(appReducer(state, action).paneState)} paneId={paneId}
      pluginId="volatility" runtime={runtime} width={width} height={height + 1} footerKeys>
      {(body) => <VolatilityPane paneId={paneId} paneType="volatility-term-structure" {...body} focused />}
    </TestPaneFrame>;
  }
  await act(async () => { await tui.render(<Harness />, { width, height: height + 1 }); });
  await settle();
}

const lines = () => tui.frame().replace(/\n+$/, "").split("\n");
/** The footer bar's status: its basis and date, then the hints. */
const footer = () => lines().at(-1)!.replace(/^└(⚠\[!\])?\s*|┘$/g, "").trim();
const view = () => {
  const frame = tui.frame();
  return frame.includes("IV % by tenor") ? "curve" : /LEVEL +1D PTS/.test(frame) ? "board" : frame.includes("VIX 30D") ? "history" : "none";
};
const readout = () => lines().find((line) => /^ \d+[DMY] \d+\.\d\d/.test(line))?.trim() ?? "";
const tenorRows = () => lines().filter((line) => /^ (9D|30D|3M|6M|1Y) +\d+\.\d\d/.test(line));

test("the curve names IV and its look-backs, and the tenors show how far each moved", async () => {
  await renderPane(108, 32);
  const frame = tui.frame();
  expect(frame).toMatch(/IV % by tenor {3}● IV {3}● 1W ago {3}● 1M ago/);
  // One word for the shape, as the report and the glossary say it.
  expect(frame).toContain("Contango");
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
  await tui.emitKeypress({ name: "down" });
  await settle();
  expect(readout()).toBe("3M 17.93  1W ago -0.31  1M ago -0.28");
  await tui.emitKeypress({ name: "up" });
  await settle();
  await tui.emitKeypress({ name: "up" });
  await settle();
  expect(readout()).toBe("9D 12.76  1W ago +0.49  1M ago -0.69");
  // The tab strip keeps Left and Right, as in any pane with tabs.
  await tui.emitKeypress({ name: "right" });
  await settle();
  expect(readout()).toBe("");
});

test("a short pane keeps every tenor and turns the curve into a strip, then drops it", async () => {
  await renderPane(40, 10);
  let rows = lines();
  expect(rows.some((line) => /^ ● IV % .*30D 14\.87/.test(line))).toBe(true);
  expect(tenorRows()).toHaveLength(5);
  await renderPane(40, 7);
  rows = lines();
  expect(rows.some((line) => line.includes("●"))).toBe(false);
  expect(tenorRows().length).toBeGreaterThanOrEqual(4);
});

test("a narrow board drops the name column before it cuts a date", async () => {
  await renderPane(78, 24, "board");
  const header = lines().find((line) => line.includes("LEVEL"))!;
  expect(header).toContain("AS OF");
  expect(header).not.toContain("NAME");
  expect(lines().some((line) => /^ VIX +14\.87 .* 2026-09-25 *$/.test(line))).toBe(true);
  await renderPane(110, 24, "board");
  expect(lines().find((line) => line.includes("LEVEL"))).toContain("NAME");
});

test("v steps through every view and back to the curve, though every view ends on the same close", async () => {
  await renderPane(108, 32);
  const seen = [[view(), footer()]];
  for (let press = 0; press < 3; press += 1) {
    await tui.emitKeypress({ name: "v", sequence: "v" });
    await settle();
    seen.push([view(), footer()]);
  }
  expect(seen.map(([name]) => name)).toEqual(["curve", "history", "board", "curve"]);
  expect(seen.map(([, line]) => line!.split(/ {2,}/)[0])).toEqual(Array(4).fill("close 2026-09-25"));
});

test("a day still trading is no close: the session so far until Cboe settles it at 16:15 New York", async () => {
  // Friday Sep 25, 15:00 and then 16:10 New York: the daily bar is the session so far.
  for (const now of ["2026-09-25T19:00:00Z", "2026-09-25T20:10:00Z"]) {
    setSystemTime(new Date(now));
    await renderPane(108, 32);
    expect(footer()).toMatch(/^today so far 2026-09-25 /);
  }
  setSystemTime(new Date("2026-09-25T20:16:00Z"));
  await renderPane(108, 32);
  expect(footer()).toMatch(/^close 2026-09-25 /);
});

// In session the index levels are re-read every 15 seconds; one that fails leaves the old levels on screen.
test("a failed live re-read of the index levels is a data warning until one succeeds", async () => {
  let now = Date.parse("2026-09-25T15:00:00Z");
  setSystemTime(new Date(now));
  await renderPane(108, 32);
  const warnings = async () => {
    await tui.emitKeypress({ name: "!", sequence: "!" });
    await settle();
    const frame = tui.frame();
    await tui.emitKeypress({ name: "escape" });
    await settle();
    return frame;
  };
  // Back after a stretch longer than the interval, the cycle re-reads at once.
  const reread = async () => {
    now += 20_000;
    setSystemTime(new Date(now));
    await act(async () => setAppVisible(false));
    await act(async () => setAppVisible(true));
    await settle();
  };
  expect(await warnings()).not.toContain("Gloom couldn't reach its data service");
  levelReadFails = true;
  await reread();
  expect(levelReads).toBe(1);
  expect(await warnings()).toContain("Gloom couldn't reach its data service");
  levelReadFails = false;
  await reread();
  expect(levelReads).toBe(2);
  expect(await warnings()).not.toContain("Gloom couldn't reach its data service");
});

// The FRED closes the board falls back on said "saved copy from" whatever their refresh failed with, after
// the pane's own status. They now lead the footer, as every pane's saved copy does, and a refusal is the error.
test("FRED closes a failed refresh left lead the footer with when they were saved; a refusal says its error instead", async () => {
  attachFredSeriesPersistence(new MemoryPluginPersistence());
  let failure: unknown = null;
  spies.push(spyOn(apiClient, "getCloudFredSeries").mockImplementation(async (id: string) => {
    if (failure) throw failure;
    return { info: null, observations: [{ date: "2026-09-24", value: id === "VIXCLS" ? 15 : 18 }] };
  }));
  setSystemTime(new Date("2026-09-25T13:05:00Z"));
  await renderPane(108, 32);
  expect(footer()).not.toContain("saved copy");

  setSystemTime(new Date("2026-09-26T13:05:00Z"));
  failure = outage();
  await renderPane(108, 32);
  // The fixture's indices with no closes keep their warning, after the saved copy.
  expect(footer()).toMatch(/^saved copy from Sep 25 \d\d:\d\d \S*\[!\] +close 2026-09-25 /);

  // The closes on screen stay, called stale, and the refusal is among the warnings (client.test.ts).
  failure = new ApiRequestError("Series not found", 404);
  await renderPane(108, 32);
  expect(footer()).toMatch(/^stale · close 2026-09-25 /);
});
