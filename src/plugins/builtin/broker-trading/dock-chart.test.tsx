import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { AppContext, appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { flushPendingPersistence } from "../../../state/persist-scheduler";
import { findPaneInstance } from "../../../types/config";
import { setSharedRegistryForTests, type PluginRegistry } from "../../registry";
import { TickerResearchPane } from "../ticker-detail/pane";
import { ChartComposerResearchTab } from "../chart-composer/pane";
import { BrokerTradeTab } from "./pane";
import { createDemoBroker } from "./test-fixture";
import { brokerOrderFeed } from "./order-feed";

const tui = createOpenTuiTestHarness({ width: 140, height: 40 });
const PANE_ID = "ticker-detail:dock-chart-test";
afterEach(async () => {
  setSharedRegistryForTests(undefined);
  brokerOrderFeed.clear();
  brokerOrderFeed.setNotifier(undefined);
  await flushPendingPersistence();
});

const HISTORY = Array.from({ length: 400 }, (_, index) => ({
  date: new Date(Date.now() - (399 - index) * 86_400_000),
  open: 100 + index / 10, high: 101 + index / 10, low: 99 + index / 10, close: 100 + index / 10, volume: 1_000,
}));

/** The real Chart tab beside the docked ticket, over an invented year of bars. */
async function mount(options: { order?: number } = {}) {
  const demo = createDemoBroker({ realtime: true, quoteAgeMs: 0, seedOrders: options.order === undefined });
  // A working buy on the chart's own prices, where its line shows.
  if (options.order !== undefined) await demo.adapter.placeOrder!(demo.instance, { ...demo.draft, limitPrice: options.order });
  const config = createTestPaneConfig("/synthetic/dock-chart-test", {
    instanceId: PANE_ID, paneId: "ticker-detail", binding: { kind: "fixed", symbol: "AAPL" },
  });
  config.brokerInstances = [demo.instance];
  const initial = createInitialState(config);
  initial.focusedPaneId = PANE_ID;
  initial.tickers.set("AAPL", createTestTicker("AAPL", "Synthetic company"));
  initial.paneState[PANE_ID] = { activeTabId: "chart" };
  setSharedRegistryForTests({ tickerResearchTabs: new Map([
    ["chart", { id: "chart", name: "Chart", order: 1, component: ChartComposerResearchTab }],
    ["broker-trade", { id: "broker-trade", name: "Trade", order: 2, component: BrokerTradeTab }],
  ]) } as unknown as PluginRegistry);
  let latest: AppState = initial;
  const listeners = new Set<() => void>();
  const store = {
    getState: () => latest,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispatch: (action: AppAction) => { latest = appReducer(latest, action); for (const listener of listeners) listener(); },
  };
  const provider = createTestDataProvider({
    getTickerFinancials: async () => ({ annualStatements: [], quarterlyStatements: [], priceHistory: [] }),
    getPriceHistoryForResolution: async () => HISTORY,
  });
  const runtime = createTestPluginRuntime({ getMarketData: () => provider, getBrokerAdapter: () => demo.adapter });
  let setFocused!: (value: boolean) => void;
  function Pane({ height }: { height: number }) {
    const [focused, set] = useState(true);
    setFocused = set;
    return <AppContext value={store}><TickerResearchPane paneId={PANE_ID} paneType="ticker-detail" focused={focused} width={140} height={height} /></AppContext>;
  }
  await tui.render(
    <TestPaneFrame state={initial} paneId={PANE_ID} pluginId="broker" runtime={runtime} width={140} height={40} footerKeys>
      {({ height }) => <Pane height={height} />}
    </TestPaneFrame>,
  );
  return {
    demo, focus: (value: boolean) => act(async () => setFocused(value)), drawings: () => ((findPaneInstance(latest.config.layout, PANE_ID)?.settings as { chartDrawings?: unknown[] } | undefined)?.chartDrawings ?? []).length,
    mutations: () => demo.calls.filter((call) => ["placeOrder", "modifyOrder", "cancelOrder"].includes(call.method)),
  };
}

async function settle(until: () => boolean = () => false, ms = 3_000) {
  const deadline = Date.now() + ms;
  do {
    await act(async () => { await Bun.sleep(30); await tui.setup().renderOnce(); });
    if (until()) return;
  } while (Date.now() < deadline);
}

const quantity = () => tui.frame().split("\n").find((text) => text.includes("Quantity"))?.split("│").pop()?.trim() ?? "";

test("a press on the chart takes the keyboard back from a ticket field, so Backspace removes the drawing instead of editing the quantity", async () => {
  const chart = await mount();
  await settle(() => tui.frame().includes("Volume"));
  const mouse = tui.setup().mockMouse;
  // Shift+D puts the trend line in hand, which stays in hand once the line is drawn.
  await tui.emitKeypress({ name: "d", shift: true, sequence: "D" });
  await act(async () => mouse.drag(30, 14, 60, 8));
  await act(async () => mouse.drag(20, 17, 50, 19));
  await settle(() => chart.drawings() === 2);
  expect(chart.drawings()).toBe(2);

  await tui.emitKeypress({ name: "t" });
  await tui.waitForFrameToContain("Buy 1 AAPL");
  // Side, then order type, then Quantity: the field is typing.
  for (let index = 0; index < 3; index++) await tui.emitKeypress({ name: "tab" });
  await tui.waitForFrameToContain("> Quantity");

  // A press on the line picks it and gives the chart the keys back.
  await act(async () => mouse.click(45, 11));
  await tui.emitKeypress({ name: "backspace" });
  await settle(() => chart.drawings() === 1);
  expect(chart.drawings()).toBe(1);
  expect(quantity()).toContain("1");
});

/** The screen row of a level's label, and the column where it starts. */
const levelRow = (label: string) => {
  const row = tui.frame().split("\n").findIndex((text) => text.includes(label));
  return { row, column: tui.frame().split("\n")[row]?.indexOf(label) ?? -1 };
};
/** A ticket field's number, as the field shows it. */
const fieldValue = (label: string) => tui.frame().match(new RegExp(`${label} +([0-9.]+)`))?.[1] ?? "";

test("a working order's line drags on the chart into a change the ticket reviews, and only confirm reaches the broker", async () => {
  const chart = await mount({ order: 120 });
  await settle(() => tui.frame().includes("Volume"));
  await tui.emitKeypress({ name: "t" });
  await settle(() => tui.frame().includes("Buy 10 working"));
  const placed = chart.mutations().length;
  const from = levelRow("Buy 10 working");
  expect(from.row).toBeGreaterThan(0);
  // The line moves with a plain drag, no tool in hand; the ticket opens its change at the new price.
  const mouse = tui.setup().mockMouse;
  await act(async () => mouse.drag(from.column - 20, from.row, from.column - 20, from.row - 4));
  await settle(() => tui.frame().includes("Buy 10 change"));
  const changed = Number(fieldValue("Limit"));
  expect(changed).toBeGreaterThan(120);
  expect(chart.mutations()).toHaveLength(placed);
  // The chart keeps the keys, so a keyboard nudge can follow; in the ticket, Review is the next step.
  await tui.emitKeypress({ name: "f6" });
  await tui.emitKeypress({ name: "return" });
  await tui.waitForFrameToContain("Limit $120.00 →");
  expect(chart.mutations()).toHaveLength(placed);
  await tui.emitKeypress({ name: "tab" });
  await tui.emitKeypress({ name: "return" });
  await settle(() => chart.mutations().length > placed);
  const modify = chart.mutations().at(-1)!;
  expect(modify.method).toBe("modifyOrder");
  expect(modify.request).toMatchObject({ orderType: "LMT", limitPrice: changed, quantity: 10 });
});

test("c picks the ticket's price on the chart: Enter takes the cursor's price, a press the one under it, Esc keeps it", async () => {
  await mount({ order: 120 });
  await settle(() => tui.frame().includes("Volume"));
  await tui.emitKeypress({ name: "t" });
  await tui.waitForFrameToContain("Buy 1 AAPL");
  const limit = () => fieldValue("Limit");
  const before = limit();
  await tui.emitKeypress({ name: "c" });
  await tui.waitForFrameToContain("set limit");
  await tui.emitKeypress({ name: "escape" });
  await settle(() => !tui.frame().includes("set limit"));
  expect(limit()).toBe(before);
  // The close at the chart's cursor, on the ticket's step, and the ticket has the keys again.
  await tui.emitKeypress({ name: "c" });
  await tui.waitForFrameToContain("set limit");
  await tui.emitKeypress({ name: "return" });
  await settle(() => limit() !== before);
  const picked = limit();
  expect(Number(picked)).toBeGreaterThan(130);
  expect(Number(picked)).toBeLessThanOrEqual(140);
  expect(picked).toMatch(/^\d+(\.\d{1,2})?$/);
  expect(tui.frame()).toContain("Draft limit");
  // A press on the plot sets the price under it.
  await tui.emitKeypress({ name: "c" });
  await tui.waitForFrameToContain("set limit");
  const line = levelRow("Buy 10 working");
  await act(async () => tui.setup().mockMouse.click(line.column - 20, line.row));
  await settle(() => limit() !== picked);
  expect(Math.abs(Number(limit()) - 120)).toBeLessThan(2);
  expect(tui.frame()).not.toContain("set limit");
});

test("with the level tool, ] picks an order's line and each arrow moves its change on, which Backspace never cancels", async () => {
  const chart = await mount({ order: 120 });
  await settle(() => tui.frame().includes("Volume"));
  await tui.emitKeypress({ name: "t" });
  await settle(() => tui.frame().includes("Buy 10 working"));
  const placed = chart.mutations().length;
  // F6 gives the chart the keys; Shift+H puts the level tool in hand.
  await tui.emitKeypress({ name: "f6" });
  await tui.emitKeypress({ name: "h", shift: true, sequence: "H" });
  // Top down: the draft's limit at the ask, the average cost, then the order.
  for (let index = 0; index < 3; index++) await tui.emitKeypress({ name: "]" });
  await tui.emitKeypress({ name: "up" });
  await settle(() => tui.frame().includes("Buy 10 change"));
  const first = Number(fieldValue("Limit"));
  // A nudge moves the change on without asking for the quote again.
  const quotes = () => chart.demo.calls.filter((call) => call.method === "getQuote").length;
  await settle(() => false, 200);
  const asked = quotes();
  await tui.emitKeypress({ name: "up" });
  await settle(() => Number(fieldValue("Limit")) > first);
  expect(quotes()).toBe(asked);
  expect(Number(fieldValue("Limit"))).toBeGreaterThan(first);
  expect(first).toBeGreaterThan(120);
  await tui.emitKeypress({ name: "backspace" });
  await settle(() => false, 200);
  expect(tui.frame()).toContain("Buy 10 change");
  expect(chart.mutations()).toHaveLength(placed);
});

/** The screen spot of some text, for a click on it. */
const spot = (text: string) => levelRow(text);

test("a draft line drags into the draft, and a working order's line asks before it replaces the order being written", async () => {
  const chart = await mount({ order: 120 });
  await settle(() => tui.frame().includes("Volume"));
  await tui.emitKeypress({ name: "t" });
  await settle(() => tui.frame().includes("Buy 10 working"));
  const placed = chart.mutations().length;
  // The limit from the chart, so the draft's line is on it; then the line drags, and only the draft follows.
  await tui.emitKeypress({ name: "c" });
  await tui.waitForFrameToContain("set limit");
  await tui.emitKeypress({ name: "return" });
  await settle(() => tui.frame().includes("Draft limit"));
  const picked = Number(fieldValue("Limit"));
  const draftLine = levelRow("Draft limit");
  await act(async () => tui.setup().mockMouse.drag(draftLine.column - 20, draftLine.row, draftLine.column - 20, draftLine.row + 3));
  await settle(() => Number(fieldValue("Limit")) < picked);
  const dragged = Number(fieldValue("Limit"));
  expect(dragged).toBeLessThan(picked);
  expect(tui.frame()).toContain("Buy 1 AAPL");
  expect(chart.mutations()).toHaveLength(placed);

  // That order is still being written: dragging the working order's line asks before replacing it.
  const drag = async () => {
    const line = levelRow("Buy 10 working");
    await act(async () => tui.setup().mockMouse.drag(line.column - 20, line.row, line.column - 20, line.row - 3));
    await tui.waitForFrameToContain("Replace the ticket's order?");
  };
  await drag();
  await tui.emitKeypress({ name: "escape" });
  await settle(() => !tui.frame().includes("Replace the ticket's order?"));
  expect(tui.frame()).not.toContain("Buy 10 change");
  expect(Number(fieldValue("Limit"))).toBe(dragged);
  await drag();
  await tui.emitKeypress({ name: "return" });
  await settle(() => tui.frame().includes("Buy 10 change"));
  expect(tui.frame()).toContain("Modify Order");
  expect(chart.mutations()).toHaveLength(placed);
  // Review is the next step; back from it, the change's price has the focus.
  await tui.emitKeypress({ name: "f6" });
  await tui.emitKeypress({ name: "return" });
  await tui.waitForFrameToContain("Review Replacement");
  await tui.emitKeypress({ name: "e" });
  await settle(() => tui.frame().includes("> Limit"));
  expect(tui.frame()).toContain("> Limit");
});

test("c in a take profit or stop loss field picks that price on the chart", async () => {
  await mount();
  await settle(() => tui.frame().includes("Volume"));
  await tui.emitKeypress({ name: "t" });
  await tui.waitForFrameToContain("Buy 1 AAPL");
  const box = spot("Take profit / stop loss");
  await act(async () => tui.setup().mockMouse.click(box.column, box.row));
  await settle(() => tui.frame().includes(" TP "));
  await tui.emitKeypress({ name: "tab" });
  await tui.emitKeypress({ name: "c" });
  await tui.waitForFrameToContain("set take profit");
  await tui.emitKeypress({ name: "return" });
  await settle(() => fieldValue("TP") !== "");
  // The close at the chart's cursor, the last bar's.
  expect(Number(fieldValue("TP"))).toBeGreaterThan(130);
  expect(fieldValue("SL")).toBe("");
  expect(tui.frame()).toContain("Draft take profit");
  const loss = spot(" SL ");
  await act(async () => tui.setup().mockMouse.click(loss.column + 1, loss.row));
  await tui.emitKeypress({ name: "c" });
  await tui.waitForFrameToContain("set stop loss");
  await tui.emitKeypress({ name: "escape" });
  await settle(() => !tui.frame().includes("set stop loss"));
  expect(fieldValue("SL")).toBe("");
});

test("after a confirmed change the broker lists late under a new ID, a drag starts from the change's own terms", async () => {
  const chart = await mount({ order: 120 });
  await settle(() => tui.frame().includes("Volume"));
  await tui.emitKeypress({ name: "t" });
  await settle(() => tui.frame().includes("Buy 10 working"));
  // The broker's list stays as it was, and the changed order comes back under a new ID.
  const listed = await chart.demo.adapter.listOpenOrders!(chart.demo.instance);
  chart.demo.adapter.listOpenOrders = async () => structuredClone(listed);
  const modify = chart.demo.adapter.modifyOrder!.bind(chart.demo.adapter);
  chart.demo.adapter.modifyOrder = async (...args) => ({ ...await modify(...args), brokerOrderId: "demo-order-replaced" });
  const change = async (rows: number) => {
    const line = levelRow("Buy 10 working");
    await act(async () => tui.setup().mockMouse.drag(line.column - 20, line.row, line.column - 20, line.row - rows));
    await settle(() => tui.frame().includes("Buy 10 change"));
    const price = Number(fieldValue("Limit"));
    await tui.emitKeypress({ name: "f6" });
    await tui.emitKeypress({ name: "return" });
    await tui.waitForFrameToContain("Review Replacement");
    return price;
  };
  const first = await change(4);
  await tui.emitKeypress({ name: "tab" });
  await tui.emitKeypress({ name: "return" });
  // The working line is at the changed price.
  const workingRow = () => tui.frame().split("\n")[levelRow("Buy 10 working").row] ?? "";
  await settle(() => workingRow().includes(first.toFixed(2)));
  expect(workingRow()).toContain(first.toFixed(2));
  await change(2);
  expect(tui.frame()).toContain(`Limit $${first.toFixed(2)} →`);
}, 15_000);

test("a price pick ends when the pane loses focus, so a later press on the chart sets nothing", async () => {
  const chart = await mount({ order: 120 });
  await settle(() => tui.frame().includes("Volume"));
  await tui.emitKeypress({ name: "t" });
  await tui.waitForFrameToContain("Buy 1 AAPL");
  const before = fieldValue("Limit");
  await tui.emitKeypress({ name: "c" });
  await tui.waitForFrameToContain("set limit");
  await chart.focus(false);
  await settle(() => false, 200);
  await chart.focus(true);
  await settle(() => false, 200);
  expect(tui.frame()).not.toContain("set limit");
  const line = levelRow("Buy 10 working");
  await act(async () => tui.setup().mockMouse.click(line.column - 40, line.row + 2));
  await settle(() => false, 300);
  expect(fieldValue("Limit")).toBe(before);
});
