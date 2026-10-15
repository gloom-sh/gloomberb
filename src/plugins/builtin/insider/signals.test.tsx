import { afterEach, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, useMemo, useReducer } from "react";
import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { InsiderSignalRow, InsiderSignalsPayload } from "../../../api-client/insider-signals";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { TestPaneFrame, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createStatefulTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { findPaneInstance } from "../../../types/config";
import { insiderModule } from "./index";
import { insiderSignalsCache } from "./signals-client";
import { buildInsiderSignalColumns, insiderSignalsCoverageNotice } from "./signals-model";

const InsiderPane = insiderModule.panes![0]!.component;
const tui = createOpenTuiTestHarness();
const PANE_ID = "insider:signals:test";

// Invented companies and people.
function signalRow(ticker: string, company: string, score: number, reasons: string[], value: number): InsiderSignalRow {
  return {
    ticker, issuerCik: "9900001", company, score, reasons, insiders: reasons[0]!.startsWith("3 insiders") ? 3 : 1, buys: 2, value,
    shares: 10_000, firstBuy: "2026-10-01", lastBuy: "2026-10-14", lastFiled: "2026-10-14",
    signals: { clusterInsiders: 1, repeatBuys: 1, usualRatio: null, stakeIncreasePct: null, newPosition: false },
    buyers: [{ name: "Rivera Ana", role: "CEO", value, buys: 1, lastBuy: "2026-10-14" }],
  };
}
const ROWS = [
  signalRow("NWBI", "Northwind Biologics Inc", 78, ["3 insiders, $1.2M in 14 days", "CFO raised stake 56%"], 1_152_500),
  signalRow("CTSO", "Contoso Energy Corp", 72, ["CEO's 4th buy in 90 days, 4.9x usual size", "CEO bought $610k"], 610_000),
  signalRow("FBKM", "Fabrikam Bancorp", 33, ["Director bought $720k", "Director opened a new position"], 720_000),
];
function payload(window: number, rows = ROWS): InsiderSignalsPayload {
  return { window, through: "2026-10-15", asOf: "2026-10-14", coverage: { from: "2026-08-31", through: "2026-10-14" }, rows };
}

let state: AppState | null = null;
function Harness({ width }: { width: number }) {
  const config = createTestPaneConfig(join(tmpdir(), "gloom-insider-signals-test"), { instanceId: PANE_ID, paneId: "insider", title: "Insider Buying" });
  const [current, dispatch] = useReducer(appReducer, config, (initialConfig) => {
    const initial = createInitialState(initialConfig);
    initial.tickers = new Map(ROWS.map((row) => [row.ticker, createTestTicker(row.ticker, row.company)]));
    initial.focusedPaneId = PANE_ID;
    return initial;
  });
  state = current;
  const runtime = useMemo(() => createStatefulTestPluginRuntime(), []);
  return <TestPaneFrame state={current} dispatch={dispatch} paneId={PANE_ID} pluginId="insider" runtime={runtime} width={width} height={20} footerKeys>
    {(body) => <InsiderPane paneId={PANE_ID} paneType="insider" focused {...body} />}
  </TestPaneFrame>;
}
const pane = () => findPaneInstance(state!.config.layout, PANE_ID)!;

async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => { await Bun.sleep(2); await tui.setup().renderOnce(); });
}
async function mount(load: (window: number) => Promise<InsiderSignalsPayload>, width = 140) {
  const windows: number[] = [];
  spyOn(apiClient, "getCloudSecInsiderSignals").mockImplementation(async (params = {}) => {
    windows.push(params.window ?? 30);
    return load(params.window ?? 30);
  });
  // The company opened from the ranking reads its own filings.
  setSharedMarketDataCoordinator(new MarketDataCoordinator(createTestDataProvider({ getSecFilings: async () => [] })));
  await act(async () => { await tui.render(<Harness width={width} />, { width, height: 20 }); });
  await settle();
  return windows;
}

afterEach(() => {
  insiderSignalsCache.reset();
  setSharedMarketDataCoordinator(null);
});

