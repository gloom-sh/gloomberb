import { expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { BrokerOrder } from "../../../types/trading";
import { BrokerOrdersView } from "./orders";
import { createDemoBroker, type DemoBrokerOptions } from "./test-fixture";

const tui = createOpenTuiTestHarness({ width: 90, height: 30 });
const paneId = "broker-orders:test";

async function mount(options: DemoBrokerOptions = {}, selectedAccount?: string | null) {
  const demo = createDemoBroker(options);
  const config = createTestPaneConfig("/synthetic/orders-render", { instanceId: paneId, paneId: "broker-orders", binding: { kind: "none" }, settings: {} });
  config.brokerInstances = [demo.instance];
  const state = createInitialState(config); state.focusedPaneId = paneId;
  const modifications: BrokerOrder[] = [];
  await act(async () => { await tui.render(<TestPaneFrame state={state} paneId={paneId} pluginId="broker-trading" runtime={createTestPluginRuntime()} width={90} height={30} footerKeys>
    {(body) => <BrokerOrdersView {...body} focused broker={demo.adapter} instance={demo.instance} accounts={demo.accounts()} accountId={selectedAccount === null ? undefined : selectedAccount ?? demo.draft.accountId}
      onAccountChange={() => {}} onModify={(order) => modifications.push(order)} />}
  </TestPaneFrame>); });
  await tui.waitForFrameToContain(selectedAccount === null ? "Choose an account" : "Working");
  return { demo, modifications, mutations: () => demo.calls.filter((call) => ["placeOrder", "modifyOrder", "cancelOrder"].includes(call.method)) };
}

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
