import { expect, test } from "bun:test";
import { act, useEffect, useReducer } from "react";
import { PaneFooterBar, PaneFooterKeys, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createRemoteUiRegistry, RemoteUiRegistryProvider, type RemoteUiRegistry } from "../../../remote/semantic-tree";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, appReducer, createInitialState } from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { PaneKeyboardScrollController } from "../../../state/pane-scroll-registry";
import { createStatefulTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { AppConfig } from "../../../types/config";
import { Box } from "../../../ui";
import { PluginRenderProvider, type PluginRuntimeAccess } from "../../runtime";
import { valueOption, daysToExpiryFrom } from "../shared/volatility";
import type { ScenarioMarketSnapshot } from "./client";
import { type ScenarioEvidence } from "./evidence";
import { buildScenario, parseLegs, type ScenarioPosition } from "./model";
import { OptionsScenarioPane } from "./pane";
import { type SavedScenarioStrategy } from "./state";
import { createTestPaneConfig } from "../../../test-support/pane";

const ID = "options-scenario:test";
const PLUGIN = "ticker-research";
let WIDTH = 100;
const HEIGHT = 32;
const SETTINGS = { symbol: "AAPL", spot: "100", rate: "4", dividendYield: "0", currency: "USD",
  asOf: "2026-09-22T00:00:00Z", legs: "call,100,2026-12-18,1,5,25" };
const POSITION: ScenarioPosition = { symbol: "AAPL", spot: 100, rate: 0.04, dividendYield: 0, currency: "USD",
  asOf: Date.UTC(2026, 8, 22), legs: parseLegs(SETTINGS.legs) };

const tui = createOpenTuiTestHarness();
let registry: RemoteUiRegistry;
let latestState: ReturnType<typeof createInitialState>;
let runtime: PluginRuntimeAccess;

function configFor(settings: Record<string, unknown> = {}, paneState: Record<string, unknown> = {}): AppConfig {
  const config = createTestPaneConfig("/tmp/gloomberb-options-scenario-test", {
    instanceId: ID, paneId: "options-scenario", binding: { kind: "none" }, settings: { ...SETTINGS, ...settings },
  });
  config.layouts[0]!.paneState = { [ID]: { pluginState: { [PLUGIN]: { activeTabId: "legs", ...paneState } } } };
  return config;
}

function Harness({ config }: { config: AppConfig }) {
  const initial = createInitialState(config);
  initial.focusedPaneId = ID;
  const [state, dispatch] = useReducer(appReducer, initial);
  useEffect(() => { latestState = state; }, [state]);
  return <AppContext value={createStaticAppStore(state, dispatch)}><PaneInstanceProvider paneId={ID}>
    <PaneKeyboardScrollController paneId={ID} focused />
    <PluginRenderProvider pluginId={PLUGIN} runtime={runtime}><RemoteUiRegistryProvider registry={registry}>
      <PaneFooterProvider>{(footer) => <Box width={WIDTH} height={HEIGHT} flexDirection="column">
        <PaneFooterKeys paneId={ID} footer={footer} focused />
        <OptionsScenarioPane paneId={ID} paneType="options-scenario" focused width={WIDTH} height={HEIGHT - 1} />
        <PaneFooterBar footer={footer} focused width={WIDTH} />
      </Box>}</PaneFooterProvider>
    </RemoteUiRegistryProvider></PluginRenderProvider>
  </PaneInstanceProvider></AppContext>;
}

async function frame() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await tui.setup().renderOnce(); });
}

async function mount(config = configFor(), restoredRuntime?: PluginRuntimeAccess) {
  registry = createRemoteUiRegistry();
  runtime = restoredRuntime ?? createStatefulTestPluginRuntime();
  await act(async () => { await tui.render(<Harness config={config} />, { width: WIDTH, height: HEIGHT }); });
  await frame(); await frame();
}

function paneState() { return latestState.paneState[ID]!.pluginState![PLUGIN]!; }
function evidence(): ScenarioEvidence {
  return registry.snapshot().find((node) => node.role === "chart-data" && node.metadata?.kind === "options-scenario")!.metadata as unknown as ScenarioEvidence;
}

async function field(label: string, value: string) {
  const node = registry.snapshot().find((node) => node.role === "text-field" && node.label === label);
  if (!node) throw new Error(`Missing field ${label}.\n${tui.frame()}`);
  await act(async () => { await registry.invoke(node.id, "setValue", value); });
  await frame();
}

