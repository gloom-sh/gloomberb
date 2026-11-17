import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act, useEffect, useReducer } from "react";
import { RemoteUiRegistryProvider, useRemoteUiRegistry, type RemoteUiRegistry } from "../../../remote/semantic-tree";
import { apiClient, type CloudFredSeriesPayload } from "../../../api-client";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { YieldCurvePane } from "./index";
import { TREASURY_MATURITIES } from "./treasury-data";
import { curveViewCache, worldCurvesCache } from "./client";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { DataServiceUnreachableError } from "../../../utils/network-failure";
import { ApiRequestError } from "../../../api-client/errors";
import type { CloudWorldCurves } from "../../../api-client/yield-curves";

const id = "yield-curve:test";
const tui = createOpenTuiTestHarness();
let latestSpy: ReturnType<typeof spyOn> | undefined;
let historySpy: ReturnType<typeof spyOn> | undefined;
let storedSpy: ReturnType<typeof spyOn> | undefined;
let registry: RemoteUiRegistry | null = null;

function RegistryProbe() {
  const value = useRemoteUiRegistry();
  useEffect(() => { registry = value; }, [value]);
  return null;
}

function Harness({ width = 90, height = 30, tab }: { width?: number; height?: number; tab?: "world" }) {
  const initial = createInitialState(createTestPaneConfig("/tmp/gloom-curve-test", { instanceId: id, paneId: "yield-curve", binding: { kind: "none" } }));
  initial.focusedPaneId = id;
  if (tab) initial.paneState[id] = { pluginState: { macro: { "yield-curve:tab": tab } } } as never;
  const [state, dispatch] = useReducer(appReducer, initial);
  return <TestPaneFrame state={state} dispatch={dispatch} paneId={id} pluginId="macro" runtime={createTestPluginRuntime()} width={width} height={height} footerKeys>
    {(body) => <YieldCurvePane paneId={id} paneType="yield-curve" focused {...body} />}
  </TestPaneFrame>;
}

async function frame() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await tui.setup().renderOnce(); });
}

/** Long enough for the table to commit a keyboard move, which it holds back 150ms. */
async function settle() {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); await tui.setup().renderOnce(); });
  }
}

const lines = () => tui.frame().split("\n");
const readout = () => lines().find((line) => /^ \d+[MY] \d+\.\d\d%/.test(line)) ?? "";

// The latest session on Sep 24, the session before on Sep 23 (a flatter curve),
// a week back on Sep 17 and a month back on Aug 24.
const LATEST = TREASURY_MATURITIES.map(({ maturity, years }, index) => ({ maturity, maturityYears: years, yield: 4 + index / 10, asOf: "2026-09-24" }));
function fredPayload(seriesId: string, options: { startDate?: string; endDate?: string } = {}): CloudFredSeriesPayload {
  const index = TREASURY_MATURITIES.findIndex((entry) => entry.seriesId === seriesId);
  const observations = [
    { date: "2026-09-23", value: 3.95 + index / 12 },
    { date: "2026-09-17", value: 3.9 + index / 10 },
    { date: "2026-08-24", value: 4.2 + index / 10 },
  ].filter((point) => (!options.startDate || point.date >= options.startDate) && (!options.endDate || point.date <= options.endDate));
  return { observations, info: { id: seriesId, title: "Treasury yield", units: "Percent", frequency: "Daily", seasonalAdjustment: "", source: "FRED", notes: "" } };
}

async function renderLatest(width: number, height: number) {
  latestSpy = spyOn(apiClient, "getCloudYieldCurve").mockResolvedValue(LATEST);
  historySpy = spyOn(apiClient, "getCloudFredSeries").mockImplementation(async (seriesId, options) => fredPayload(seriesId, options));
  await act(async () => { await tui.render(<RemoteUiRegistryProvider><RegistryProbe /><Harness width={width} height={height} /></RemoteUiRegistryProvider>, { width, height }); });
  await settle();
}

/** Calls for a curve on or before one date, leaving out the look-backs. */
const callsEndingOn = (date: string) => historySpy!.mock.calls.filter((call: unknown[]) => (call[1] as { endDate?: string })?.endDate === date).length;

// These cover the FRED fallback: the stored Treasury curve is unavailable (an older server).
beforeEach(() => {
  storedSpy = spyOn(apiClient, "getCloudCurve").mockRejectedValue(new Error("Not Found"));
});

