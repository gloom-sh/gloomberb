import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useEffect, useReducer } from "react";
import { apiClient } from "../../../api-client";
import { emitKeypress, testRender } from "../../../renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, appReducer, createInitialState } from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { cloneLayout, createDefaultConfig } from "../../../types/config";
import { PluginRenderProvider } from "../../runtime";
import { PaneFooterProvider, PaneFooterBar } from "../../../components/layout/pane/footer";
import { RemoteUiRegistryProvider, useRemoteUiRegistry, type RemoteUiRegistry } from "../../../remote/semantic-tree";
import { Box } from "../../../ui";
import { BondCalculatorPane } from "./pane";

const id = "bond-calculator:test";
let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let loader: ReturnType<typeof spyOn> | undefined;
let registry: RemoteUiRegistry | null = null;
function Probe() { const value = useRemoteUiRegistry(); useEffect(() => { registry = value; }, [value]); return null; }
function Harness() {
  const config = createDefaultConfig("/tmp/gloom-yas-test");
  config.layout = { dockRoot: { kind: "pane", instanceId: id }, instances: [{ instanceId: id, paneId: "bond-calculator", binding: { kind: "none" }, settings: { settlement: "2026-09-22", maturity: "2031-09-15" } }], floating: [], detached: [] };
  config.layouts = [{ name: "Default", layout: cloneLayout(config.layout) }];
  const initial = createInitialState(config); initial.focusedPaneId = id;
  const [state, dispatch] = useReducer(appReducer, initial);
  return <AppContext value={{ state, dispatch }}><PaneInstanceProvider paneId={id}>
    <PluginRenderProvider pluginId="macro" runtime={createTestPluginRuntime()}><RemoteUiRegistryProvider><Probe />
      <PaneFooterProvider>{(footer) => <Box width={80} height={34} flexDirection="column">
        <BondCalculatorPane paneId={id} paneType="bond-calculator" focused width={80} height={33} /><PaneFooterBar footer={footer} focused width={80} />
      </Box>}</PaneFooterProvider>
    </RemoteUiRegistryProvider></PluginRenderProvider>
  </PaneInstanceProvider></AppContext>;
}
async function frame() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await setup!.renderOnce(); }); }
async function mount() { await act(async () => { setup = await testRender(<Harness />, { width: 80, height: 34 }); }); await frame(); await frame(); }
afterEach(async () => { if (setup) await act(async () => { setup!.renderer.destroy(); }); setup = undefined; registry = null; loader?.mockRestore(); });

test("unavailable benchmark preserves calculator and invalid edits remove the previous valuation", async () => {
  loader = spyOn(apiClient, "getCloudYieldCurve").mockRejectedValue(new Error("HTTP 404"));
  await mount();
  expect(setup!.captureCharFrame()).toContain("103.3339");
  expect(setup!.captureCharFrame()).toContain("HTTP 404");
  const coupon = registry!.snapshot().find((node) => node.role === "text-field" && node.label === "Coupon %")!;
  await act(async () => { await registry!.invoke(coupon.id, "setValue", ""); }); await frame();
  expect(setup!.captureCharFrame()).not.toContain("103.3339");
  expect(setup!.captureCharFrame()).toContain("Coupon must be a number");
});

test("switching input mode keeps the valuation and a failed refresh keeps dated benchmark", async () => {
  loader = spyOn(apiClient, "getCloudYieldCurve").mockResolvedValue([
    { maturity: "2Y", maturityYears: 2, yield: 4, asOf: "2026-09-18" },
    { maturity: "5Y", maturityYears: 5, yield: 4.5, asOf: "2026-09-18" },
  ]);
  await mount();
  const mode = registry!.snapshot().find((node) => node.role === "select" && node.label === "Segmented control")!;
  await act(async () => { await registry!.invoke(mode.id, "select", "price"); }); await frame();
  expect(setup!.captureCharFrame()).toContain("103.3339");
  expect(setup!.captureCharFrame()).toContain("4.2500%");
  loader.mockRejectedValue(new Error("Offline"));
  await emitKeypress(setup!, { name: "r" }); await frame(); await frame();
  expect(setup!.captureCharFrame()).toContain("2026-09-18");
  expect(setup!.captureCharFrame()).toContain("Offline");
});