async function press(label: string) {
  const node = registry.snapshot().find((node) => node.role === "button" && node.label === label);
  if (!node) throw new Error(`Missing button ${label}.\n${tui.frame()}`);
  await act(async () => { await registry.invoke(node.id, "press"); });
  await frame();
}

async function shortcut(name: string) {
  await tui.emitKeypress({ name, sequence: name }, { trackPropagation: true });
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
  await tui.destroy();
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
  await tui.destroy();
  await mount(diskConfig);
  expect((paneState().position as ScenarioPosition).legs).toEqual(legs);
  expect(paneState().consumedSeed).toBe(raw);
  expect(registry.snapshot().some((node) => node.role === "text-field" && node.label === "Strike")).toBe(false);
});

test("Tab leaves the pane and the vol shift field opens from its own key", async () => {
  await mount();
  const tab = await tui.emitKeypress({ name: "tab", sequence: "\t" }, { trackPropagation: true });
  expect(tab.defaultPrevented).toBe(false);
  expect(tab.propagationStopped).toBe(false);
  await shortcut("v");
  await shortcut("5");
  const commit = await tui.emitKeypress({ name: "tab", sequence: "\t" }, { trackPropagation: true });
  await frame();
  expect(commit.defaultPrevented).toBe(true);
  expect(evidence().scenario!.controls.volShift).toBeCloseTo(0.05);
  const next = await tui.emitKeypress({ name: "tab", sequence: "\t" }, { trackPropagation: true });
  expect(next.defaultPrevented).toBe(false);
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
  await tui.destroy();
  await mount(diskConfig, nextRuntime);
  await shortcut("b");
  await tui.emitKeypress({ name: "enter", sequence: "\r" }, { trackPropagation: true });
  await frame();
  expect(evidence().scenario!.position).toEqual(POSITION);
  expect((paneState().position as ScenarioPosition).legs[0]!.quantity).toBe(1);
});

test("a strategy seeded from older quotes names the last print beside the spot they imply", async () => {
  // The close's same-day chain (spot 100, 30%) against a 100.25 after-hours print.
  const expiration = Date.UTC(2026, 8, 23) / 1000;
  const quotedAt = Date.UTC(2026, 8, 22, 20);
  const contract = (side: "call" | "put", strike: number) => {
    const { price } = valueOption({ side, spot: 100, strike, daysToExpiry: daysToExpiryFrom(expiration, quotedAt), rate: 0.04,
      dividendYield: 0.005, volatility: 0.3 });
    return { contractSymbol: `AAPL${side}${strike}`, strike, bid: price - 0.01, ask: price + 0.01, currency: "USD", expiration,
      impliedVolatility: 0, lastPrice: 0, change: 0, percentChange: 0, inTheMoney: false, lastTradeDate: quotedAt / 1000 };
  };
  const strikes = [97.5, 100, 102.5, 105];
  const market: ScenarioMarketSnapshot = { symbol: "AAPL", spot: 100.25, currency: "USD", asOf: Date.UTC(2026, 8, 23),
    chain: { underlyingSymbol: "AAPL", expirationDates: [expiration], asOf: new Date(quotedAt).toISOString(),
      calls: strikes.map((strike) => contract("call", strike)), puts: strikes.map((strike) => contract("put", strike)) },
    expirationDates: [expiration], rate: 0.04, dividendYield: 0.005, source: "test", underlyingQuote: null, rateAsOf: [], warnings: [] };
  // Wide enough for the footer status beside its key hints.
  WIDTH = 220;
  try {
    await mount(configFor({ spot: "", rate: "", dividendYield: "", asOf: "", legs: "", strategy: "vertical", scenarioMarketSnapshot: market }));
    const scenario = evidence().scenario!;
    expect(scenario.position.spot).toBeCloseTo(100, 2);
    expect(Math.abs(scenario.valuation.pnl)).toBeLessThan(1e-6);
    expect(tui.frame()).toContain("2026-09-23 · market · IV from quote mid · last 100.25");
    // Float noise at the flat origin is not a red -0.00.
    expect(tui.frame()).toMatch(/P&L +0\.00 +USD/);
  } finally { WIDTH = 100; }
});
