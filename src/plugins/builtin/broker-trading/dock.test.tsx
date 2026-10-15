import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { AppContext, appReducer, createInitialState, type AppAction } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box, Text } from "../../../ui";
import { setSharedRegistryForTests, type PluginRegistry } from "../../registry";
import { TickerResearchPane } from "../ticker-detail/pane";
import { ResearchTradeActions, useResearchTrading } from "../shared/research-trading";
import { BrokerTradeTab } from "./pane";
import { createTradeIntent } from "./command";
import { createDemoBroker } from "./test-fixture";

const tui = createOpenTuiTestHarness({ width: 140, height: 40 });
afterEach(() => setSharedRegistryForTests(undefined));
function PriceContext({ width, focused }: { width: number; focused: boolean }) {
  const trade = useResearchTrading();
  return <Box flexDirection="column"><Text>{`PRICE CONTEXT ${width}`}</Text><ResearchTradeActions focused={focused} />{trade?.levels.map((level) => <Text key={level.id}>{level.label}</Text>)}</Box>;
}
async function mount(outcome: "working" | "unknown" = "working", initialWidth = 140, lockedChart = false) {
  const demo = createDemoBroker({ realtime: true, quoteAgeMs: 0, outcome });
  const paneId = "ticker-detail:dock-test";
  const config = createTestPaneConfig("/synthetic/dock-test", { instanceId: paneId, paneId: "ticker-detail", binding: { kind: "fixed", symbol: "AAPL" }, settings: lockedChart ? { hideTabs: true, lockedTabId: "chart" } : undefined });
  config.brokerInstances = [demo.instance];
  const initial = createInitialState(config); initial.focusedPaneId = paneId;
  initial.tickers.set("AAPL", createTestTicker("AAPL", "Synthetic company"));
  initial.paneState[paneId] = { activeTabId: "chart" };
  setSharedRegistryForTests({ tickerResearchTabs: new Map([
    ["overview", { id: "overview", name: "Overview", order: 0, component: PriceContext }],
    ["chart", { id: "chart", name: "Chart", order: 1, component: PriceContext }],
    ["broker-trade", { id: "broker-trade", name: "Trade", order: 2, component: BrokerTradeTab }],
  ]) } as unknown as PluginRegistry);
  let latest = initial;
  const listeners = new Set<() => void>();
  const store = { getState: () => latest, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispatch: (action: AppAction) => { latest = appReducer(latest, action); for (const listener of listeners) listener(); } };
  const dispatch = store.dispatch;
  const runtime = createTestPluginRuntime({ getBrokerAdapter: () => demo.adapter });
  let resize!: (width: number) => void;
  function Harness() {
    const [width, setWidth] = useState(initialWidth); resize = setWidth;
    return <TestPaneFrame state={initial} paneId={paneId} pluginId="broker" runtime={runtime} width={140} height={40} footerKeys>
      {({ height }) => <AppContext value={store}><TickerResearchPane paneId={paneId} paneType="ticker-detail" focused width={width} height={height} /></AppContext>}
    </TestPaneFrame>;
  }
  await tui.render(<Harness />);
  await tui.waitForFrameToContain(`PRICE CONTEXT ${initialWidth}`);
  return { demo, resize: async (width: number) => act(async () => resize(width)),
    command: async () => act(async () => dispatch({ type: "UPDATE_PANE_STATE", paneId, patch: { activeTabId: "chart", brokerTradeIntent: createTradeIntent({ action: "BUY", quantity: 2, limitPrice: 336.5 }) } })) };
}

