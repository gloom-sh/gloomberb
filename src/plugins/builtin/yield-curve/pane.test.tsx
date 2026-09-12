import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useEffect, useReducer } from "react";
import { RemoteUiRegistryProvider, useRemoteUiRegistry, type RemoteUiRegistry } from "../../../remote/semantic-tree";
import { apiClient } from "../../../api-client";
import { createTestControls, emitKeypress, testRender } from "../../../renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, appReducer, createInitialState } from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { cloneLayout, createDefaultConfig } from "../../../types/config";
import { PluginRenderProvider } from "../../runtime";
import { YieldCurvePane } from "./index";
import { TREASURY_MATURITIES } from "./treasury-data";
import { PaneFooterProvider, PaneFooterBar } from "../../../components/layout/pane/footer";
import { Box } from "../../../ui";

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

function Harness() {
  const config = createDefaultConfig("/tmp/gloom-curve-test");
  config.layout = { dockRoot: { kind: "pane", instanceId: id }, instances: [{ instanceId: id, paneId: "yield-curve", binding: { kind: "none" } }], floating: [], detached: [] };
  config.layouts = [{ name: "Default", layout: cloneLayout(config.layout) }];
  const initial = createInitialState(config);
  initial.focusedPaneId = id;
  const [state, dispatch] = useReducer(appReducer, initial);
  return <AppContext value={{state, dispatch}}><PaneInstanceProvider paneId={id}>
    <PluginRenderProvider pluginId="macro" runtime={createTestPluginRuntime()}>
      <PaneFooterProvider>{(footer) => <Box width={70} height={30} flexDirection="column">
        <YieldCurvePane paneId={id} paneType="yield-curve" focused width={70} height={29} />
        <PaneFooterBar footer={footer} focused width={70} />
      </Box>}</PaneFooterProvider>
    </PluginRenderProvider>
  </PaneInstanceProvider></AppContext>;
}

async function frame() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await setup!.renderOnce(); });
}

afterEach(async () => {
  if (setup) await act(async () => { setup!.renderer.destroy(); });
  setup = undefined;
  registry = null;
  latestSpy?.mockRestore(); historySpy?.mockRestore();
});

test("Treasury curve axis and cursor use maturity rather than synthetic calendar dates", async () => {
  latestSpy = spyOn(apiClient, "getCloudYieldCurve").mockResolvedValue(TREASURY_MATURITIES.map(({ maturity, years }, index) => ({ maturity, maturityYears: years, yield: 4 + index / 10, asOf: "2026-09-10" })));
  await act(async () => { setup = await testRender(<RemoteUiRegistryProvider><RegistryProbe /><Harness /></RemoteUiRegistryProvider>, { width: 70, height: 30 }); });
  await frame(); await frame();
  expect(setup!.captureCharFrame()).toMatch(/1M.*5Y.*10Y.*20Y.*30Y/);
  const chart = registry!.snapshot().find((node) => node.metadata?.kind === "static-chart")!;
  await act(async () => { await registry!.invoke(chart.id, "moveCursor", { x: 30, y: 4 }); });
  await frame(); await frame();
  expect(setup!.captureCharFrame()).toMatch(/\d+\.\dY/);
  expect(setup!.captureCharFrame()).not.toMatch(/19[789]\d/);
});

test("date submission hides the previous curve while pending and keeps controls available after failure", async () => {
  latestSpy = spyOn(apiClient, "getCloudYieldCurve").mockResolvedValue(TREASURY_MATURITIES.map(({ maturity, years }) => ({ maturity, maturityYears: years, yield: 4.5, asOf: "2026-09-08" })));
  let rejectHistory!: (error: Error) => void;
  const pending = new Promise<never>((_resolve, reject) => { rejectHistory = reject; });
  historySpy = spyOn(apiClient, "getCloudFredSeries").mockImplementation(() => pending);
  await act(async () => { setup = await testRender(<Harness />, { width: 70, height: 30 }); });
  await frame(); await frame();
  expect(setup!.captureCharFrame()).toContain("2026-09-08");
  await emitKeypress(setup!, { name: "d" });
  await act(async () => { await setup!.mockInput.typeText("2024-03-02"); setup!.mockInput.pressEnter(); });
  await frame();
  expect(historySpy).toHaveBeenCalledTimes(10);
  expect(setup!.captureCharFrame()).toContain("2024-03-02");
  expect(setup!.captureCharFrame()).toContain("Loading yield curve");
  expect(setup!.captureCharFrame()).not.toContain("2026-09-08");
  await act(async () => { rejectHistory(new Error("offline")); });
  await frame();
  expect(setup!.captureCharFrame()).toContain("No Treasury observations");
  const controls = createTestControls(() => setup!);
  await act(async () => { await controls.clickFrameText("[d]ate"); });
  await frame();
  expect(setup!.captureCharFrame()).toContain("As-of date");
  await emitKeypress(setup!, { name: "escape" });
  await act(async () => { await controls.clickFrameText("[l]atest"); });
  await frame();
  expect(setup!.captureCharFrame()).toContain("2026-09-08");
});

test("the transient date editor can be submitted with the mouse", async () => {
  latestSpy = spyOn(apiClient, "getCloudYieldCurve").mockResolvedValue(TREASURY_MATURITIES.map(({ maturity, years }) => ({ maturity, maturityYears: years, yield: 4.5, asOf: "2026-09-08" })));
  historySpy = spyOn(apiClient, "getCloudFredSeries").mockResolvedValue({
    observations: [{ date: "2024-03-01", value: 4.2 }],
    info: { id: "DGS10", title: "Treasury yield", units: "Percent", frequency: "Daily", seasonalAdjustment: "", source: "FRED", notes: "" },
  });
  await act(async () => { setup = await testRender(<Harness />, { width: 70, height: 30 }); });
  await frame(); await frame();
  const controls = createTestControls(() => setup!);
  await act(async () => { await controls.clickFrameText("[d]ate"); });
  await frame();
  await act(async () => { await setup!.mockInput.typeText("2024-03-02"); });
  await frame();
  await act(async () => { await controls.clickFrameText("View"); });
  await frame(); await frame();
  expect(historySpy).toHaveBeenCalledTimes(10);
  expect(setup!.captureCharFrame()).toContain("2024-03-01");
  expect(setup!.captureCharFrame()).toContain("requested 2024-03-02");
  expect(setup!.captureCharFrame()).not.toContain("As-of date");
});
