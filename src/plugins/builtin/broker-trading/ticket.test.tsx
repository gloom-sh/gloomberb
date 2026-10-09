import { expect, test } from "bun:test";
import { act, useState, useSyncExternalStore } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { BrokerTradingController } from "./controller";
import { newTicketDraft } from "./pane-model";
import { BrokerTicketView, ticketQuoteAge } from "./ticket";
import { createDemoBroker, type DemoOrderOutcome } from "./test-fixture";

const tui = createOpenTuiTestHarness({ width: 90, height: 30 });
const paneId = "broker-ticket:render-test";
async function mount(mode: "simulation" | "live", typed = "", outcome: DemoOrderOutcome = "working", options: { quantity?: number; limitPrice?: number; tif?: string[] } = {}) {
  const demo = createDemoBroker({ mode, outcome });
  if (options.tif) {
    const capabilities = demo.adapter.getTradingCapabilities!(demo.instance);
    demo.adapter.getTradingCapabilities = () => ({ ...capabilities, tif: options.tif! });
  }
  const controller = new BrokerTradingController({ getContext: () => ({ adapter: demo.adapter, instance: demo.instance, accounts: demo.accounts(), accountId: demo.draft.accountId, connection: demo.adapter.getStatus!(demo.instance) }) });
  controller.setDraft({ ...demo.draft, quantity: options.quantity ?? demo.draft.quantity, limitPrice: options.limitPrice ?? demo.draft.limitPrice });
  await controller.loadQuote();
  await controller.review();
  const config = createTestPaneConfig("/synthetic/ticket-render", { instanceId: paneId, paneId: "broker-ticket", binding: { kind: "none" }, settings: {} });
  config.brokerInstances = [demo.instance];
  const state = createInitialState(config); state.focusedPaneId = paneId;
  function Ticket() {
    const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    const [confirmation, setConfirmation] = useState(typed);
    return <BrokerTicketView width={90} height={29} focused model={{ brokerName: demo.adapter.name, symbol: "AAPL", accounts: demo.accounts(), accountId: demo.draft.accountId, draft: snapshot.draft,
      quote: snapshot.quote?.quote, quoteData: "delayed", phase: snapshot.phase, preview: snapshot.review?.preview, warnings: snapshot.review?.warnings ?? [], result: snapshot.result, error: snapshot.error,
      connected: true, tradingEnabled: true, typedConfirmation: confirmation, capabilities: demo.adapter.getTradingCapabilities!(demo.instance), synthetic: true }}
      onAccountChange={() => {}} onEdit={(key, value) => { if (key === "typedConfirmation") setConfirmation(String(value)); if (key === "tif") controller.setDraft({ ...controller.getSnapshot().draft!, tif: String(value) }); }}
      onAction={(action) => {
        if (action === "confirm") void controller.confirm(confirmation).catch(() => {});
        if (action === "review") void controller.review();
        if (action === "back") controller.setDraft({ ...controller.getSnapshot().draft! });
        if (action === "refresh") void controller.refreshResult();
        if (action === "new") { controller.reset(); controller.setDraft(newTicketDraft(demo.adapter, demo.instance, demo.draft.contract, demo.draft.accountId)); }
      }} />;
  }
  await act(async () => { await tui.render(<TestPaneFrame state={state} paneId={paneId} pluginId="broker" runtime={createTestPluginRuntime()} width={90} height={30}>{() => <Ticket />}</TestPaneFrame>); });
  await tui.waitForFrameToContain("Review Order");
  return { controller, demo, mutations: () => demo.calls.filter((call) => ["placeOrder", "modifyOrder", "cancelOrder"].includes(call.method)) };
}

