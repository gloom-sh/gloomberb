import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { AppContext, appReducer, createInitialState, type AppAction } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box, Text } from "../../../ui";
import { useShortcut } from "../../../react/input";
import { setSharedRegistryForTests, type PluginRegistry } from "../../registry";
import { TickerResearchPane } from "../ticker-detail/pane";
import { ResearchTradeActions, useResearchTrading } from "../shared/research-trading";
import { BrokerTradeTab } from "./pane";
import { createTradeIntent } from "./command";
import { createDemoBroker } from "./test-fixture";
import { brokerOrderFeed } from "./order-feed";
import type { AppNotificationRequest } from "../../../types/plugin";

const toasts: AppNotificationRequest[] = [];

const tui = createOpenTuiTestHarness({ width: 140, height: 40 });
afterEach(() => { setSharedRegistryForTests(undefined); brokerOrderFeed.clear(); brokerOrderFeed.setNotifier(undefined); });
function PriceContext({ width, focused }: { width: number; focused: boolean }) {
  const trade = useResearchTrading();
  const [zooms, setZooms] = useState(0);
  // Stands in for the chart's own keys, such as + to zoom.
  useShortcut((event) => {
    if (event.defaultPrevented || event.propagationStopped || event.targetEditable || event.name !== "+") return;
    event.preventDefault(); event.stopPropagation(); setZooms((value) => value + 1);
  }, { enabled: focused });
  return <Box flexDirection="column"><Text>{`PRICE CONTEXT ${width}`}</Text><Text>{`ZOOMS ${zooms}`}</Text><ResearchTradeActions focused={focused} />{trade?.levels.map((level) => <Text key={level.id}>{level.label}</Text>)}</Box>;
}
function OverviewStandIn({ width, focused }: { width: number; focused: boolean }) {
  const trade = useResearchTrading();
  return <Box flexDirection="column"><Text>{`OVERVIEW ${width}`}</Text><ResearchTradeActions focused={focused} />{trade?.orders?.(width)}</Box>;
}
async function mount(outcome: "working" | "unknown" = "working", initialWidth = 140, lockedChart = false, seedOrders = true) {
  const demo = createDemoBroker({ realtime: true, quoteAgeMs: 0, outcome, seedOrders });
  const paneId = "ticker-detail:dock-test";
  const config = createTestPaneConfig("/synthetic/dock-test", { instanceId: paneId, paneId: "ticker-detail", binding: { kind: "fixed", symbol: "AAPL" }, settings: lockedChart ? { hideTabs: true, lockedTabId: "chart" } : undefined });
  config.brokerInstances = [demo.instance];
  const initial = createInitialState(config); initial.focusedPaneId = paneId;
  initial.tickers.set("AAPL", createTestTicker("AAPL", "Synthetic company"));
  initial.paneState[paneId] = { activeTabId: "chart" };
  setSharedRegistryForTests({ tickerResearchTabs: new Map([
    ["overview", { id: "overview", name: "Overview", order: 0, component: OverviewStandIn }],
    ["chart", { id: "chart", name: "Chart", order: 1, component: PriceContext }],
    ["broker-trade", { id: "broker-trade", name: "Trade", order: 2, component: BrokerTradeTab }],
  ]) } as unknown as PluginRegistry);
  let latest = initial;
  const listeners = new Set<() => void>();
  const store = { getState: () => latest, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispatch: (action: AppAction) => { latest = appReducer(latest, action); for (const listener of listeners) listener(); } };
  const dispatch = store.dispatch;
  toasts.length = 0;
  // The plugin's setup sends order toasts to the app's notifications.
  brokerOrderFeed.setNotifier((notification) => { toasts.push(notification); });
  const runtime = createTestPluginRuntime({ getBrokerAdapter: () => demo.adapter, notify: (notification) => { toasts.push(notification); } });
  let resize!: (width: number) => void;
  function Harness() {
    const [width, setWidth] = useState(initialWidth); resize = setWidth;
    return <TestPaneFrame state={initial} paneId={paneId} pluginId="broker" runtime={runtime} width={140} height={40} footerKeys>
      {({ height }) => <AppContext value={store}><TickerResearchPane paneId={paneId} paneType="ticker-detail" focused width={width} height={height} /></AppContext>}
    </TestPaneFrame>;
  }
  await tui.render(<Harness />);
  await tui.waitForFrameToContain(`PRICE CONTEXT ${initialWidth}`);
  return { demo, tab: async (activeTabId: string) => act(async () => dispatch({ type: "UPDATE_PANE_STATE", paneId, patch: { activeTabId } })),
    resize: async (width: number) => act(async () => resize(width)),
    command: async () => act(async () => dispatch({ type: "UPDATE_PANE_STATE", paneId, patch: { activeTabId: "broker-trade", brokerTradeIntent: createTradeIntent({ action: "BUY", quantity: 2, limitPrice: 336.5 }) } })) };
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
  // b again selects the side, and two tabs from it reach Quantity.
  await tui.emitKeypress({ name: "b" });
  for (let index = 0; index < 2; index++) await tui.emitKeypress({ name: "tab" });
  await tui.waitForFrameToContain("> Quantity");
  await tui.emitKeypress({ name: "f6" });
  await tui.emitKeypress({ name: "escape" });
  await tui.waitForFrameToContain("PRICE CONTEXT 140");
  expect(f.demo.calls.filter((call) => call.method === "placeOrder")).toHaveLength(0);
});

