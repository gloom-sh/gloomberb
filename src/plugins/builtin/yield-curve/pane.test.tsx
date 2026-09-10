import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useReducer } from "react";
import { apiClient } from "../../../api-client";
import { emitKeypress, testRender } from "../../../renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, appReducer, createInitialState } from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { cloneLayout, createDefaultConfig } from "../../../types/config";
import { PluginRenderProvider } from "../../runtime";
import { YieldCurvePane } from "./index";
import { TREASURY_MATURITIES } from "./treasury-data";

const id = "yield-curve:test";
let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let latestSpy: ReturnType<typeof spyOn> | undefined;
let historySpy: ReturnType<typeof spyOn> | undefined;

function Harness() {
  const config = createDefaultConfig("/tmp/gloom-curve-test");
  config.layout = { dockRoot: { kind: "pane", instanceId: id }, instances: [{ instanceId: id, paneId: "yield-curve", binding: { kind: "none" } }], floating: [], detached: [] };
  config.layouts = [{ name: "Default", layout: cloneLayout(config.layout) }];
  const initial = createInitialState(config);
  initial.focusedPaneId = id;
  const [state, dispatch] = useReducer(appReducer, initial);
  return <AppContext value={{state, dispatch}}><PaneInstanceProvider paneId={id}>
    <PluginRenderProvider pluginId="macro" runtime={createTestPluginRuntime()}>
      <YieldCurvePane paneId={id} paneType="yield-curve" focused width={70} height={30} />
    </PluginRenderProvider>
  </PaneInstanceProvider></AppContext>;
}

async function frame() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await setup!.renderOnce(); });
}

afterEach(async () => {
  if (setup) await act(async () => { setup!.renderer.destroy(); });
  setup = undefined;
  latestSpy?.mockRestore(); historySpy?.mockRestore();
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
  expect(setup!.captureCharFrame()).toContain("As-of date");
  expect(setup!.captureCharFrame()).toContain("Latest");
  await emitKeypress(setup!, { name: "l" });
  await frame();
  expect(setup!.captureCharFrame()).toContain("2026-09-08");
});