afterEach(() => {
  registry = null;
  latestSpy?.mockRestore(); historySpy?.mockRestore(); storedSpy?.mockRestore();
  curveViewCache.reset(); worldCurvesCache.reset();
});

test("the chart names the curve and its look-backs, and the tenors show how far each moved", async () => {
  await renderLatest(90, 28);
  const frameText = tui.frame();
  // The spreads lead, with their move since the session before: 2s10s is 40bp, 33bp the day before.
  // The tab strip, then the query bar, then the figures.
  expect(lines()[0]).toMatch(/Curve +World/);
  expect(lines()[2]).toMatch(/2s10s \+40bp +\+7bp 1D +3m10y \+70bp +\+12bp 1D +5s30s \+40bp +\+7bp 1D/);
  expect(lines()[3]).toMatch(/Par yield % by maturity {3}● Par yield {3}● 1W ago {3}● 1M ago/);
  // A log axis gives the short end room to label its tenors.
  expect(frameText).toMatch(/\n1M +3M +6M +1Y .*10Y +30Y +\n/);
  expect(frameText).toMatch(/TENOR +PAR YIELD +1D CHG +1W CHG +1M CHG/);
  // 1M is 4.00% against 3.95% the day before, 3.90% a week back and 4.20% a month back.
  expect(frameText).toMatch(/1M +4\.00% +\+5bp +\+10bp +-20bp/);
  expect(readout().trim()).toBe("1M 4.00%  1W ago +10bp  1M ago -20bp");
  // Every look-back came from one request per tenor.
  expect(historySpy).toHaveBeenCalledTimes(TREASURY_MATURITIES.length);
});

test("a stored curve from a server that does not rank moves shows its spreads and no move figures", async () => {
  const points = (offset: number) => TREASURY_MATURITIES.map(({ maturity, years }, index) => ({ tenor: maturity, years, yield: 4 + offset + index / 10 }));
  // No `moves`: the response of a server from before move ranks.
  storedSpy?.mockResolvedValue({
    curve: { id: "us", label: "US Treasury", country: "US", basis: "par", couponsPerYear: 2 },
    requestedDate: null, asOf: "2026-09-24", points: points(0),
    lookbacks: [{ id: "1D", requestedDate: "2026-09-23", asOf: "2026-09-23", points: points(-0.05) }],
    spreads: [{ id: "2s10s", short: "2Y", long: "10Y", value: 0.6, change1d: 0, percentile1y: 50, observations1y: 250 }],
    checkedAt: null,
  });
  await renderLatest(90, 28);
  expect(lines()[2]).toMatch(/2s10s \+60bp +0bp 1D · 50 pctl 1Y/);
  expect(tui.frame()).not.toMatch(/pctl since|1M 1D|1M 1W/);
  expect(tui.frame()).toMatch(/1M +4\.00% +\+5bp/);
});

test("the selected tenor is the curve's point, from the table and from the chart", async () => {
  await renderLatest(90, 28);
  await tui.emitKeypress({ name: "down" });
  await settle();
  expect(readout().trim()).toBe("3M 4.10%  1W ago +10bp  1M ago -20bp");
  const chart = registry!.snapshot().find((node) => node.metadata?.kind === "curve-chart")!;
  // Hovering previews a tenor by its label, never a synthetic calendar date.
  await act(async () => { await registry!.invoke(chart.id, "moveCursor", { x: 74, y: 4 }); });
  await frame(); await frame();
  expect(readout()).toMatch(/^ (10|20)Y /);
  expect(tui.frame()).not.toMatch(/19[789]\d/);
  const hovered = readout().trim().split(" ")[0];
  await act(async () => { await registry!.invoke(chart.id, "press", { x: 74, y: 4 }); });
  // Leaving the chart ends the preview; the click made that tenor the selection.
  await act(async () => { await tui.setup().mockMouse.moveTo(5, 20); });
  await settle();
  expect(readout().trim().split(" ")[0]).toBe(hovered);
  await tui.emitKeypress({ name: "up" });
  await settle();
  expect(readout().trim().split(" ")[0]).toBe(hovered === "10Y" ? "7Y" : "10Y");
});