test("ranks companies with the reasons; Enter opens one here and Esc comes back to the same row", async () => {
  await mount(async (window) => payload(window));
  let frame = tui.frame();
  expect(frame).toMatch(/NWBI\s+Northwind Biologics Inc\s+78\s+3 insiders, \$1\.2M in 14 days · CFO raised stake 56%/);
  expect(frame).toMatch(/CTSO\s+Contoso Energy Corp\s+72\s+CEO's 4th buy in 90 days, 4\.9x usual size/);
  expect(frame).toContain("as of Oct 14, 2026");
  // Footers follow the conventions: no generic key hints for Enter or Esc.
  expect(frame).not.toContain("[Enter]");

  await tui.emitKeypress({ name: "down", sequence: "\u001b[B" }, { trackPropagation: true });
  await act(async () => { tui.setup().mockInput.pressEnter(); });
  await settle();
  expect(pane().binding).toEqual({ kind: "fixed", symbol: "CTSO" });
  expect(pane().title).toBe("INS CTSO");
  frame = tui.frame();
  expect(frame).not.toContain("Northwind Biologics");

  await tui.emitKeypress({ name: "escape", sequence: "\u001b" }, { frames: 2, trackPropagation: true, afterCommit: true });
  await settle();
  expect(pane().binding).toEqual({ kind: "none" });
  expect(pane().title).toBe("Insider Buying");
  frame = tui.frame();
  expect(frame).toContain("Northwind Biologics");
  // Back lands on the row it opened: Enter opens CTSO again.
  await act(async () => { tui.setup().mockInput.pressEnter(); });
  await settle();
  expect(pane().binding).toEqual({ kind: "fixed", symbol: "CTSO" });
});

test("the window is a query-bar choice and a double click opens a row", async () => {
  const windows = await mount(async (window) => payload(window, window === 7 ? [ROWS[2]!] : ROWS));
  await tui.clickFrameText("7D");
  await settle();
  expect(windows).toEqual([30, 7]);
  expect(tui.frame()).not.toContain("Northwind Biologics");
  await tui.clickFrameText("Fabrikam Bancorp");
  await tui.clickFrameText("Fabrikam Bancorp");
  await settle();
  expect(pane().binding).toEqual({ kind: "fixed", symbol: "FBKM" });
});

test("an empty window, a failure and a refused session each say so in the body", async () => {
  await mount(async (window) => payload(window, []));
  expect(tui.frame()).toContain("No open-market insider buying in the last 30 days.");
  // The query bar stays, so another window is one click away.
  expect(tui.frame()).toContain("90D");

  insiderSignalsCache.reset();
  await mount(async () => { throw new Error("Upstream timed out."); });
  expect(tui.frame()).toContain("Insider buying unavailable.");
  expect(tui.frame()).toContain("Upstream timed out.");

  insiderSignalsCache.reset();
  await mount(async () => { throw new ApiRequestError("Sign in required", 401); });
  expect(tui.frame()).toMatch(/[Ss]ign in/);
  expect(tui.frame()).not.toContain("Sign in required");
});

test("the footer warns when the window reaches past the filings read, or none has been read whole", async () => {
  const notice = (window: number, from: string | null) => insiderSignalsCoverageNotice({ window, through: "2026-10-15", coverage: { from, through: from ? "2026-10-14" : null } });
  expect(notice(30, "2026-08-31")).toBeNull();
  expect(notice(30, "2026-09-16")).toBeNull();
  expect(notice(30, "2026-09-17")).toBe("Form 4 filings are read from Sep 17, 2026, so this window leaves out buying before then.");
  expect(notice(7, "2026-10-01")).toBeNull();
  expect(notice(7, null)).toBe("Form 4 filings are still being read, so this ranking may leave out buying.");

  await mount(async (window) => ({ ...payload(window), coverage: { from: null, through: null } }));
  expect(tui.frame()).toContain("[!] as of Oct 14, 2026");
  insiderSignalsCache.reset();
  await mount(async (window) => payload(window));
  expect(tui.frame()).not.toContain("[!]");
});

test("a narrow pane keeps the reasons and drops the company, then the counts", () => {
  const ids = (width: number) => buildInsiderSignalColumns(width, ROWS).map((column) => column.id);
  expect(ids(110)).toEqual(["ticker", "company", "score", "why", "insiders", "value", "lastBuy"]);
  expect(ids(80)).toEqual(["ticker", "score", "why", "insiders", "value", "lastBuy"]);
  expect(ids(60)).toEqual(["ticker", "score", "why", "value"]);
  expect(buildInsiderSignalColumns(60, ROWS).find((column) => column.id === "why")!.width).toBeGreaterThanOrEqual(24);
});
