import { expect, test } from "bun:test";
import { act, useState, useSyncExternalStore } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { BrokerTradingController } from "./controller";
import { editTicketDraft, newTicketDraft, quickTicketQuantity } from "./pane-model";
import { BrokerTicketView, ticketEditingPriceStep, ticketQuoteAge, type TicketAction } from "./ticket";
import { TicketOrderSummary } from "./ticket-parts";
import { createDemoBroker, type DemoOrderOutcome } from "./test-fixture";

const tui = createOpenTuiTestHarness({ width: 90, height: 30 });
const paneId = "broker-ticket:render-test";
async function mount(mode: "simulation" | "live", typed = "", outcome: DemoOrderOutcome = "working", options: { quantity?: number; limitPrice?: number; tif?: string[]; editing?: boolean; initialFocus?: string; enabled?: boolean; fresh?: boolean } = {}) {
  const demo = createDemoBroker({ mode, outcome, realtime: options.fresh, quoteAgeMs: options.fresh ? 0 : undefined });
  const actions: TicketAction[] = [];
  if (options.tif) {
    const capabilities = demo.adapter.getTradingCapabilities!(demo.instance);
    demo.adapter.getTradingCapabilities = () => ({ ...capabilities, tif: options.tif! });
  }
  const controller = new BrokerTradingController({ getContext: () => ({ adapter: demo.adapter, instance: demo.instance, accounts: demo.accounts(), accountId: demo.draft.accountId, availablePosition: 25, connection: demo.adapter.getStatus!(demo.instance) }) });
  controller.setDraft({ ...demo.draft, quantity: options.quantity ?? demo.draft.quantity, limitPrice: options.limitPrice ?? demo.draft.limitPrice });
  await controller.loadQuote();
  if (!options.editing) await controller.review();
  if (options.enabled === false) demo.instance.config.tradingEnabled = false;
  const config = createTestPaneConfig("/synthetic/ticket-render", { instanceId: paneId, paneId: "broker-ticket", binding: { kind: "none" }, settings: {} });
  config.brokerInstances = [demo.instance];
  const state = createInitialState(config); state.focusedPaneId = paneId;
  function Ticket() {
    const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    const [confirmation, setConfirmation] = useState(typed);
    return <BrokerTicketView width={90} height={29} focused model={{ brokerName: demo.adapter.name, symbol: "AAPL", accounts: demo.accounts(), accountId: demo.draft.accountId, draft: snapshot.draft,
      quote: snapshot.quote?.quote, quoteData: options.fresh ? "realtime" : "delayed", confirmOrders: snapshot.confirmOrders, phase: snapshot.phase, preview: snapshot.review?.preview ?? snapshot.receipt?.preview, warnings: snapshot.review?.warnings ?? [], result: snapshot.result, resultQuantities: snapshot.resultQuantities, error: snapshot.error,
      connected: true, tradingEnabled: options.enabled !== false, typedConfirmation: confirmation, capabilities: demo.adapter.getTradingCapabilities!(demo.instance), synthetic: true, position: 25, initialFocus: options.initialFocus }}
      onAccountChange={() => {}} onEdit={(key, value) => { if (key === "typedConfirmation") setConfirmation(String(value)); else if (key === "confirmOrders") controller.setConfirmOrders(value === true); else controller.setDraft(editTicketDraft(demo.adapter, demo.instance, controller.getSnapshot().draft!, key, value)); }}
      onAction={(action) => {
        actions.push(action);
        if (action === "confirm") void controller.confirm(confirmation).catch(() => {});
        if (action === "review") void controller.review();
        if (action === "submit") void controller.submitFromEntry().catch(() => {});
        if (action === "back") controller.setDraft({ ...controller.getSnapshot().draft! });
        if (action === "refresh") void controller.refreshResult();
        if (action === "new") { controller.reset(); controller.setDraft(newTicketDraft(demo.adapter, demo.instance, demo.draft.contract, demo.draft.accountId)); }
        if (["quantity25", "quantity50", "all"].includes(action)) controller.setDraft({ ...controller.getSnapshot().draft!, quantity: quickTicketQuantity(controller.getSnapshot().draft!, demo.adapter.getTradingCapabilities!(demo.instance), controller.getSnapshot().quote?.quote, demo.accounts()[0], 25, action === "quantity25" ? 0.25 : action === "quantity50" ? 0.5 : 1) });
        if (["priceBid", "priceMid", "priceAsk", "priceLast"].includes(action)) controller.applyPriceDefault(({ priceBid: "bid", priceMid: "mid", priceAsk: "ask", priceLast: "last" } as const)[action as "priceBid" | "priceMid" | "priceAsk" | "priceLast"]);
      }} />;
  }
  await act(async () => { await tui.render(<TestPaneFrame state={state} paneId={paneId} pluginId="broker" runtime={createTestPluginRuntime()} width={90} height={30} footerKeys>{() => <Ticket />}</TestPaneFrame>); });
  await tui.waitForFrameToContain(options.editing ? "Order Details" : "Review Order");
  return { controller, demo, actions, mutations: () => demo.calls.filter((call) => ["placeOrder", "modifyOrder", "cancelOrder"].includes(call.method)) };
}

