import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useEffect, useReducer } from "react";
import { RemoteUiRegistryProvider, useRemoteUiRegistry, type RemoteUiRegistry } from "../../../remote/semantic-tree";
import { apiClient, type CloudFredSeriesPayload } from "../../../api-client";
import { createTestControls, emitKeypress, testRender } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { YieldCurvePane } from "./index";
import { TREASURY_MATURITIES } from "./treasury-data";

const id = "yield-curve:test";
let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let latestSpy: ReturnType<typeof spyOn> | undefined;
let historySpy: ReturnType<typeof spyOn> | undefined;
let registry: RemoteUiRegistry | null = null;

function RegistryProbe() {
  const value = useRemoteUiRegistry();
  useEffect(() => { registry = value; }, [value]);
  return null;
}

function Harness({ width = 70, height = 30 }: { width?: number; height?: number }) {
  const initial = createInitialState(createTestPaneConfig("/tmp/gloom-curve-test", { instanceId: id, paneId: "yield-curve", binding: { kind: "none" } }));
  initial.focusedPaneId = id;
  const [state, dispatch] = useReducer(appReducer, initial);
  return <TestPaneFrame state={state} dispatch={dispatch} paneId={id} pluginId="macro" runtime={createTestPluginRuntime()} width={width} height={height} footerKeys>
    {(body) => <YieldCurvePane paneId={id} paneType="yield-curve" focused {...body} />}
  </TestPaneFrame>;
}

async function frame() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await setup!.renderOnce(); });
}

/** Long enough for the table to commit a keyboard move, which it holds back 150ms. */
async function settle() {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); await setup!.renderOnce(); });
  }
}

const lines = () => setup!.captureCharFrame().split("\n");
const readout = () => lines().find((line) => /^ \d+[MY] \d+\.\d\d%/.test(line)) ?? "";

// The latest session on Sep 24, a week back on Sep 17 and a month back on Aug 24.
const LATEST = TREASURY_MATURITIES.map(({ maturity, years }, index) => ({ maturity, maturityYears: years, yield: 4 + index / 10, asOf: "2026-09-24" }));
function fredPayload(seriesId: string, options: { startDate?: string; endDate?: string } = {}): CloudFredSeriesPayload {
  const index = TREASURY_MATURITIES.findIndex((entry) => entry.seriesId === seriesId);
  const observations = [
    { date: "2026-09-17", value: 3.9 + index / 10 },
    { date: "2026-08-24", value: 4.2 + index / 10 },
  ].filter((point) => (!options.startDate || point.date >= options.startDate) && (!options.endDate || point.date <= options.endDate));
  return { observations, info: { id: seriesId, title: "Treasury yield", units: "Percent", frequency: "Daily", seasonalAdjustment: "", source: "FRED", notes: "" } };
}

async function renderLatest(width: number, height: number) {
  latestSpy = spyOn(apiClient, "getCloudYieldCurve").mockResolvedValue(LATEST);
  historySpy = spyOn(apiClient, "getCloudFredSeries").mockImplementation(async (seriesId, options) => fredPayload(seriesId, options));
  await act(async () => { setup = await testRender(<RemoteUiRegistryProvider><RegistryProbe /><Harness width={width} height={height} /></RemoteUiRegistryProvider>, { width, height }); });
  await settle();
}

/** Calls for a curve on or before one date, leaving out the look-backs. */
const callsEndingOn = (date: string) => historySpy!.mock.calls.filter((call: unknown[]) => (call[1] as { endDate?: string })?.endDate === date).length;

afterEach(async () => {
  if (setup) await act(async () => { setup!.renderer.destroy(); });
  setup = undefined;
  registry = null;
  latestSpy?.mockRestore(); historySpy?.mockRestore();
});