test("a short pane keeps the tenors and turns the chart into a strip, then drops it", async () => {
  await renderLatest(40, 12);
  let rows = lines();
  // The first spread keeps its row above the strip.
  expect(rows[2]).toMatch(/^ 2s10s \+40bp/);
  expect(rows[3]).toMatch(/^ ● Par yield % .*1M 4\.00%/);
  expect(rows[4]).toMatch(/TENOR/);
  expect(rows.filter((line) => /^ \d+[MY] +\d\.\d\d%/.test(line)).length).toBeGreaterThanOrEqual(4);
  await tui.destroy();
  latestSpy?.mockRestore(); historySpy?.mockRestore();
  await renderLatest(40, 8);
  rows = lines();
  // The chart goes first; the lead spread keeps its one row.
  expect(rows.some((line) => line.includes("●"))).toBe(false);
  expect(rows[2]).toMatch(/^ 2s10s \+40bp/);
  expect(rows[3]).toMatch(/TENOR/);
  expect(rows.filter((line) => /^ \d+[MY] +\d\.\d\d%/.test(line))).toHaveLength(3);
});

test("date submission hides the previous curve while pending and keeps controls available after failure", async () => {
  latestSpy = spyOn(apiClient, "getCloudYieldCurve").mockResolvedValue(TREASURY_MATURITIES.map(({ maturity, years }) => ({ maturity, maturityYears: years, yield: 4.5, asOf: "2026-09-08" })));
  let rejectHistory!: (error: Error) => void;
  const pending = new Promise<never>((_resolve, reject) => { rejectHistory = reject; });
  historySpy = spyOn(apiClient, "getCloudFredSeries").mockImplementation(() => pending);
  await act(async () => { await tui.render(<Harness />, { width: 90, height: 30 }); });
  await frame(); await frame();
  expect(tui.frame()).toContain("as of 2026-09-08");
  await tui.emitKeypress({ name: "d" });
  await act(async () => { await tui.setup().mockInput.typeText("2024-03-02"); tui.setup().mockInput.pressEnter(); });
  await frame();
  expect(callsEndingOn("2024-03-02")).toBe(TREASURY_MATURITIES.length);
  expect(tui.frame()).toContain("2024-03-02");
  expect(tui.frame()).toContain("Loading yield curve");
  expect(tui.frame()).not.toContain("2026-09-08");
  await act(async () => { rejectHistory(new Error("offline")); });
  await frame();
  expect(tui.frame()).toContain("Treasury curve unavailable");
  const controls = tui;
  await act(async () => { await controls.clickFrameText("[c]urrent"); });
  await frame(); await frame();
  expect(tui.frame()).toContain("as of 2026-09-08");
});