test("unreported buying power after is never invented by subtracting an order estimate", async () => {
  const demo = createDemoBroker();
  const model = { brokerName: demo.adapter.name, symbol: "AAPL", accounts: demo.accounts(), accountId: demo.draft.accountId, draft: demo.draft,
    phase: "editing" as const, warnings: [], tradingEnabled: true, connected: true };
  await tui.render(<TicketOrderSummary model={model} width={80} />);
  await tui.waitForFrameToContain("Broker power after");
  expect(tui.frame()).not.toContain("$21,235.00");
  expect(tui.frame().split("\n").find((line) => line.includes("Broker power after"))).toContain("Not reported");
});

test("entry and working keep a short footer without dropping the review shortcut", async () => {
  const f = await mount("simulation", "", "working", { editing: true, fresh: true, initialFocus: "review" });
  const footer = () => tui.frame().split("\n").find((line) => line.includes("[o]rders")) ?? "";
  expect(footer()).toContain("[r]eview");
  expect(footer()).toContain("[o]rders");
  expect(footer().match(/\[[^\]]+\]/g)).toHaveLength(2);
  await tui.emitKeypress({ name: "r" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Review Order");
  await tui.emitKeypress({ name: "tab" });
  await tui.emitKeypress({ name: "enter" });
  await tui.waitForFrameToContain("Working");
  expect(footer()).toContain("[r]efresh");
  expect(footer()).toContain("[o]rders");
  expect(footer()).toContain("[n]ew");
  expect(footer().match(/\[[^\]]+\]/g)).toHaveLength(3);
  expect(f.mutations()).toHaveLength(1);
  f.controller.dispose();
});

test("result retains broker preview values without pre-submit placeholders", async () => {
  const f = await mount("simulation", "", "working", { fresh: true });
  await tui.emitKeypress({ name: "tab" });
  await tui.emitKeypress({ name: "enter" });
  await tui.waitForFrameToContain("Working");
  expect(tui.frame()).toContain("$3,365.00");
  expect(tui.frame()).toContain("$0.35");
  expect(tui.frame()).toContain("$21,234.65");
  expect(tui.frame()).toContain("Estimates from order preview");
  expect(tui.frame()).not.toContain("At review");
  expect(tui.frame()).not.toContain("checked at review");
  expect(f.mutations()).toHaveLength(1);
});

test.each(["unconfirmed", "last-known", "confirmed"] as const)("UNKNOWN quantities reflect %s provenance rather than fabricated zeroes", async (provenance) => {
  const demo = createDemoBroker();
  await tui.render(<BrokerTicketView width={90} height={30} focused model={{
    brokerName: "Synthetic", symbol: "AAPL", accounts: demo.accounts(), accountId: demo.draft.accountId, draft: demo.draft,
    phase: "result", result: { ...demo.order(demo.draft), status: "UNKNOWN", filled: 4, remaining: 6 }, resultQuantities: provenance,
    warnings: [], connected: true, tradingEnabled: true,
  }} onEdit={() => {}} onAction={() => {}} onAccountChange={() => {}} />);
  await tui.waitForFrameToContain("Outcome unconfirmed");
  const frame = tui.frame();
  expect(frame.split("\n").find(line => line.trim().startsWith("Filled"))).toContain(provenance === "unconfirmed" ? "Not confirmed" : "4");
  expect(frame.split("\n").find(line => line.trim().startsWith("Remaining"))).toContain(provenance === "unconfirmed" ? "Not confirmed" : "6");
  expect(frame.includes("Last known quantities")).toBe(provenance === "last-known");
  expect(frame).not.toContain("New order");
});

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
  await tui.waitForFrameToContain("TIF");
  await tui.clickFrameText("TIF");
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