test("review opens on Edit, so a repeated Enter cannot submit the order", async () => {
  const f = await mount("simulation");
  await tui.emitKeypress({ name: "enter", sequence: "\r" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Limit price");
  expect(f.controller.getSnapshot().phase).toBe("editing");
  expect(f.mutations()).toHaveLength(0);
  f.controller.dispose();
});

test("LIVE confirm stays disabled until the symbol is typed, then submits only once", async () => {
  const untyped = await mount("live");
  await tui.clickFrameText("Place LIVE order");
  expect(untyped.mutations()).toHaveLength(0);
  expect(untyped.controller.getSnapshot().phase).toBe("review");
  untyped.controller.dispose();
  await tui.destroy();
  const typed = await mount("live", "aapl");
  await tui.clickFrameText("Place LIVE order");
  await tui.waitForFrameToContain("Working");
  await tui.emitKeypress({ name: "enter", sequence: "\r" }, { trackPropagation: true });
  expect(typed.mutations().map((call) => call.method)).toEqual(["placeOrder"]);
  typed.controller.dispose();
});

test("unknown result offers reconciliation and cannot offer a fresh submission", async () => {
  const f = await mount("simulation", "", "unknown");
  await tui.clickFrameText("Place simulation order");
  await tui.waitForFrameToContain("Outcome Unknown");
  expect(tui.frame()).not.toContain("New order");
  expect(tui.frame()).not.toContain("Edit order");
  await tui.clickFrameText("Refresh status");
  expect(f.mutations().map((call) => call.method)).toEqual(["placeOrder"]);
  f.controller.dispose();
});

test("rejected result focuses Edit order and preserves the rejected fields", async () => {
  const f = await mount("simulation", "", "rejected", { quantity: 7, limitPrice: 331.25 });
  await tui.clickFrameText("Place simulation order");
  await tui.waitForFrameToContain("Rejected");
  expect(tui.frame()).toContain("Edit order");
  expect(tui.frame()).not.toContain("New order");
  await tui.emitKeypress({ name: "enter", sequence: "\r" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Limit price");
  expect(f.controller.getSnapshot()).toMatchObject({ phase: "editing", draft: { quantity: 7, limitPrice: 331.25, tif: "DAY" } });
  expect(f.mutations().map((call) => call.method)).toEqual(["placeOrder"]);
  f.controller.dispose();
});

test("filled result focuses New order without submitting a second order", async () => {
  const f = await mount("simulation", "", "filled");
  await tui.clickFrameText("Place simulation order");
  await tui.waitForFrameToContain("10 of 10 filled");
  expect(tui.frame()).toContain("Refresh status");
  await tui.emitKeypress({ name: "enter", sequence: "\r" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Limit price");
  expect(f.controller.getSnapshot()).toMatchObject({ phase: "editing", draft: { quantity: 1, tif: "DAY" } });
  expect(f.controller.getSnapshot().review).toBeUndefined();
  expect(f.mutations().map((call) => call.method)).toEqual(["placeOrder"]);
  f.controller.dispose();
});

test("time in force keyboard control exposes all broker choices at 90 by 30", async () => {
  const f = await mount("simulation", "", "working", { tif: ["DAY", "GTC", "IOC", "FOK", "EXTENDED_HOURS", "AT_THE_OPENING", "AT_THE_CLOSE"] });
  await tui.emitKeypress({ name: "escape", sequence: "\u001b" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Time in force");
  await tui.clickFrameText("Time in force");
  await tui.emitKeypress({ name: "enter", sequence: "\r" }, { trackPropagation: true });
  await tui.waitForFrameToContain("At the close");
  for (const label of ["Day", "Good til cancelled", "Immediate or cancel", "Fill or kill", "Extended hours", "At the opening", "At the close"]) expect(tui.frame()).toContain(label);
  await tui.clickFrameText("At the close");
  expect(f.controller.getSnapshot().draft?.tif).toBe("AT_THE_CLOSE");
  expect(f.mutations()).toHaveLength(0);
  f.controller.dispose();
});

test("quote age uses the broker source timestamp even with a fresh receipt", () => {
  const demo = createDemoBroker({ now: () => 1_800_000, quoteAgeMs: 900_000 });
  expect(ticketQuoteAge(demo.quote(), 1_800_000)).toBe("15m old");
});