test("the chart names the curve and its look-backs, and the tenors show how far each moved", async () => {
  await renderLatest(78, 27);
  const frameText = setup!.captureCharFrame();
  expect(lines()[1]).toMatch(/Yield % by maturity {3}● Yield {3}● 1W ago {3}● 1M ago/);
  // A log axis gives the short end room to label its tenors.
  expect(frameText).toMatch(/\n1M +3M +6M +1Y .*10Y +30Y +\n/);
  expect(frameText).toMatch(/TENOR +YIELD +1W CHG +1M CHG/);
  // 1M is 4.00% against 3.90% a week back and 4.20% a month back.
  expect(frameText).toMatch(/1M +4\.00% +\+10bp +-20bp/);
  expect(readout().trim()).toBe("1M 4.00%  1W ago +10bp  1M ago -20bp");
  // Both look-backs came from one request per tenor.
  expect(historySpy).toHaveBeenCalledTimes(TREASURY_MATURITIES.length);
});

test("the selected tenor is the curve's point, from the table and from the chart", async () => {
  await renderLatest(78, 27);
  await emitKeypress(setup!, { name: "down" });
  await settle();
  expect(readout().trim()).toBe("3M 4.10%  1W ago +10bp  1M ago -20bp");
  // Right steps along the maturities too.
  await emitKeypress(setup!, { name: "right" });
  await settle();
  expect(readout()).toContain("6M 4.20%");
  const chart = registry!.snapshot().find((node) => node.metadata?.kind === "curve-chart")!;
  // Hovering previews a tenor by its label, never a synthetic calendar date.
  await act(async () => { await registry!.invoke(chart.id, "moveCursor", { x: 60, y: 4 }); });
  await frame(); await frame();
  expect(readout()).toMatch(/^ (10|20)Y /);
  expect(setup!.captureCharFrame()).not.toMatch(/19[789]\d/);
  const hovered = readout().trim().split(" ")[0];
  await act(async () => { await registry!.invoke(chart.id, "press", { x: 60, y: 4 }); });
  // Leaving the chart ends the preview; the click made that tenor the selection.
  await act(async () => { await setup!.mockMouse.moveTo(5, 20); });
  await settle();
  expect(readout().trim().split(" ")[0]).toBe(hovered);
  await emitKeypress(setup!, { name: "up" });
  await settle();
  expect(readout().trim().split(" ")[0]).toBe(hovered === "10Y" ? "7Y" : "10Y");
});

test("a short pane keeps the tenors and turns the chart into a strip, then drops it", async () => {
  await renderLatest(40, 11);
  let rows = lines();
  expect(rows[1]).toMatch(/^ ● Yield % .*1M 4\.00%/);
  expect(rows[2]).toMatch(/TENOR/);
  expect(rows.filter((line) => /^ \d+[MY] +\d\.\d\d%/.test(line)).length).toBeGreaterThanOrEqual(4);
  await act(async () => { setup!.renderer.destroy(); });
  latestSpy?.mockRestore(); historySpy?.mockRestore();
  await renderLatest(40, 7);
  rows = lines();
  expect(rows.some((line) => line.includes("●"))).toBe(false);
  expect(rows[1]).toMatch(/TENOR/);
  expect(rows.filter((line) => /^ \d+[MY] +\d\.\d\d%/.test(line))).toHaveLength(4);
});