const press = (name: string, sequence = name, shift = false) => tui.emitKeypress({ name, sequence, shift }, { trackPropagation: true });

test("direct keys set side, supported order types and broker presets before one deliberate confirmation", async () => {
  const f = await mount("simulation", "", "working", { editing: true });
  await press("s");
  expect(f.controller.getSnapshot().draft?.action).toBe("SELL");
  await press("b");
  expect(f.controller.getSnapshot().draft?.action).toBe("BUY");
  for (const [key, type] of [["1", "MKT"], ["3", "STP"], ["4", "STP LMT"], ["2", "LMT"]] as const) {
    await press(key);
    expect(f.controller.getSnapshot().draft?.orderType).toBe(type);
  }
  await press("r");
  expect(f.controller.getSnapshot().phase).toBe("editing");
  expect(f.demo.calls.filter((call) => call.method === "previewOrder")).toHaveLength(0);
  for (const [key, price] of [["8", 336.4], ["9", 336.45], ["0", 336.5], ["p", 336.42]] as const) {
    await press(key);
    expect(f.controller.getSnapshot().draft?.limitPrice).toBe(price);
  }
  for (const [key, amount] of [["5", 18.276], ["6", 36.552], ["7", 73.105]] as const) {
    await press(key);
    expect(f.controller.getSnapshot().draft?.quantity).toBe(amount);
  }
  await press("r");
  await tui.waitForFrameToContain("Review Order");
  expect(f.demo.calls.filter((call) => call.method === "previewOrder")).toHaveLength(1);
  expect(f.mutations()).toHaveLength(0);
  expect(tui.frame()).toContain("> Edit order");
  await press("tab", "\t");
  await press("enter", "\r");
  await tui.waitForFrameToContain("Working");
  expect(f.mutations().map((call) => call.method)).toEqual(["placeOrder"]);
  await press("o");
  expect(f.actions.at(-1)).toBe("orders");
  f.controller.dispose();
});

test("quantity input keeps shortcut letters and numbers, Escape returns to non-text controls", async () => {
  const f = await mount("simulation", "", "working", { editing: true });
  await tui.clickFrameText("Quantity");
  for (const key of ["b", "s", "r", "o", "n", "5"]) await press(key);
  expect(f.controller.getSnapshot()).toMatchObject({ phase: "editing", draft: { action: "BUY", orderType: "LMT" } });
  expect(f.actions).toEqual([]);
  expect(f.controller.getSnapshot().draft?.quantity).toBe(105);
  await press("escape", "\u001b");
  await press("s");
  expect(f.controller.getSnapshot().draft?.action).toBe("SELL");
  expect(f.mutations()).toHaveLength(0);
  f.controller.dispose();
});

test("LIVE symbol typing is not interpreted as shortcuts and needs a separate focused Enter", async () => {
  const f = await mount("live");
  await press("tab", "\t");
  for (const key of ["a", "a", "p", "l"]) await press(key);
  expect(f.actions).toEqual([]);
  await press("enter", "\r");
  expect(f.mutations()).toHaveLength(0);
  await press("enter", "\r");
  await tui.waitForFrameToContain("Working");
  expect(f.mutations().map((call) => call.method)).toEqual(["placeOrder"]);
  f.controller.dispose();
});

test("Tab leaves both ends of the ticket and a command can start on Review without submitting", async () => {
  const f = await mount("simulation", "", "working", { editing: true, initialFocus: "review" });
  expect(tui.frame()).toContain("> Buy 10 AAPL");
  const end = await press("tab", "\t") as { propagationStopped: boolean };
  expect(end.propagationStopped).toBe(false);
  await press("a");
  await press("escape", "\u001b");
  const start = await press("tab", "\t", true) as { propagationStopped: boolean };
  expect(start.propagationStopped).toBe(false);
  expect(f.mutations()).toHaveLength(0);
  f.controller.dispose();
});

