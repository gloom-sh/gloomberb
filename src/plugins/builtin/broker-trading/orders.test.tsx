import { expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { BrokerOrder } from "../../../types/trading";
import { BrokerOrdersView } from "./orders";
import { createDemoBroker, type DemoBrokerOptions } from "./test-fixture";

const tui = createOpenTuiTestHarness({ width: 90, height: 30 });
const paneId = "broker-orders:test";

async function mount(options: DemoBrokerOptions = {}, selectedAccount?: string | null, confirmedCancel = false) {
  const demo = createDemoBroker(options);
  if (confirmedCancel) demo.adapter.getOrderStatus = async (_instance, orderId) => demo.order(demo.draft, "CANCELED", orderId);
  const config = createTestPaneConfig("/synthetic/orders-render", { instanceId: paneId, paneId: "broker-orders", binding: { kind: "none" }, settings: {} });
  config.brokerInstances = [demo.instance];
  const state = createInitialState(config); state.focusedPaneId = paneId;
  const modifications: BrokerOrder[] = [];
  let returnedToTicket = 0;
  await act(async () => { await tui.render(<TestPaneFrame state={state} paneId={paneId} pluginId="broker-trading" runtime={createTestPluginRuntime()} width={90} height={30} footerKeys>
    {(body) => <BrokerOrdersView {...body} focused broker={demo.adapter} instance={demo.instance} accounts={demo.accounts()} accountId={selectedAccount === null ? undefined : selectedAccount ?? demo.draft.accountId}
      onAccountChange={() => {}} onModify={(order) => modifications.push(order)} onBack={() => { returnedToTicket++; }} />}
  </TestPaneFrame>); });
  await tui.waitForFrameToContain(selectedAccount === null ? "Choose an account" : "Working");
  return { demo, modifications, returnedToTicket: () => returnedToTicket, mutations: () => demo.calls.filter((call) => ["placeOrder", "modifyOrder", "cancelOrder"].includes(call.method)) };
}

test("docked rows step a selected order into review and keep cancel confirmation safe across resize", async () => {
  const demo = createDemoBroker();
  const config = createTestPaneConfig("/synthetic/docked-orders", { instanceId: paneId, paneId: "broker-orders", binding: { kind: "none" } });
  config.brokerInstances = [demo.instance];
  const state = createInitialState(config); state.focusedPaneId = paneId;
  const modifications: Array<{ order: BrokerOrder; edit?: { price: number; review: boolean } }> = [];
  let resize!: (compact: boolean) => void;
  function Orders() {
    const [compact, setCompact] = useState(true); resize = setCompact;
    return <BrokerOrdersView compact={compact} focused width={compact ? 34 : 90} height={25} broker={demo.adapter} instance={demo.instance}
      accounts={demo.accounts()} accountId={demo.draft.accountId} onAccountChange={() => {}} onModify={(order, edit) => modifications.push({ order, edit })} />;
  }
  await tui.render(<TestPaneFrame state={state} paneId={paneId} pluginId="broker" runtime={createTestPluginRuntime()} width={90} height={30}>{() => <Orders />}</TestPaneFrame>);
  await tui.waitForFrameToContain("Open Orders (2)");
  await tui.emitKeypress([{ name: "j" }, { name: "up" }, { name: "enter" }], { trackPropagation: true });
  expect(modifications).toHaveLength(1);
  expect(modifications[0]!.order.action).toBe("SELL");
  expect(modifications[0]!.edit).toEqual({ review: true, price: Number((modifications[0]!.order.limitPrice! + 0.01).toFixed(2)) });
  expect(demo.calls.filter((call) => ["placeOrder", "modifyOrder"].includes(call.method))).toEqual([]);
  await tui.emitKeypress({ name: "c" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Cancel SELL");
  await act(async () => resize(false));
  await tui.waitForFrameToContain("Cancel SELL");
  await tui.emitKeypress({ name: "escape" }, { trackPropagation: true });
  expect(demo.calls.filter((call) => call.method === "cancelOrder")).toHaveLength(0);
  await act(async () => resize(true));
  await tui.emitKeypress({ name: "c" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Cancel SELL");
  await tui.emitKeypress([{ name: "enter" }, { name: "enter" }], { trackPropagation: true });
  await tui.waitForFrameToContain("Cancelling");
  expect(demo.calls.filter((call) => call.method === "cancelOrder")).toHaveLength(1);
});

test("the dock reflects a placement immediately and disables other mutations during an entry submission", async () => {
  const demo = createDemoBroker({ seedOrders: false });
  const config = createTestPaneConfig("/synthetic/docked-result", { instanceId: paneId, paneId: "broker-orders", binding: { kind: "none" } });
  config.brokerInstances = [demo.instance];
  const state = createInitialState(config); state.focusedPaneId = paneId;
  const order = demo.order(demo.draft, "WORKING", 42);
  const published: BrokerOrder[][] = [];
  const modifications: BrokerOrder[] = [];
  let update!: (value: boolean) => void;
  function Orders() {
    const [blocked, setBlocked] = useState(true); update = setBlocked;
    return <BrokerOrdersView compact blocked={blocked} latestOrder={order} onOrders={(orders) => published.push(orders)} focused width={34} height={25} broker={demo.adapter} instance={demo.instance}
      accounts={demo.accounts()} accountId={demo.draft.accountId} onAccountChange={() => {}} onModify={(value) => modifications.push(value)} />;
  }
  await tui.render(<TestPaneFrame state={state} paneId={paneId} pluginId="broker" runtime={createTestPluginRuntime()} width={90} height={30}>{() => <Orders />}</TestPaneFrame>);
  await tui.waitForFrameToContain("Open Orders (1)");
  await tui.emitKeypress([{ name: "m" }, { name: "c" }, { name: "enter" }]);
  expect(modifications).toEqual([]);
  expect(demo.calls.filter((call) => call.method === "cancelOrder")).toEqual([]);
  await act(async () => update(false));
  await tui.emitKeypress({ name: "m" });
  expect(modifications).toEqual([order]);
  demo.adapter.listOpenOrders = async () => [{ ...order, status: "CANCELED", updatedAt: order.updatedAt + 1 }];
  await tui.emitKeypress({ name: "r" }, { trackPropagation: true });
  await tui.waitForFrameToContain("No open orders for this ticker.");
  expect(published.at(-1)?.map((value) => value.status)).toEqual(["CANCELED"]);
});

test("docked activity excludes other contracts and distinguishes empty activity from open orders", async () => {
  const demo = createDemoBroker();
  demo.adapter.listExecutions = async () => [{ execId: "synthetic-other", accountId: demo.draft.accountId, side: "BUY", shares: 999, price: 42, time: 1, contract: { ...demo.draft.contract, symbol: "OTHER" } }];
  const config = createTestPaneConfig("/synthetic/docked-activity", { instanceId: paneId, paneId: "broker-orders", binding: { kind: "none" } });
  config.brokerInstances = [demo.instance];
  const state = createInitialState(config); state.focusedPaneId = paneId;
  await tui.render(<TestPaneFrame state={state} paneId={paneId} pluginId="broker" runtime={createTestPluginRuntime()} width={90} height={30} footerKeys>
    {() => <BrokerOrdersView compact contract={demo.draft.contract} focused width={34} height={8} broker={demo.adapter} instance={demo.instance} accounts={demo.accounts()} accountId={demo.draft.accountId} onAccountChange={() => {}} onModify={() => {}} />}
  </TestPaneFrame>);
  await tui.waitForFrameToContain("4/10");
  // One line per order, with edit and cancel as icons, in a short dock.
  expect(tui.frame().split("\n").filter(line => line.includes("✎") && line.includes(" x "))).toHaveLength(2);
  await tui.emitKeypress({ name: "v" });
  await tui.waitForFrameToContain("No recent activity.");
  expect(tui.frame()).not.toContain("999");
  expect(tui.frame()).not.toContain("Enter Review");
  await tui.emitKeypress({ name: "v" });
  await tui.waitForFrameToContain("4/10");
});

test("multiple accounts require an explicit choice before loading or offering a mutation", async () => {
  const f = await mount({ mode: "both" }, null);
  await tui.emitKeypress([{ name: "m", sequence: "m" }, { name: "c", sequence: "c" }], { trackPropagation: true });
  expect(f.demo.calls).toEqual([]);
  expect(f.modifications).toEqual([]);
  expect(tui.frame()).not.toContain("Cancel AAPL order?");
});

test("90x30 orders open modify in review and require one cancel confirmation before mutation", async () => {
  const f = await mount();
  expect(tui.frame()).toContain("SIMULATION");
  await tui.emitKeypress({ name: "m", sequence: "m" }, { trackPropagation: true });
  expect(f.modifications).toHaveLength(1);
  expect(f.mutations()).toEqual([]);
  await tui.emitKeypress({ name: "c", sequence: "c" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Cancel AAPL order?");
  expect(f.mutations()).toEqual([]);
  await tui.emitKeypress({ name: "escape", sequence: "\u001b" }, { trackPropagation: true });
  await tui.waitForFrameToExclude("Cancel AAPL order?");
  expect(f.mutations()).toEqual([]);
  await tui.emitKeypress({ name: "c", sequence: "c" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Cancel AAPL order?");
  await tui.emitKeypress({ name: "enter", sequence: "\r" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Pending cancel");
  expect(f.mutations().map((call) => call.method)).toEqual(["cancelOrder"]);
});

test("trading off hides mutations and an uncertain cancel cannot be repeated without reconciliation", async () => {
  const disabled = await mount({ enabled: false });
  await tui.emitKeypress([{ name: "m", sequence: "m" }, { name: "c", sequence: "c" }], { trackPropagation: true });
  expect(disabled.modifications).toEqual([]);
  expect(disabled.mutations()).toEqual([]);
  expect(tui.frame()).not.toContain("Cancel AAPL order?");
  await tui.destroy();
  const uncertain = await mount({ outcome: "unknown" });
  await tui.emitKeypress({ name: "c", sequence: "c" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Cancel AAPL order?");
  await tui.emitKeypress({ name: "enter", sequence: "\r" }, { trackPropagation: true });
  await tui.waitForFrameToContain("UNKNOWN");
  await tui.emitKeypress([{ name: "c", sequence: "c" }, { name: "enter", sequence: "\r" }], { trackPropagation: true });
  expect(uncertain.mutations().map((call) => call.method)).toEqual(["cancelOrder"]);
});

test("an inline cancel targets its own row and does not activate modify through the table", async () => {
  const f = await mount();
  const lines = tui.frame().split("\n");
  const row = lines.findIndex((line) => line.includes("Partial fill"));
  const column = lines[row]!.indexOf("Cancel");
  expect(column).toBeGreaterThan(0);
  await act(async () => {
    await tui.setup().mockMouse.click(column + 1, row);
    await tui.setup().renderOnce();
  });
  await tui.waitForFrameToContain("SELL 10 AAPL. 6 remaining.");
  expect(f.modifications).toEqual([]);
  expect(f.mutations()).toEqual([]);
  await tui.emitKeypress({ name: "enter", sequence: "\r" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Pending cancel");
  expect(f.mutations().map((call) => call.method)).toEqual(["cancelOrder"]);
});

test("Orders keys navigate rows, switch activity, choose accounts and step back without a mouse", async () => {
  const f = await mount();
  await tui.emitKeypress([{ name: "j", sequence: "j" }, { name: "m", sequence: "m" }], { trackPropagation: true });
  expect(f.modifications[0]?.action).toBe("SELL");
  await tui.emitKeypress({ name: "v", sequence: "v" }, { trackPropagation: true });
  await tui.waitForFrameToContain("FEES");
  await tui.emitKeypress({ name: "a", sequence: "a" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Choose an account");
  await tui.emitKeypress({ name: "escape", sequence: "\u001b" }, { trackPropagation: true });
  expect(f.returnedToTicket()).toBe(0);
  await tui.emitKeypress({ name: "escape", sequence: "\u001b" }, { trackPropagation: true });
  expect(f.returnedToTicket()).toBe(1);
  expect(f.mutations()).toEqual([]);
});

test("a cancel reports broker-confirmed cancellation from explicit status reconciliation", async () => {
  const f = await mount({}, undefined, true);
  await tui.emitKeypress({ name: "c", sequence: "c" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Cancel AAPL order?");
  await tui.emitKeypress({ name: "enter", sequence: "\r" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Cancelled. Broker confirmed.");
  await tui.emitKeypress({ name: "r", sequence: "r" }, { trackPropagation: true });
  expect(f.mutations().map((call) => call.method)).toEqual(["cancelOrder"]);
});

test("a broker-confirmed terminal state suppresses stale open-row mutation controls", async () => {
  const f = await mount({}, undefined, true);
  const staleOrders = await f.demo.adapter.listOpenOrders!(f.demo.instance);
  f.demo.adapter.listOpenOrders = async () => staleOrders;
  await tui.emitKeypress({ name: "c", sequence: "c" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Cancel AAPL order?");
  await tui.emitKeypress({ name: "enter", sequence: "\r" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Cancelled. Broker confirmed.");
  const row = tui.frame().split("\n").find((line) => line.includes("BUY") && line.includes("Cancelled"));
  expect(row).toBeDefined();
  expect(row).not.toContain("Modify");
  expect(row).not.toContain("Cancel ");
  await tui.emitKeypress([{ name: "m", sequence: "m" }, { name: "c", sequence: "c" }], { trackPropagation: true });
  expect(f.modifications).toEqual([]);
  expect(f.mutations().map((call) => call.method)).toEqual(["cancelOrder"]);
});
