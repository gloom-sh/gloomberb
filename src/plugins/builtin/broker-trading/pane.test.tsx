import { expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { AppContext, appReducer, createInitialState, type AppAction } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { BrokerConnectionStatus } from "../../../types/broker";
import { BrokerOrdersPane, BrokerTradeTab } from "./pane";
import { createTradeCommand } from "./command";
import { createDemoBroker } from "./test-fixture";

const tui = createOpenTuiTestHarness({ width: 90, height: 30 });

test("a command prefills the resolved ticket once, focuses Review, and invalidates an existing review", async () => {
  const demo = createDemoBroker({ seedOrders: false });
  const paneId = "broker-ticket:command-test";
  const config = createTestPaneConfig("/synthetic/ticket-command", { instanceId: paneId, paneId: "ticker-detail", binding: { kind: "fixed", symbol: "AAPL" }, settings: {} });
  config.brokerInstances = [demo.instance];
  const initial = createInitialState(config);
  initial.focusedPaneId = paneId;
  initial.tickers.set("AAPL", createTestTicker("AAPL", "Example company"));
  const runtime = createTestPluginRuntime({ getBrokerAdapter: () => demo.adapter });
  let latest = initial;
  const listeners = new Set<() => void>();
  const store = {
    getState: () => latest,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispatch: (action: AppAction) => { latest = appReducer(latest, action); for (const listener of listeners) listener(); },
  };
  const commands = (["BUY", "SELL"] as const).map((action) => createTradeCommand({ pinTicker(symbol, options) {
    expect(symbol).toBe("AAPL");
    store.dispatch({ type: "UPDATE_PANE_STATE", paneId, patch: { ...options?.tabState, activeTabId: options?.tabId } });
  } }, action));
  let captured = false;
  const onCapture = (value: boolean) => { captured = value; };
  await act(async () => {
    await tui.render(<TestPaneFrame state={initial} paneId={paneId} pluginId="broker" runtime={runtime} width={90} height={30} footerKeys>{() => <AppContext value={store}><BrokerTradeTab width={90} height={29} focused onCapture={onCapture} /></AppContext>}</TestPaneFrame>);
  });
  await tui.waitForFrameToContain("Buy 1 AAPL");
  expect(captured).toBe(false);
  await tui.emitKeypress([{ name: "tab" }, { name: "tab" }, { name: "tab" }], { trackPropagation: true });
  expect(captured).toBe(true);
  await tui.emitKeypress({ name: "escape" }, { trackPropagation: true });
  expect(captured).toBe(false);
  await act(async () => { await commands[0]!.execute({ symbol: "AAPL", quantity: "7", limitPrice: "150" }); });
  await tui.waitForFrameToContain("Buy 7 AAPL");
  // A second command while already editing must prefill its own quote side too.
  await act(async () => { await commands[1]!.execute({ symbol: "AAPL", quantity: "3" }); });
  await tui.waitForFrameToContain("336.4");
  await tui.emitKeypress({ name: "enter", sequence: "\r" });
  await tui.waitForFrameToContain("Review Order");
  expect(demo.calls.filter((call) => call.method === "previewOrder").at(-1)?.request).toMatchObject({ action: "SELL", quantity: 3, limitPrice: 336.4 });
  await tui.emitKeypress({ name: "escape" });
  demo.calls.length = 0;
  await act(async () => { await commands[0]!.execute({ symbol: "AAPL", quantity: "7", limitPrice: "150" }); });
  await tui.waitForFrameToContain("Buy 7 AAPL");
  expect(latest.paneState[paneId]?.brokerTradeIntent).toBeNull();
  expect(demo.calls.filter((call) => call.method === "previewOrder")).toHaveLength(0);
  await tui.emitKeypress({ name: "enter", sequence: "\r" });
  await tui.waitForFrameToContain("Review Order");
  expect(demo.calls.filter((call) => call.method === "previewOrder").at(-1)?.request).toMatchObject({ action: "BUY", quantity: 7, limitPrice: 150, orderType: "LMT" });

  await act(async () => { await commands[1]!.execute({ symbol: "AAPL", quantity: "3" }); });
  await tui.waitForFrameToContain("Sell 3 AAPL");
  expect(latest.paneState[paneId]?.brokerTradeIntent).toBeNull();
  expect(demo.calls.filter((call) => call.method === "previewOrder")).toHaveLength(1);
  await tui.emitKeypress({ name: "enter", sequence: "\r" });
  await tui.waitForFrameToContain("Review Order");
  expect(demo.calls.filter((call) => call.method === "previewOrder").at(-1)?.request).toMatchObject({ action: "SELL", quantity: 3, limitPrice: 336.4, orderType: "LMT" });
  expect(demo.calls.filter((call) => ["placeOrder", "modifyOrder", "cancelOrder"].includes(call.method))).toHaveLength(0);
});

test.each(["trade", "orders"] as const)("%s broker selection is reachable without a pointer", async (view) => {
  const first = createDemoBroker();
  const second = createDemoBroker();
  second.adapter = { ...second.adapter, id: "second-demo-broker", name: "Second demo broker" };
  second.instance = { ...second.instance, id: "second-profile", label: "Second profile", brokerType: second.adapter.id };
  const paneId = "broker-ticket:profiles";
  const config = createTestPaneConfig("/synthetic/ticket-profiles", { instanceId: paneId, paneId: "ticker-detail", binding: { kind: "fixed", symbol: "AAPL" }, settings: {} });
  config.brokerInstances = [first.instance, second.instance];
  const state = createInitialState(config);
  state.focusedPaneId = paneId;
  state.tickers.set("AAPL", createTestTicker("AAPL", "Example company"));
  const runtime = createTestPluginRuntime({ getBrokerAdapter: (id) => id === first.adapter.id ? first.adapter : second.adapter });
  await act(async () => {
    await tui.render(<TestPaneFrame state={state} paneId={paneId} pluginId="broker" runtime={runtime} width={90} height={30} footerKeys>{() => view === "trade"
      ? <BrokerTradeTab width={90} height={29} focused onCapture={() => {}} />
      : <BrokerOrdersPane paneId={paneId} paneType="broker-orders" width={90} height={29} focused />}</TestPaneFrame>);
  });
  await tui.waitForFrameToContain("Choose");
  await tui.emitKeypress({ name: "d", sequence: "d" }, { trackPropagation: true });
  await tui.waitForFrameToContain(view === "trade" ? "Second demo broker" : "Second profile");
  await tui.emitKeypress([{ name: "down" }, { name: "enter", sequence: "\r" }], { trackPropagation: true });
  await tui.waitForFrameToContain(view === "trade" ? "Buy 1 AAPL" : "No open orders in this account.");
  await tui.waitForFrameToExclude(view === "trade" ? "Choose a broker" : "Choose a profile");
  expect(first.calls.some((call) => ["placeOrder", "modifyOrder", "cancelOrder"].includes(call.method))).toBe(false);
  expect(second.calls.some((call) => ["placeOrder", "modifyOrder", "cancelOrder"].includes(call.method))).toBe(false);
});

test("broker read status heartbeats never reschedule account or holdings reads", async () => {
  const demo = createDemoBroker();
  let status: BrokerConnectionStatus = { state: "connected", mode: "simulation", quoteData: "delayed", updatedAt: 1 };
  const listeners = new Set<() => void>();
  const emit = (patch: Partial<BrokerConnectionStatus> = {}) => {
    status = { ...status, updatedAt: status.updatedAt + 1, ...patch };
    for (const listener of [...listeners]) listener();
  };
  demo.adapter.getStatus = () => status;
  demo.adapter.subscribeStatus = (_instance, listener) => {
    listeners.add(listener); listener();
    return () => { listeners.delete(listener); };
  };
  const calls = { accounts: 0, positions: 0, quote: 0 };
  const { listAccounts, importPositions, getQuote } = demo.adapter;
  demo.adapter.listAccounts = async (instance) => {
    calls.accounts++;
    // End a broken feedback loop promptly so the regression fails without flooding output.
    if (calls.accounts > 12) throw new Error("Account requests did not settle.");
    const accounts = await listAccounts!(instance); emit(); return accounts;
  };
  demo.adapter.importPositions = async (instance) => { calls.positions++; const positions = await importPositions(instance); emit(); return positions; };
  demo.adapter.getQuote = async (...args) => { calls.quote++; const quote = await getQuote!(...args); emit(); return quote; };
  const paneId = "broker-ticket:status-test";
  const config = createTestPaneConfig("/synthetic/ticket-status", { instanceId: paneId, paneId: "ticker-detail", binding: { kind: "fixed", symbol: "AAPL" }, settings: {} });
  config.brokerInstances = [demo.instance];
  const state = createInitialState(config);
  state.focusedPaneId = paneId;
  state.tickers.set("AAPL", createTestTicker("AAPL", "Example company"));
  const runtime = createTestPluginRuntime({ getBrokerAdapter: () => demo.adapter });
  await act(async () => {
    await tui.render(<TestPaneFrame state={state} paneId={paneId} pluginId="broker" runtime={runtime} width={90} height={30}>{() => <BrokerTradeTab width={90} height={29} focused onCapture={() => {}} />}</TestPaneFrame>);
  });
  await tui.renderFrames(8);
  expect(calls).toEqual({ accounts: 2, positions: 1, quote: 1 });

  await act(async () => { for (let index = 0; index < 50; index++) emit({ message: `Read completed ${index}` }); });
  await tui.renderFrames(8);
  expect(calls).toEqual({ accounts: 2, positions: 1, quote: 1 });

  await act(async () => { emit({ state: "error", message: "Rate limited. Try again in 30 seconds." }); });
  await tui.waitForFrameToContain("Rate limited. Try again in 30 seconds.");
  expect(calls).toEqual({ accounts: 2, positions: 1, quote: 1 });
  await act(async () => { emit({ state: "disconnected" }); });
  await tui.renderFrames(3);
  expect(calls).toEqual({ accounts: 2, positions: 1, quote: 1 });
  await act(async () => { emit({ state: "connected" }); });
  await tui.renderFrames(8);
  expect(calls).toEqual({ accounts: 4, positions: 2, quote: 2 });

  await act(async () => { emit({ quoteData: "realtime", mode: "refreshed-session" }); });
  await tui.renderFrames(8);
  expect(calls).toEqual({ accounts: 6, positions: 3, quote: 3 });
  expect(demo.calls.some((call) => ["placeOrder", "modifyOrder", "cancelOrder"].includes(call.method))).toBe(false);
  await tui.destroy();
  expect(listeners.size).toBe(0);
});

test("a profile reconnecting keeps its account and says so instead of disconnected", async () => {
  const demo = createDemoBroker({ seedOrders: false });
  let status: BrokerConnectionStatus = { state: "connected", mode: "simulation", quoteData: "delayed", updatedAt: 1 };
  const listeners = new Set<() => void>();
  demo.adapter.getStatus = () => status;
  demo.adapter.subscribeStatus = (_instance, listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const paneId = "broker-ticket:reconnect-test";
  const config = createTestPaneConfig("/synthetic/ticket-reconnect", { instanceId: paneId, paneId: "ticker-detail", binding: { kind: "fixed", symbol: "AAPL" }, settings: {} });
  config.brokerInstances = [demo.instance];
  const state = createInitialState(config);
  state.focusedPaneId = paneId;
  state.tickers.set("AAPL", createTestTicker("AAPL", "Example company"));
  const runtime = createTestPluginRuntime({ getBrokerAdapter: () => demo.adapter });
  await act(async () => {
    await tui.render(<TestPaneFrame state={state} paneId={paneId} pluginId="broker" runtime={runtime} width={90} height={30}>{() => <BrokerTradeTab width={90} height={29} focused onCapture={() => {}} />}</TestPaneFrame>);
  });
  await tui.waitForFrameToContain("Buy 1 AAPL");
  const account = demo.accounts()[0]!.name;
  await act(async () => { status = { ...status, state: "connecting", updatedAt: 2 }; for (const listener of [...listeners]) listener(); });
  await tui.waitForFrameToContain("Reconnecting to Demo Broker...");
  expect(tui.frame()).toContain(account);
  expect(tui.frame()).not.toContain("Broker disconnected");
});
