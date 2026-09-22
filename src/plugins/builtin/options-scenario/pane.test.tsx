import { afterEach, expect, test } from "bun:test";
import { act, useEffect, useReducer } from "react";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createRemoteUiRegistry, RemoteUiRegistryProvider, type RemoteUiRegistry } from "../../../remote/semantic-tree";
import { emitKeypress, testRender } from "../../../renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, appReducer, createInitialState } from "../../../state/app/context";
import { PaneKeyboardScrollController } from "../../../state/pane-scroll-registry";
import { createStatefulTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { cloneLayout, createDefaultConfig, type AppConfig } from "../../../types/config";
import { Box } from "../../../ui";
import { PluginRenderProvider, type PluginRuntimeAccess } from "../../runtime";
import { type ScenarioEvidence } from "./evidence";
import { buildScenario, parseLegs, type ScenarioPosition } from "./model";
import { OptionsScenarioPane } from "./pane";
import { type SavedScenarioStrategy } from "./state";

const ID = "options-scenario:test";
const PLUGIN = "ticker-research";
const WIDTH = 100;
const HEIGHT = 32;
const SETTINGS = { symbol: "AAPL", spot: "100", rate: "4", dividendYield: "0", currency: "USD",
  asOf: "2026-09-22T00:00:00Z", legs: "call,100,2026-12-18,1,5,25" };
const POSITION: ScenarioPosition = { symbol: "AAPL", spot: 100, rate: 0.04, dividendYield: 0, currency: "USD",
  asOf: Date.UTC(2026, 8, 22), legs: parseLegs(SETTINGS.legs) };

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let registry: RemoteUiRegistry;
let latestState: ReturnType<typeof createInitialState>;
let runtime: PluginRuntimeAccess;

function configFor(settings: Record<string, unknown> = {}, paneState: Record<string, unknown> = {}): AppConfig {
  const config = createDefaultConfig("/tmp/gloomberb-options-scenario-test");
  config.layout = { dockRoot: { kind: "pane", instanceId: ID }, instances: [{ instanceId: ID,
    paneId: "options-scenario", binding: { kind: "none" }, settings: { ...SETTINGS, ...settings } }], floating: [], detached: [] };
  config.layouts = [{ name: "Default", layout: cloneLayout(config.layout),
    paneState: { [ID]: { pluginState: { [PLUGIN]: { activeTabId: "legs", ...paneState } } } } }];
  return config;
}

function Harness({ config }: { config: AppConfig }) {
  const initial = createInitialState(config);
  initial.focusedPaneId = ID;
  const [state, dispatch] = useReducer(appReducer, initial);
  useEffect(() => { latestState = state; }, [state]);
  return <AppContext value={{ state, dispatch }}><PaneInstanceProvider paneId={ID}>
    <PaneKeyboardScrollController paneId={ID} focused />
    <PluginRenderProvider pluginId={PLUGIN} runtime={runtime}><RemoteUiRegistryProvider registry={registry}>
      <PaneFooterProvider>{(footer) => <Box width={WIDTH} height={HEIGHT} flexDirection="column">
        <OptionsScenarioPane paneId={ID} paneType="options-scenario" focused width={WIDTH} height={HEIGHT - 1} />
        <PaneFooterBar footer={footer} focused width={WIDTH} />
      </Box>}</PaneFooterProvider>
    </RemoteUiRegistryProvider></PluginRenderProvider>
  </PaneInstanceProvider></AppContext>;
}

async function frame() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await setup!.renderOnce(); });
}

async function mount(config = configFor(), restoredRuntime?: PluginRuntimeAccess) {
  registry = createRemoteUiRegistry();
  runtime = restoredRuntime ?? createStatefulTestPluginRuntime();
  await act(async () => { setup = await testRender(<Harness config={config} />, { width: WIDTH, height: HEIGHT }); });
  await frame(); await frame();
}

async function unmount() {
  if (setup) await act(async () => { setup!.renderer.destroy(); });
  setup = undefined;
}

afterEach(unmount);

function paneState() { return latestState.paneState[ID]!.pluginState![PLUGIN]!; }
function evidence(): ScenarioEvidence {
  return registry.snapshot().find((node) => node.role === "chart-data" && node.metadata?.kind === "options-scenario")!.metadata as unknown as ScenarioEvidence;
}

async function field(label: string, value: string) {
  const node = registry.snapshot().find((node) => node.role === "text-field" && node.label === label);
  if (!node) throw new Error(`Missing field ${label}.\n${setup!.captureCharFrame()}`);
  await act(async () => { await registry.invoke(node.id, "setValue", value); });
  await frame();
}