test("chart keys the ticket leaves still reach the chart, but not while a ticket field takes typing", async () => {
  await mount();
  await tui.emitKeypress({ name: "b" });
  await tui.waitForFrameToContain("Buy 1 AAPL");
  await tui.emitKeypress({ name: "+" });
  await tui.waitForFrameToContain("ZOOMS 1");
  // b selects the side inside the ticket; it does not reopen the panel.
  await tui.emitKeypress({ name: "s" });
  await tui.waitForFrameToContain("Sell 1 AAPL");
  // Two tabs from the side reach Quantity, which takes typing, so + stays in it.
  for (let index = 0; index < 2; index++) await tui.emitKeypress({ name: "tab" });
  await tui.waitForFrameToContain("> Quantity");
  await tui.emitKeypress({ name: "+" });
  // Escape leaves the field but not the ticket, and + reaches the chart again.
  await tui.emitKeypress({ name: "escape" });
  await tui.emitKeypress({ name: "+" });
  await tui.waitForFrameToContain("ZOOMS 2");
  expect(tui.frame()).toContain("Sell 1 AAPL");
  expect(tui.frame()).not.toContain("ZOOMS 3");
});

test("docked open orders stay hidden without orders, and o shows them from the ticket and hides them again", async () => {
  await mount("working", 140, false, false);
  await tui.emitKeypress({ name: "b" });
  await tui.waitForFrameToContain("Buy 1 AAPL");
  expect(tui.frame()).not.toContain("Open Orders");
  await tui.emitKeypress({ name: "o" });
  await tui.waitForFrameToContain("Open Orders (0)");
  await tui.emitKeypress({ name: "o" });
  await tui.waitForFrameToExclude("Open Orders");
  // Shift is no ticket key: Shift+O leaves them as they are.
  await tui.emitKeypress({ name: "O", shift: true });
  expect(tui.frame()).not.toContain("Open Orders");
});

test("orders follow the ticket content in Working, leaving spare height below the list", async () => {
  const f = await mount();
  await f.command();
  await tui.waitForFrameToContain("Buy 2 AAPL");
  const gapAfter = (text: string) => {
    const lines = tui.frame().split("\n");
    const actionRow = lines.findIndex((line) => line.includes(text));
    const ordersRow = lines.findIndex((line) => line.includes("Open Orders"));
    expect(actionRow).toBeGreaterThan(0);
    expect(ordersRow).toBeGreaterThan(actionRow);
    expect(ordersRow - actionRow).toBeLessThanOrEqual(3);
  };
  await tui.emitKeypress({ name: "enter" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Review Order");
  await tui.emitKeypress({ name: "tab" }, { trackPropagation: true });
  await tui.emitKeypress({ name: "enter" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Refresh · Orders · New");
  await tui.waitForFrameToContain("Open Orders");
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

test("a placed order and its later fill each say so once in a toast", async () => {
  const f = await mount("working", 140, false, false);
  await f.command();
  await tui.waitForFrameToContain("Buy 2 AAPL");
  await tui.emitKeypress({ name: "enter" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Review Order");
  await tui.emitKeypress({ name: "tab" }, { trackPropagation: true });
  await tui.emitKeypress({ name: "enter" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Refresh · Orders · New");
  expect(toasts.map((toast) => toast.title)).toEqual(["Order placed"]);
  expect(toasts[0]!.body).toBe("Buy 2 AAPL limit 336.5");
  const [working] = await f.demo.adapter.listOpenOrders!(f.demo.instance);
  f.demo.adapter.listOpenOrders = async () => [{ ...working!, status: "FILLED", filled: 2, remaining: 0, avgFillPrice: 336.45, updatedAt: working!.updatedAt + 1 }];
  await tui.emitKeypress({ name: "r" }, { trackPropagation: true });
  await tui.waitForFrameToContain("2 of 2 filled");
  expect(toasts.map((toast) => toast.title)).toEqual(["Order placed", "Order filled"]);
  expect(toasts[1]!.body).toBe("Buy 2 AAPL limit 336.5 · 2 filled at 336.45");
});

test("Chart stays the chart alone, Trade puts the ticket beside it, and the divider drags", async () => {
  await mount();
  expect(tui.frame()).not.toContain("Buy 1 AAPL");
  await tui.emitKeypress({ name: "b" });
  await tui.waitForFrameToContain("Buy 1 AAPL");
  expect(tui.frame()).toContain("PRICE CONTEXT 106");
  const mouse = tui.setup().mockMouse;
  await act(async () => { await mouse.drag(106, 10, 96, 10); });
  await tui.waitForFrameToContain("PRICE CONTEXT 96");
  // Escape returns to Chart; Trade reopens at the dragged width.
  await tui.emitKeypress({ name: "f6" });
  await tui.emitKeypress({ name: "escape" });
  await tui.waitForFrameToContain("PRICE CONTEXT 140");
  await tui.emitKeypress({ name: "b" });
  await tui.waitForFrameToContain("PRICE CONTEXT 96");
});

test("Overview lists the ticker's working orders and fills without the ticket, and an order opens Trade to change it", async () => {
  const f = await mount();
  await f.tab("overview");
  // Orders come from the shared feed and fills from their own read, so either can draw first.
  await tui.waitForFrameToContain("Buy 10 · Limit 336.50");
  await tui.waitForFrameToContain("Sold 4 at 340.00");
  const frame = tui.frame();
  expect(frame).toContain("Sell 10 · Limit 340.00 · 4 of 10 filled");
  expect(frame).not.toContain("Review");
  const row = frame.split("\n").findIndex((line) => line.includes("Buy 10 · Limit 336.50"));
  await act(async () => { await tui.setup().mockMouse.click(4, row); });
  await tui.waitForFrameToContain("Modify Order");
  expect(f.demo.calls.filter((call) => ["previewOrder", "placeOrder", "modifyOrder", "cancelOrder"].includes(call.method))).toEqual([]);
});
