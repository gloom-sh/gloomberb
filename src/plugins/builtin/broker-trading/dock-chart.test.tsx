import { afterEach, expect, test } from "bun:test";
import { act } from "react";
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
async function mount() {
  const demo = createDemoBroker({ realtime: true, quoteAgeMs: 0 });
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
  await tui.render(
    <TestPaneFrame state={initial} paneId={PANE_ID} pluginId="broker" runtime={runtime} width={140} height={40} footerKeys>
      {({ height }) => <AppContext value={store}><TickerResearchPane paneId={PANE_ID} paneType="ticker-detail" focused width={140} height={height} /></AppContext>}
    </TestPaneFrame>,
  );
  return { drawings: () => ((findPaneInstance(latest.config.layout, PANE_ID)?.settings as { chartDrawings?: unknown[] } | undefined)?.chartDrawings ?? []).length };
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