async function press(label: string) {
  const node = registry.snapshot().find((node) => node.role === "button" && node.label === label);
  if (!node) throw new Error(`Missing button ${label}.\n${setup!.captureCharFrame()}`);
  await act(async () => { await registry.invoke(node.id, "press"); });
  await frame();
}

async function shortcut(name: string) {
  await emitKeypress(setup!, { name, sequence: name }, { trackPropagation: true });
  await frame();
}

test("edited legs update the scenario and survive a layout JSON restart", async () => {
  await mount();
  const original = evidence().scenario!;
  await shortcut("e");
  await field("Strike", "105");
  await field("Contracts", "2");
  await field("Entry price / unit", "4.75");
  await press("Save leg");
  const edited = paneState().position as ScenarioPosition;
  expect(edited.legs).toHaveLength(1);
  expect(edited.legs[0]).toMatchObject({ id: POSITION.legs[0]!.id, strike: 105, quantity: 2, price: 4.75 });
  expect(evidence().scenario!.valuation).toEqual(buildScenario(edited, evidence().scenario!.controls).valuation);
  expect(evidence().scenario!.valuation.pnl).not.toBe(original.valuation.pnl);
  const diskConfig = JSON.parse(JSON.stringify(latestState.config));
  await unmount();
  await mount(diskConfig);
  expect(evidence().scenario!.position).toEqual(edited);
  expect(paneState().position).toEqual(edited);
});

test("an OMON handoff appends once to existing legs and remains consumed after restart", async () => {
  const seed = { ...parseLegs("put,95,2026-12-18,-1,3,28")[0]!, id: "omon-put" };
  const raw = JSON.stringify(seed);
  await mount(configFor({ seedLeg: raw }, { position: POSITION }));
  expect(paneState().consumedSeed).toBe(raw);
  await field("Contracts", "3");
  await press("Save leg");
  const legs = (paneState().position as ScenarioPosition).legs;
  expect(legs).toHaveLength(2);
  expect(legs[0]).toEqual(POSITION.legs[0]!);
  expect(legs[1]).toMatchObject({ id: seed.id, side: "put", quantity: -3, strike: 95 });
  const diskConfig = JSON.parse(JSON.stringify(latestState.config));
  await unmount();
  await mount(diskConfig);
  expect((paneState().position as ScenarioPosition).legs).toEqual(legs);
  expect(paneState().consumedSeed).toBe(raw);
  expect(registry.snapshot().some((node) => node.role === "text-field" && node.label === "Strike")).toBe(false);
});

test("invalid assumptions cannot produce a priced position through the empty builder", async () => {
  await mount(configFor({ legs: "", rate: "invalid" }));
  expect(evidence().scenario).toBeNull();
  await shortcut("a");
  await field("Rate %", "4");
  await field("Spot range %", "");
  await press("Apply inputs");
  expect(evidence().scenario).toBeNull();
  expect(paneState().position).toBeUndefined();
  await field("Spot range %", "20");
  await press("Apply inputs");
  expect(evidence().scenario).toBeNull();
  await press("Save leg");
  expect(evidence().scenario!.position.rate).toBe(0.04);
  expect(evidence().scenario!.position.legs).toHaveLength(1);
  expect(evidence().complete).toBe(true);
});

test("saved strategy snapshots stay independent from later edits and reload from shared persistence", async () => {
  await mount();
  await shortcut("s");
  await field("Strategy name", "Original call");
  await press("Save");
  const saved = runtime.getResumeState<SavedScenarioStrategy[]>(PLUGIN, "osa-strategies", 1)!;
  expect(saved).toHaveLength(1);
  expect(saved[0]!.position).toEqual(POSITION);
  await shortcut("e");
  await field("Contracts", "4");
  await press("Save leg");
  expect(evidence().scenario!.position.legs[0]!.quantity).toBe(4);
  expect(saved[0]!.position.legs[0]!.quantity).toBe(1);
  const nextRuntime = createStatefulTestPluginRuntime();
  nextRuntime.setResumeState(PLUGIN, "osa-strategies", JSON.parse(JSON.stringify(saved)), 1);
  const diskConfig = JSON.parse(JSON.stringify(latestState.config));
  await unmount();
  await mount(diskConfig, nextRuntime);
  await shortcut("b");
  await emitKeypress(setup!, { name: "enter", sequence: "\r" }, { trackPropagation: true });
  await frame();
  expect(evidence().scenario!.position).toEqual(POSITION);
  expect((paneState().position as ScenarioPosition).legs[0]!.quantity).toBe(1);
});