test("Research opens beside either chart surface, falls back at 90 columns, and never submits on open", async () => {
  const f = await mount();
  await tui.emitKeypress({ name: "b" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Buy 1 AAPL");
  expect(tui.frame()).toContain("PRICE CONTEXT 106");
  await tui.emitKeypress({ name: "escape" }, { trackPropagation: true });
  await tui.waitForFrameToContain("PRICE CONTEXT 140");
  await tui.emitKeypress({ name: "h" }, { trackPropagation: true });
  await tui.emitKeypress({ name: "s" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Sell 1 AAPL");
  expect(tui.frame()).toContain("PRICE CONTEXT 106");
  await f.resize(90);
  await tui.waitForFrameToContain("Order Details");
  expect(tui.frame()).not.toContain("PRICE CONTEXT");
  expect(f.demo.calls.filter((call) => ["previewOrder", "placeOrder"].includes(call.method))).toEqual([]);
});

test("a locked Chart pane still replaces the chart with the narrow fallback and restores it on Escape", async () => {
  const f = await mount("working", 90, true);
  await tui.emitKeypress({ name: "b" });
  await tui.waitForFrameToContain("Buy 1 AAPL");
  expect(tui.frame()).not.toContain("PRICE CONTEXT");
  await tui.emitKeypress({ name: "escape" });
  await tui.waitForFrameToContain("PRICE CONTEXT 90");
  expect(f.demo.calls.filter((call) => call.method === "placeOrder")).toHaveLength(0);
});

test("the dock keeps long time-in-force choices identifiable at 34 columns", async () => {
  await mount();
  await tui.emitKeypress({ name: "b" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Buy 1 AAPL");
  await tui.emitKeypress({ name: "t" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Good til cancelled");
  await tui.emitKeypress({ name: "down" }, { trackPropagation: true });
  await tui.emitKeypress({ name: "enter" }, { trackPropagation: true });
  await tui.waitForFrameToContain("GTC");
  await tui.waitForFrameToExclude("Good til");
});

test("F6 releases a numeric field to the chart and Escape closes without a mutation", async () => {
  const f = await mount();
  await tui.emitKeypress({ name: "b" });
  await tui.waitForFrameToContain("Buy 1 AAPL");
  for (let index = 0; index < 3; index++) await tui.emitKeypress({ name: "tab" });
  await tui.emitKeypress({ name: "f6" });
  await tui.emitKeypress({ name: "escape" });
  await tui.waitForFrameToContain("PRICE CONTEXT 140");
  expect(f.demo.calls.filter((call) => call.method === "placeOrder")).toHaveLength(0);
});

test("orders follow the ticket content in entry and Working, leaving spare height below the list", async () => {
  const f = await mount();
  await f.command();
  await tui.waitForFrameToContain("Buy 2 AAPL");
  await tui.waitForFrameToContain("Open Orders");
  const gapAfter = (text: string) => {
    const lines = tui.frame().split("\n");
    const actionRow = lines.findIndex((line) => line.includes(text));
    const ordersRow = lines.findIndex((line) => line.includes("Open Orders"));
    expect(actionRow).toBeGreaterThan(0);
    expect(ordersRow).toBeGreaterThan(actionRow);
    expect(ordersRow - actionRow).toBeLessThanOrEqual(3);
  };
  gapAfter("Buy 2 AAPL");
  await tui.emitKeypress({ name: "enter" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Review Order");
  await tui.emitKeypress({ name: "tab" }, { trackPropagation: true });
  await tui.emitKeypress({ name: "enter" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Refresh · Orders · New");
  gapAfter("Refresh · Orders · New");
  expect(f.demo.calls.filter((call) => call.method === "placeOrder")).toHaveLength(1);
});

test("commands, review, UNKNOWN and its lock survive closing and wide/narrow transitions", async () => {
  const f = await mount("unknown");
  await f.command();
  await tui.waitForFrameToContain("Buy 2 AAPL");
  await tui.emitKeypress({ name: "enter" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Review Order");
  expect(tui.frame()).toContain("PRICE CONTEXT 106");
  await tui.emitKeypress({ name: "tab" }, { trackPropagation: true });
  await tui.emitKeypress({ name: "enter" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Outcome Unknown");
  const placed = f.demo.calls.filter((call) => call.method === "placeOrder");
  expect(placed).toHaveLength(1);
  await tui.emitKeypress({ name: "escape" }, { trackPropagation: true });
  await tui.waitForFrameToContain("PRICE CONTEXT 140");
  await f.command();
  await tui.waitForFrameToContain("Outcome Unknown");
  await f.resize(90);
  await tui.waitForFrameToContain("Outcome Unknown");
  await f.resize(140);
  await tui.waitForFrameToContain("PRICE CONTEXT 106");
  await tui.emitKeypress([{ name: "enter" }, { name: "enter" }], { trackPropagation: true });
  expect(f.demo.calls.filter((call) => call.method === "placeOrder")).toHaveLength(1);
});
