import { act, useReducer, type Dispatch } from "react";
import { afterEach, expect, spyOn, test } from "bun:test";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { ExposurePayload, ExposureScenario } from "../../../api-client/exposure";
import { apiClient } from "../../../api-client";
import { DEFAULT_SCENARIO } from "./model";
import { ExposurePane } from "./pane";
import drivers from "./fixtures/drivers.fixture.json";
import type { ExposureExtensionObservation } from "../../../api-client/exposure";
import audited from "./fixtures/taiwan.fixture.json";

const tui = createOpenTuiTestHarness();
async function mount(width = 110, height = 25, tab = "table", view = "stress", snapshot = audited as ExposurePayload) {
  const id = "exposure:test";
  const state = createInitialState(createTestPaneConfig(`${process.env.HOME}/.cache/gloom-smoke/final-qa/exposure-pane-test`, {
    paneId: "exposure", instanceId: id, params: { input: "NVDA AAPL AMD FANG LIN" }, settings: { exposureSnapshot: snapshot, tab, view },
  }));
  function Harness() {
    const [current, dispatch] = useReducer(appReducer, state);
    return <TestPaneFrame state={current} dispatch={dispatch} paneId={id} pluginId="ticker-research" runtime={createTestPluginRuntime()} width={width} height={height} footerKeys>
      {body => <ExposurePane paneId={id} paneType="exposure" focused {...body} />}
    </TestPaneFrame>;
  }
  await act(async () => { await tui.render(<Harness />, { width, height }); });
}
test("real disclosure snapshot shows the actual scenario and evidence stack retains the filed quote", async () => {
  await mount();
  const frame = await tui.waitForFrameToContain("19.6%");
  expect(frame).toContain("Taiwan disruption");
  expect(frame).not.toContain("taiwan-disruption");
  expect(frame).toContain("15.5%");
  await tui.emitKeypress({ name: "e" });
  const evidence = await tui.waitForFrameToContain("Period / units");
  expect(evidence).toContain("2026-01-25");
  expect(evidence).toContain("primary");
  await tui.emitKeypress({ name: "escape" });
  expect(await tui.waitForFrameToContain("HOLDING")).toContain("NVDA");
  await tui.emitKeypress({ name: "v" });
  expect(await tui.waitForFrameToContain("What we could not see")).toContain("NVDA");
});
test("narrow paths retain their unknown classification without a fabricated number", async () => {
  await mount(90, 20, "paths");
  const frame = await tui.waitForFrameToContain("EVIDENCE PATH");
  expect(frame).toContain("Unknown");
  expect(frame).not.toContain("Unknown unknown");
});

test("evidence displays a zero numeric chain estimate and concentrations keep their signed-exposure meaning", async () => {
  const data = structuredClone(audited) as ExposurePayload;
  data.holdings[0]!.components[0]!.proportionalEstimatePct = 0;
  await mount(110, 32, "table", "stress", data);
  await tui.waitForFrameToContain("19.6%");
  await tui.emitKeypress({ name: "e" });
  expect(await tui.waitForFrameToContain("Proportional chain")).toContain("0.00%");
  await tui.destroy();
  await mount(110, 30, "portfolio", "country");
  await tui.waitForFrameToContain("United States");
  await tui.emitKeypress({ name: "e" });
  const frame = await tui.waitForFrameToContain("Signed exposure");
  expect(frame).toContain("Gross exposure");
  expect(frame).not.toContain("Operating stress");
});


test("driver tab opens original evidence without presenting an exposure or stress estimate", async () => {
  const data = structuredClone(audited) as ExposurePayload;
  data.holdings[0]!.symbol = "AAPL";
  data.holdings[0]!.extensions = drivers.AAPL as unknown as ExposureExtensionObservation[];
  await mount(110, 30, "drivers", "stress", data);
  const frame = await tui.waitForFrameToContain("201.18B");
  expect(frame).toContain("USD");
  expect(frame).not.toContain("Operating stress");
  await tui.emitKeypress({ name: "e" });
  const evidence = await tui.waitForFrameToContain("Value / units");
  expect(evidence).toContain("Fiscal year 2024");
  expect(evidence).toContain("primary");
});

const savedCustom = '{"label":"Unfinished rate shock",';
let restores: (() => void)[] = [];
afterEach(() => { for (const restore of restores) restore(); restores = []; });