test("a typed date applies only on Enter, and leaving the field restores the shown date", async () => {
  latestSpy = spyOn(apiClient, "getCloudYieldCurve").mockResolvedValue(TREASURY_MATURITIES.map(({ maturity, years }) => ({ maturity, maturityYears: years, yield: 4.5, asOf: "2026-09-08" })));
  historySpy = spyOn(apiClient, "getCloudFredSeries").mockImplementation(async (id) => ({
    observations: [{ date: "2024-03-01", value: 4.2 }],
    info: { id, title: "Treasury yield", units: "Percent", frequency: "Daily", seasonalAdjustment: "", source: "FRED", notes: "" },
  }));
  await act(async () => { await tui.render(<Harness />, { width: 90, height: 30 }); });
  await frame(); await frame();
  const controls = tui;
  await act(async () => { await controls.clickFrameText("[d]ate"); });
  await frame();
  await act(async () => { await tui.setup().mockInput.typeText("2024-03"); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  await frame(); await frame();
  expect(callsEndingOn("2024-03-02")).toBe(0);
  await tui.emitKeypress({ name: "escape" });
  await frame(); await frame();
  expect(callsEndingOn("2024-03-02")).toBe(0);
  expect(tui.frame()).not.toContain("2024-03");
  expect(tui.frame()).toContain("as of 2026-09-08");
  await tui.emitKeypress({ name: "d" });
  await act(async () => { await tui.setup().mockInput.typeText("2024-03-02"); tui.setup().mockInput.pressEnter(); });
  await frame(); await frame();
  expect(callsEndingOn("2024-03-02")).toBe(TREASURY_MATURITIES.length);
  expect(tui.frame()).toContain("as of 2024-03-01");
});


test("historical partial source failure reaches the existing footer and a valid retry clears it", async () => {
  let offline = true;
  latestSpy = spyOn(apiClient, "getCloudYieldCurve").mockResolvedValue([]);
  historySpy = spyOn(apiClient, "getCloudFredSeries").mockImplementation(async (id) => {
    if (offline && id === "DGS2") throw new Error("controlled source 503");
    return { info: null, observations: [{ date: "2024-03-01", value: id === "DGS2" ? 0 : -.2 }] };
  });
  await act(async () => { await tui.render(<Harness />, { width: 90, height: 30 }); });
  await frame(); await frame();
  await tui.emitKeypress({ name: "d" });
  await act(async () => { await tui.setup().mockInput.typeText("2024-03-02"); tui.setup().mockInput.pressEnter(); });
  await frame(); await frame();
  expect(tui.frame()).toContain("controlled source 503");
  expect(tui.frame()).toContain("-0.20%");
  offline = false;
  await tui.emitKeypress({ name: "r" });
  await frame(); await frame();
  expect(tui.frame()).not.toContain("503");
  expect(tui.frame()).toContain("0.00%");
  // The inverted 2s10s is a figure now, not a footer segment.
  expect(tui.frame()).toContain("2s10s -20bp");
});

test("offline, the curve stays on screen and says when its saved copy is from, after a refresh and after a restart", async () => {
  const store = new MemoryPluginPersistence();
  curveViewCache.attach(store);
  await renderLatest(90, 28);
  expect(tui.frame()).toMatch(/1M +4\.00%/);
  const offline = new DataServiceUnreachableError(Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" }));
  latestSpy!.mockRejectedValue(offline);
  storedSpy!.mockRejectedValue(offline);
  await tui.emitKeypress({ name: "r" });
  await settle();
  expect(tui.frame()).toMatch(/1M +4\.00%/);
  expect(tui.frame()).toMatch(/saved copy from \d\d:\d\d/);
  expect(tui.frame()).not.toContain("unavailable");

  // A restart offline paints the saved curve and keeps it once its refresh fails.
  await tui.destroy();
  curveViewCache.reset();
  curveViewCache.attach(store);
  await act(async () => { await tui.render(<Harness width={90} height={28} />, { width: 90, height: 28 }); });
  await settle();
  expect(tui.frame()).toMatch(/1M +4\.00%/);
  expect(tui.frame()).toMatch(/saved copy from \d\d:\d\d/);
  expect(tui.frame()).not.toContain("yield curve unavailable");
});

test("offline, the World tab keeps its markets and says when its saved copy is from until a refresh answers, and a refusal clears them", async () => {
  const curve = (id: "us" | "de", label: string, ten: number) => ({
    curve: { id, label, country: id.toUpperCase(), basis: "par" as const, couponsPerYear: 2 }, asOf: "2026-09-24", checkedAt: null,
    points: [{ tenor: "2Y", years: 2, yield: 3.5 }, { tenor: "10Y", years: 10, yield: ten }, { tenor: "30Y", years: 30, yield: ten + 0.4 }],
    previous: null,
  });
  const world: CloudWorldCurves = { curves: [curve("us", "US Treasury", 4.2), curve("de", "German Bund", 2.6)] };
  const worldSpy = spyOn(apiClient, "getCloudWorldCurves").mockResolvedValue(world);
  worldCurvesCache.attach(new MemoryPluginPersistence());
  const refresh = async () => { await tui.emitKeypress({ name: "r" }); await settle(); };
  try {
    await act(async () => { await tui.render(<Harness width={90} height={28} tab="world" />, { width: 90, height: 28 }); });
    await settle();
    expect(tui.frame()).toContain("Germany");
    expect(tui.frame()).not.toContain("saved copy");

    worldSpy.mockRejectedValue(new DataServiceUnreachableError(Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" })));
    await refresh();
    expect(tui.frame()).toContain("Germany");
    expect(tui.frame()).toMatch(/saved copy from \d\d:\d\d/);

    worldSpy.mockResolvedValue(world);
    await refresh();
    expect(tui.frame()).toContain("Germany");
    expect(tui.frame()).not.toContain("saved copy");

    // Signed out, the saved markets are not this account's to show.
    worldSpy.mockRejectedValue(new ApiRequestError("Sign in to view world curves", 401));
    await refresh();
    expect(tui.frame()).not.toContain("Germany");
    expect(tui.frame()).toContain("Sign in to view world curves");
  } finally {
    worldSpy.mockRestore();
  }
});