test("date submission hides the previous curve while pending and keeps controls available after failure", async () => {
  latestSpy = spyOn(apiClient, "getCloudYieldCurve").mockResolvedValue(TREASURY_MATURITIES.map(({ maturity, years }) => ({ maturity, maturityYears: years, yield: 4.5, asOf: "2026-09-08" })));
  let rejectHistory!: (error: Error) => void;
  const pending = new Promise<never>((_resolve, reject) => { rejectHistory = reject; });
  historySpy = spyOn(apiClient, "getCloudFredSeries").mockImplementation(() => pending);
  await act(async () => { setup = await testRender(<Harness />, { width: 70, height: 30 }); });
  await frame(); await frame();
  expect(setup!.captureCharFrame()).toContain("as of 2026-09-08");
  await emitKeypress(setup!, { name: "d" });
  await act(async () => { await setup!.mockInput.typeText("2024-03-02"); setup!.mockInput.pressEnter(); });
  await frame();
  expect(callsEndingOn("2024-03-02")).toBe(TREASURY_MATURITIES.length);
  expect(setup!.captureCharFrame()).toContain("2024-03-02");
  expect(setup!.captureCharFrame()).toContain("Loading yield curve");
  expect(setup!.captureCharFrame()).not.toContain("2026-09-08");
  await act(async () => { rejectHistory(new Error("offline")); });
  await frame();
  expect(setup!.captureCharFrame()).toContain("Treasury curve unavailable");
  const controls = createTestControls(() => setup!);
  await act(async () => { await controls.clickFrameText("[c]urrent"); });
  await frame(); await frame();
  expect(setup!.captureCharFrame()).toContain("as of 2026-09-08");
});

test("a typed date applies only on Enter, and leaving the field restores the shown date", async () => {
  latestSpy = spyOn(apiClient, "getCloudYieldCurve").mockResolvedValue(TREASURY_MATURITIES.map(({ maturity, years }) => ({ maturity, maturityYears: years, yield: 4.5, asOf: "2026-09-08" })));
  historySpy = spyOn(apiClient, "getCloudFredSeries").mockImplementation(async (id) => ({
    observations: [{ date: "2024-03-01", value: 4.2 }],
    info: { id, title: "Treasury yield", units: "Percent", frequency: "Daily", seasonalAdjustment: "", source: "FRED", notes: "" },
  }));
  await act(async () => { setup = await testRender(<Harness />, { width: 70, height: 30 }); });
  await frame(); await frame();
  const controls = createTestControls(() => setup!);
  await act(async () => { await controls.clickFrameText("[d]ate"); });
  await frame();
  await act(async () => { await setup!.mockInput.typeText("2024-03"); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  await frame(); await frame();
  expect(callsEndingOn("2024-03-02")).toBe(0);
  await emitKeypress(setup!, { name: "escape" });
  await frame(); await frame();
  expect(callsEndingOn("2024-03-02")).toBe(0);
  expect(setup!.captureCharFrame()).not.toContain("2024-03");
  expect(setup!.captureCharFrame()).toContain("as of 2026-09-08");
  await emitKeypress(setup!, { name: "d" });
  await act(async () => { await setup!.mockInput.typeText("2024-03-02"); setup!.mockInput.pressEnter(); });
  await frame(); await frame();
  expect(callsEndingOn("2024-03-02")).toBe(TREASURY_MATURITIES.length);
  expect(setup!.captureCharFrame()).toContain("as of 2024-03-01");
});


test("historical partial source failure reaches the existing footer and a valid retry clears it", async () => {
  let offline = true;
  latestSpy = spyOn(apiClient, "getCloudYieldCurve").mockResolvedValue([]);
  historySpy = spyOn(apiClient, "getCloudFredSeries").mockImplementation(async (id) => {
    if (offline && id === "DGS2") throw new Error("controlled source 503");
    return { info: null, observations: [{ date: "2024-03-01", value: id === "DGS2" ? 0 : -.2 }] };
  });
  await act(async () => { setup = await testRender(<Harness />, { width: 70, height: 30 }); });
  await frame(); await frame();
  await emitKeypress(setup!, { name: "d" });
  await act(async () => { await setup!.mockInput.typeText("2024-03-02"); setup!.mockInput.pressEnter(); });
  await frame(); await frame();
  expect(setup!.captureCharFrame()).toContain("controlled source 503");
  expect(setup!.captureCharFrame()).toContain("-0.20%");
  offline = false;
  await emitKeypress(setup!, { name: "r" });
  await frame(); await frame();
  expect(setup!.captureCharFrame()).not.toContain("503");
  expect(setup!.captureCharFrame()).toContain("0.00%");
  expect(setup!.captureCharFrame()).toContain("10Y−2Y -20bp");
});