test("direct review key stays blocked when trading is disabled, and a held e cannot pass the consent to enable it", async () => {
  const f = await mount("simulation", "", "working", { editing: true, enabled: false });
  await press("r");
  expect(f.demo.calls.filter((call) => call.method === "previewOrder")).toHaveLength(0);
  await press("e");
  await tui.emitKeypress({ name: "e", sequence: "e", repeated: true }, { trackPropagation: true });
  expect(f.actions).toEqual(["enable"]);
  expect(f.mutations()).toHaveLength(0);
  f.controller.dispose();
});

test("one entry click confirms by default; SIM opt-in uses a fresh preview with no separate confirm click", async () => {
  const f = await mount("simulation", "", "working", { editing: true, fresh: true });
  await tui.clickFrameText("Buy 10 AAPL");
  await tui.waitForFrameToContain("Review Order");
  expect(f.mutations()).toHaveLength(0);
  await press("escape", "\u001b");
  await tui.waitForFrameToContain("Confirm orders");
  await tui.clickFrameText("Confirm orders");
  expect(f.controller.getSnapshot().confirmOrders).toBe(false);
  await tui.clickFrameText("Sell");
  await press("b");
  expect(f.mutations()).toHaveLength(0);
  await tui.clickFrameText("Buy 10 AAPL");
  await tui.waitForFrameToContain("Working");
  expect(f.mutations()).toHaveLength(1);
  expect(f.demo.calls.filter((call) => call.method === "previewOrder")).toHaveLength(2);
  f.controller.dispose();
});

test("numeric Up/Down and pointer wheel change only the targeted field and do not submit", async () => {
  const f = await mount("simulation", "", "working", { editing: true });
  await tui.clickFrameText("Limit price");
  await press("up", "\u001b[A");
  expect(f.controller.getSnapshot().draft?.limitPrice).toBe(336.51);
  await press("down", "\u001b[B");
  expect(f.controller.getSnapshot().draft?.limitPrice).toBe(336.5);
  const rows = tui.frame().split("\n"), y = rows.findIndex((row) => row.includes("Limit price"));
  const x = rows[y]!.indexOf("336.5") + 1;
  await act(async () => { await tui.setup().mockMouse.scroll(x, y, "up"); await tui.setup().renderOnce(); });
  expect(f.controller.getSnapshot().draft).toMatchObject({ quantity: 10, limitPrice: 336.51 });
  await press("enter", "\r");
  expect(f.mutations()).toHaveLength(0);
  expect(f.demo.calls.filter((call) => call.method === "previewOrder")).toHaveLength(0);
  await tui.emitKeypress({ name: "enter", sequence: "\r", repeated: true }, { trackPropagation: true });
  expect(f.demo.calls.filter((call) => call.method === "previewOrder")).toHaveLength(0);
  f.controller.dispose();
});

test("keyboard decimal and empty numeric edits preserve raw text until the field is left", async () => {
  const f = await mount("simulation", "", "working", { editing: true });
  await tui.clickFrameText("Limit price");
  await press("home", "\u001b[H");
  for (let count = 0; count < 6; count++) await press("delete", "\u001b[3~");
  expect(f.controller.getSnapshot().draft?.limitPrice).toBeUndefined();
  for (const digit of ["1", "9", "8", "."]) await press(digit);
  expect(tui.frame()).toContain("198.");
  for (const digit of ["3", "7"]) await press(digit);
  expect(f.controller.getSnapshot().draft?.limitPrice).toBe(198.37);
  await press("tab", "\t");
  expect(tui.frame()).toContain("198.37");
  await act(async () => { f.controller.setDraft({ ...f.controller.getSnapshot().draft!, limitPrice: 169.25 }); });
  await tui.waitForFrameToContain("169.25");
  expect(f.controller.getSnapshot().draft?.limitPrice).toBe(169.25);
  expect(f.mutations()).toHaveLength(0);
  f.controller.dispose();
});

test("a broker's accepted decimals are not its tick: a $343 limit steps by a cent", () => {
  // Aries accepts five decimals and declares no tick; stepping by 0.00001 looked like the wheel did nothing.
  expect(ticketEditingPriceStep(343.59, 5)).toBe(0.01);
  expect(ticketEditingPriceStep(0.42, 5)).toBe(0.0001);
  expect(ticketEditingPriceStep(343.59, 0)).toBe(1);
  expect(ticketEditingPriceStep(undefined, undefined)).toBe(0.01);
});