async function mountSavedInput(settings: Record<string, unknown>) {
  const library = spyOn(apiClient, "getCloudExposureScenarios").mockResolvedValue({ scenarios: [DEFAULT_SCENARIO] });
  const analyze = spyOn(apiClient, "analyzeCloudExposure").mockImplementation(async request => ({ ...structuredClone(audited) as ExposurePayload, scenario: request.scenario }));
  restores.push(() => library.mockRestore(), () => analyze.mockRestore());
  const id = "exposure:unreadable";
  const state = createInitialState(createTestPaneConfig(`${process.env.HOME}/.cache/gloom-smoke/glo-1127/pane-test`, {
    paneId: "exposure", instanceId: id, params: { input: "ACME=100%" }, settings,
  }));
  let current = state;
  let dispatchCurrent: Dispatch<AppAction>;
  function Harness() {
    const [value, dispatch] = useReducer(appReducer, state);
    current = value;
    dispatchCurrent = dispatch;
    return <TestPaneFrame state={value} dispatch={dispatch} paneId={id} pluginId="ticker-research" runtime={createTestPluginRuntime()} width={110} height={55} footerKeys>
      {body => <ExposurePane paneId={id} paneType="exposure" focused {...body} />}
    </TestPaneFrame>;
  }
  await act(async () => { await tui.render(<Harness />, { width: 110, height: 55 }); });
  return { library, analyze, instance: () => current.config.layout.instances.find(item => item.instanceId === id)!,
    setScenario: async (scenario: string) => { await act(async () => {
      dispatchCurrent({ type: "UPDATE_LAYOUT", layout: { ...current.config.layout, instances: current.config.layout.instances.map(item => item.instanceId === id ? { ...item, settings: { ...item.settings, customScenario: scenario } } : item) } });
    }); },
    seedEditor: async () => { await act(async () => {
      dispatchCurrent({ type: "UPDATE_PLUGIN_PANE_STATE", paneId: id, pluginId: "ticker-research", key: "exposure:inputs", value: { input: "ACME=100%", source: "typed", nav: "", cash: "", depth: 2, scenario: DEFAULT_SCENARIO } });
    }); },
  };
}

test("unreadable custom scenario stays intact and blocks analysis through refresh and cancelled editing until reset", async () => {
  const { library, analyze, instance } = await mountSavedInput({ customScenario: savedCustom });
  await tui.waitForFrameToContain("Cannot read the custom scenario.");
  await tui.emitKeypress({ name: "r", ctrl: true });
  expect(analyze).not.toHaveBeenCalled();
  expect(library).not.toHaveBeenCalled();
  expect(instance().settings?.customScenario).toBe(savedCustom);
  expect(instance().params?.input).toBe("ACME=100%");
  await tui.emitKeypress({ name: "return" });
  expect(await tui.waitForFrameToContain("Advanced scenario JSON")).toContain(savedCustom);
  await tui.emitKeypress({ name: "escape" });
  await tui.waitForFrameToContain("Cannot read the custom scenario.");
  expect(analyze).not.toHaveBeenCalled();
  expect(instance().settings?.customScenario).toBe(savedCustom);
  await tui.clickFrameText("Reset custom scenario");
  await tui.waitForFrameToContain("19.6%");
  expect(instance().settings?.customScenario).toBe("");
  expect(analyze).toHaveBeenCalledTimes(1);
  expect(analyze.mock.calls[0]![0]).toEqual({ holdings: [{ symbol: "ACME", weight: 1 }], scenario: DEFAULT_SCENARIO, depth: 2 });
});

test("unreadable saved snapshot remains intact and blocks analysis until the user resets it", async () => {
  const snapshot = { ...audited, version: 2 };
  const { library, analyze, instance } = await mountSavedInput({ exposureSnapshot: snapshot });
  await tui.waitForFrameToContain("Cannot read the saved exposure snapshot.");
  await tui.emitKeypress({ name: "r", ctrl: true });
  await tui.emitKeypress({ name: "s" });
  expect(analyze).not.toHaveBeenCalled();
  expect(library).not.toHaveBeenCalled();
  expect(instance().settings?.exposureSnapshot).toEqual(snapshot);
  expect(instance().params?.input).toBe("ACME=100%");
  await tui.emitKeypress({ name: "return" });
  await tui.waitForFrameToContain("19.6%");
  expect(instance().settings?.exposureSnapshot).toBeNull();
  expect(analyze).toHaveBeenCalledTimes(1);
  expect(analyze.mock.calls[0]![0].holdings).toEqual([{ symbol: "ACME", weight: 1 }]);
});

test("valid custom scenario is analyzed unchanged", async () => {
  const scenario: ExposureScenario = { label: "Saved rate shock", shocks: [{ id: "rates", kind: "rate", target: "USD", changeBps: 100 }] };
  const customScenario = JSON.stringify(scenario);
  const { analyze, instance } = await mountSavedInput({ customScenario });
  await tui.waitForFrameToContain("19.6%");
  expect(analyze).toHaveBeenCalledTimes(1);
  expect(analyze.mock.calls[0]![0].scenario).toEqual(scenario);
  expect(instance().settings?.customScenario).toBe(customScenario);
});


test("repairing a custom setting replaces stale editor state before analysis starts", async () => {
  const { analyze, instance, seedEditor, setScenario } = await mountSavedInput({ customScenario: savedCustom });
  await tui.waitForFrameToContain("Cannot read the custom scenario.");
  await seedEditor();
  const scenario: ExposureScenario = { label: "Repaired rate shock", shocks: [{ id: "rates", kind: "rate", target: "USD", changeBps: 100 }] };
  await setScenario(JSON.stringify(scenario));
  await tui.waitForFrameToContain("19.6%");
  expect(analyze).toHaveBeenCalledTimes(1);
  expect(analyze.mock.calls[0]![0].scenario).toEqual(scenario);
  expect(instance().params?.input).toBe("ACME=100%");
});
