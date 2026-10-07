import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useEffect, useReducer } from "react";
import { apiClient } from "../../../api-client";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { RemoteUiRegistryProvider, useRemoteUiRegistry, type RemoteUiRegistry } from "../../../remote/semantic-tree";
import { BondCalculatorPane } from "./pane";

const id = "bond-calculator:test";
const tui = createOpenTuiTestHarness();
let loader: ReturnType<typeof spyOn> | undefined;
let registry: RemoteUiRegistry | null = null;
function Probe() { const value = useRemoteUiRegistry(); useEffect(() => { registry = value; }, [value]); return null; }
function Harness() {
  const config = createTestPaneConfig("/tmp/gloom-yas-test", { instanceId: id, paneId: "bond-calculator", binding: { kind: "none" }, settings: { settlement: "2026-09-22", maturity: "2031-09-15" } });
  const initial = createInitialState(config); initial.focusedPaneId = id;
  const [state, dispatch] = useReducer(appReducer, initial);
  return <RemoteUiRegistryProvider><Probe />
    <TestPaneFrame state={state} dispatch={dispatch} paneId={id} pluginId="macro" runtime={createTestPluginRuntime()} width={80} height={34}>
      {(body) => <BondCalculatorPane paneId={id} paneType="bond-calculator" focused {...body} />}
    </TestPaneFrame>
  </RemoteUiRegistryProvider>;
}
async function frame() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await tui.setup().renderOnce(); }); }
async function mount() { await act(async () => { await tui.render(<Harness />, { width: 80, height: 34 }); }); await frame(); await frame(); }
afterEach(async () => { registry = null; loader?.mockRestore(); });

test("unavailable benchmark preserves calculator and invalid edits remove the previous valuation", async () => {
  loader = spyOn(apiClient, "getCloudYieldCurve").mockRejectedValue(new Error("HTTP 404"));
  await mount();
  expect(tui.frame()).toContain("103.3339");
  expect(tui.frame()).toContain("HTTP 404");
  const editCoupon = registry!.snapshot().find((node) => node.role === "button" && node.label === "Edit Coupon %")!;
  await act(async () => { await registry!.invoke(editCoupon.id, "press"); }); await frame();
  const coupon = registry!.snapshot().find((node) => node.role === "text-field" && node.metadata?.focused === true)!;
  await act(async () => { await registry!.invoke(coupon.id, "setValue", ""); await registry!.invoke(coupon.id, "submit", ""); }); await frame();
  expect(tui.frame()).not.toContain("103.3339");
  expect(tui.frame()).toContain("Coupon must be a number");
});

test("switching input mode keeps the valuation and a failed refresh keeps dated benchmark", async () => {
  loader = spyOn(apiClient, "getCloudYieldCurve").mockResolvedValue([
    { maturity: "2Y", maturityYears: 2, yield: 4, asOf: "2026-09-18" },
    { maturity: "5Y", maturityYears: 5, yield: 4.5, asOf: "2026-09-18" },
  ]);
  await mount();
  const mode = registry!.snapshot().find((node) => node.role === "select" && node.label === "Segmented control")!;
  await act(async () => { await registry!.invoke(mode.id, "select", "price"); }); await frame();
  expect(tui.frame()).toContain("103.3339");
  expect(tui.frame()).toContain("4.2500%");
  loader.mockRejectedValue(new Error("Offline"));
  await tui.emitKeypress({ name: "r" }); await frame(); await frame();
  expect(tui.frame()).toContain("2026-09-18");
  expect(tui.frame()).toContain("Offline");
});

test("Tab walks the fields only while one is being edited, then leaves them", async () => {
  loader = spyOn(apiClient, "getCloudYieldCurve").mockRejectedValue(new Error("HTTP 404"));
  await mount();
  const editing = () => registry!.snapshot().some((node) => node.role === "text-field" && node.metadata?.focused === true);
  const tab = async () => (await tui.emitKeypress({ name: "tab" }, { trackPropagation: true })).defaultPrevented;
  // With no field active, Tab is left for moving to the next pane.
  expect(await tab()).toBe(false);
  expect(editing()).toBe(false);
  await tui.emitKeypress({ name: "e" }); await frame();
  expect(editing()).toBe(true);
  for (let field = 0; field < 3; field++) expect(await tab()).toBe(true);
  await frame();
  expect(editing()).toBe(true);
  // Past the last field Tab leaves the form instead of wrapping to the first.
  expect(await tab()).toBe(true);
  await frame();
  expect(editing()).toBe(false);
  expect(await tab()).toBe(false);
});
