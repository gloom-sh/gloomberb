import { afterEach, describe, expect, test } from "bun:test";
import { act, useReducer } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppState } from "../../../state/app/context";
import type { AppConfig } from "../../../types/config";
import type { PluginRuntimeAccess } from "../../runtime";
import { createConfigBackedTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { deserializeAlerts, serializeAlerts } from "./alert-engine";
import { EVENT_ALERTS_KEY, type EventAlertRule } from "./events";
import { createResearchAlert } from "./research-builder";
import { alertsPlugin } from "./index";
import { AlertsPane } from "./pane";
import type { AlertCondition, AlertRule, AlertStatus } from "./types";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { createManualFrameDriver, DataFrameScheduler } from "../../../market-data/frame-scheduler";
import { createTestDataProvider } from "../../../test-support/data-provider";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import type { Quote } from "../../../types/financials";

const TEST_PANE_ID = "alerts:test";

const tui = createOpenTuiTestHarness();
let harnessState: AppState | null = null;
let harnessDispatch: ((action: any) => void) | null = null;

function makeAlert(
  id: string,
  symbol: string,
  condition: AlertCondition,
  targetPrice: number,
  status: AlertStatus = "active",
): AlertRule {
  return {
    id,
    symbol,
    condition,
    targetPrice,
    createdAt: 1_700_000_000_000,
    status,
    triggeredAt: status === "triggered" ? Date.now() - 30_000 : undefined,
    lastCheckedPrice: status === "triggered" ? targetPrice + 1 : undefined,
    lastCheckedAt: status === "triggered" ? Date.now() - 30_000 : undefined,
    lastQuoteUpdatedAt: status === "triggered" ? Date.now() - 30_000 : undefined,
  };
}

function createAlertsConfig(alerts: AlertRule[], eventRules: EventAlertRule[] = []): AppConfig {
  const baseConfig = createTestPaneConfig("/tmp/gloomberb-alerts", {
    instanceId: TEST_PANE_ID,
    paneId: "alerts",
    binding: { kind: "none" },
  });

  return {
    ...baseConfig,
    pluginConfig: {
      ...baseConfig.pluginConfig,
      alerts: {
        alerts: serializeAlerts(alerts),
        ...(eventRules.length ? { [EVENT_ALERTS_KEY]: JSON.stringify(eventRules) } : {}),
      },
    },
  };
}

function makeRuntime(overrides: Partial<PluginRuntimeAccess> = {}): PluginRuntimeAccess {
  return createConfigBackedTestPluginRuntime({
    getConfig: () => harnessState?.config,
    setConfig: (config) => harnessDispatch?.({ type: "SET_CONFIG", config }),
  }, overrides);
}

function AlertsHarness({
  alerts,
  eventRules,
  width = 110,
  height = 12,
  runtime = makeRuntime(),
}: {
  alerts: AlertRule[];
  eventRules?: EventAlertRule[];
  width?: number;
  height?: number;
  runtime?: PluginRuntimeAccess;
}) {
  const initialState = createInitialState(createAlertsConfig(alerts, eventRules));
  initialState.focusedPaneId = TEST_PANE_ID;
  const [state, dispatch] = useReducer(appReducer, initialState);
  harnessState = state;
  harnessDispatch = dispatch;

  return (
    <TestPaneFrame state={state} dispatch={dispatch} paneId={TEST_PANE_ID} pluginId="alerts" runtime={runtime} width={width} height={height} footerKeys>
      {(body) => <AlertsPane paneId={TEST_PANE_ID} paneType="alerts" focused {...body} />}
    </TestPaneFrame>
  );
}

const renderSettled = () => tui.renderFrames(2);
const { clickFrameText } = tui;

function storedAlerts(): AlertRule[] {
  const value = (harnessState?.config.pluginConfig.alerts as any)?.alerts;
  expect(typeof value).toBe("string");
  return JSON.parse(value);
}

afterEach(() => {
  harnessState = null;
  harnessDispatch = null;
});

describe("AlertsPane", () => {
  test("keeps alert targets visible at the default floating pane width", async () => {
    await tui.render(
      <AlertsHarness
        width={82}
        height={8}
        alerts={[makeAlert("alert-aapl", "AAPL", "above", 200)]}
      />,
      { width: 82, height: 8 },
    );

    await renderSettled();
    const frame = tui.frame();

    expect(frame).toContain("STATE");
    expect(frame).toContain("CURRENT");
    expect(frame).toContain("TARGET");
    expect(frame).toContain("200");
    expect(frame).toContain("[a]dd alert");
  });

  test("edits the selected alert through the prefilled edit dialog", async () => {
    await tui.render(
      <AlertsHarness alerts={[makeAlert("alert-aapl", "AAPL", "above", 200)]} />,
      { width: 110, height: 12 },
    );

    await renderSettled();
    await act(async () => {
      await tui.setup().mockInput.typeText("e");
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    const dialogFrame = tui.frame();
    expect(dialogFrame).toContain("Edit alert");
    expect(dialogFrame).toContain("AAPL above 200");

    await act(async () => {
      for (const _ of "AAPL above 200") tui.setup().mockInput.pressBackspace();
      await tui.setup().mockInput.typeText("MSFT crosses 310");
      await tui.setup().renderOnce();
    });

    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    expect(storedAlerts()).toEqual([{
      id: "alert-aapl",
      symbol: "MSFT",
      condition: "crosses",
      targetPrice: 310,
      createdAt: 1_700_000_000_000,
      armedAt: expect.any(Number),
      status: "active",
    }]);
  });

  test("opens the shared alert workflow from keyboard and mouse", async () => {
    const workflowCalls: string[] = [];
    const runtime = makeRuntime({
      openPluginCommandWorkflow(commandId: string) {
        workflowCalls.push(commandId);
      },
    });

    await tui.render(<AlertsHarness alerts={[]} runtime={runtime} />, {
      width: 110,
      height: 12,
    });

    await renderSettled();
    await act(async () => {
      await tui.setup().mockInput.typeText("a");
      await tui.setup().renderOnce();
    });
    expect(workflowCalls).toEqual(["set-alert"]);

    await tui.render(<AlertsHarness alerts={[]} runtime={runtime} />, {
      width: 110,
      height: 12,
    });
    await renderSettled();
    await clickFrameText("[a]");

    expect(workflowCalls).toEqual(["set-alert", "set-alert"]);
  });

  test("re-arms the selected triggered alert from its footer action and deletes after confirming", async () => {
    await tui.render(
      <AlertsHarness
        alerts={[
          makeAlert("alert-aapl", "AAPL", "above", 200),
          makeAlert("alert-msft", "MSFT", "below", 300, "triggered"),
        ]}
      />,
      { width: 110, height: 12 },
    );

    await renderSettled();
    // Only a triggered alert offers re-arm, so the hint appears once it is selected.
    expect(tui.frame()).not.toContain("[m]");
    await act(async () => {
      tui.setup().mockInput.pressArrow("down");
      await tui.setup().renderOnce();
    });
    await renderSettled();
    await clickFrameText("[m]");

    expect(storedAlerts().find((alert) => alert.id === "alert-msft")?.status).toBe("active");

    await act(async () => {
      await tui.setup().mockInput.typeText("d");
      await tui.setup().renderOnce();
    });
    await renderSettled();
    expect(tui.frame()).toContain("Delete alert?");
    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    expect(storedAlerts().map((alert) => alert.id)).toEqual(["alert-aapl"]);
  });
});

// Every tab gives its selected row the same `v`; one mapping decides what opens (targets.test.ts).
test("v opens what the selected event rule follows: a security's DES, any other rule its own pane", async () => {
  const opened: string[] = [];
  const runtime = makeRuntime({
    pinTicker: (symbol, options) => { opened.push(`${options?.paneType}:${symbol}`); },
    createPaneFromTemplate: (templateId, options) => { opened.push(`${templateId}:${options?.arg ?? ""}`); },
  });
  const eventRules = [
    createResearchAlert("unusual_volume", { "unusual_volume:symbol": "NVDA" }, 2),
    createResearchAlert("perps_threshold", { "perps_threshold:marketId": "hyperliquid:xyz:AAPL", "perps_threshold:metric": "premium" }, 1),
  ];
  await tui.render(<AlertsHarness alerts={[]} eventRules={eventRules} runtime={runtime} />, { width: 110, height: 12 });
  await renderSettled();
  await clickFrameText("Events");
  await tui.waitForFrameToContain("[v]iew");
  await act(async () => {
    await tui.setup().mockInput.typeText("v");
    await tui.setup().renderOnce();
  });
  await act(async () => {
    tui.setup().mockInput.pressArrow("down");
    await tui.setup().renderOnce();
  });
  await renderSettled();
  await clickFrameText("[v]");
  expect(opened).toEqual(["ticker-research:NVDA", "perps-pane:hyperliquid:xyz:AAPL"]);
});

describe("alertsPlugin command", () => {
  test("adds alerts on the resolved listing after quoting", async () => {
    const store = new Map<string, unknown>();
    const commands: any[] = [];
    const notifications: any[] = [];
    const ctx = {
      registerCommand(command: any) {
        commands.push(command);
      },
      registerPane() {},
      registerPaneTemplate() {},
      configState: {
        get(key: string) {
          return store.get(key);
        },
        set(key: string, value: unknown) {
          store.set(key, value);
        },
      },
      marketData: {
        getQuote: async (symbol: string) => ({
          symbol,
          price: 201.5,
          currency: "USD",
          change: 1,
          changePercent: 0.5,
          lastUpdated: Date.now(),
          dataSource: "live",
        }),
        // 7203 trades in Tokyo only.
        search: async (query: string) => query.startsWith("7203")
          ? [{ providerId: "test", symbol: "7203", name: "Toyota Motor Corporation", exchange: "JPX", currency: "JPY", type: "EQUITY" }]
          : [],
      },
      tickerRepository: { loadTicker: async () => null, loadAllTickers: async () => [] },
      notify(notification: any) {
        notifications.push(notification);
      },
      log: {
        info() {},
        warn() {},
        error() {},
      },
    };

    try {
      await alertsPlugin.setup?.(ctx as any);
      const command = commands.find((entry) => entry.id === "set-alert");

      await command.execute({ shortcut: "AAPL above 200" });

      const alerts = deserializeAlerts(String(store.get("alerts")));
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        symbol: "AAPL",
        condition: "above",
        targetPrice: 200,
        lastCheckedPrice: 201.5,
        status: "active",
      });
      expect(notifications[0]?.body).toContain("AAPL");

      // An alert link's 7203:TSE is Tokyo, where 7203 trades, as `alerts add` reads it.
      await command.execute({ symbol: "7203:TSE", condition: "above", price: "3000" });
      expect(deserializeAlerts(String(store.get("alerts")))[1]).toMatchObject({ symbol: "7203:JPX", targetPrice: 3000 });
    } finally {
      alertsPlugin.dispose?.();
    }
  });
});

test("disposing alerts ignores an in-flight quote and does not schedule another poll", async () => {
  const quote = Promise.withResolvers<never>();
  let writes = 0;
  let notifications = 0;
  let schedulingReads = 0;
  const ctx = {
    registerCommand() {}, registerPane() {}, registerPaneTemplate() {},
    configState: {
      get: () => serializeAlerts([makeAlert("pending", "AAPL", "above", 200)]),
      set: () => { writes += 1; },
    },
    marketData: { getQuote: () => quote.promise },
    paneSettings: { get: () => { schedulingReads += 1; return "15"; } },
    notify: () => { notifications += 1; },
    log: { info() {}, warn() {} },
  };
  try {
    await alertsPlugin.setup?.(ctx as any);
    alertsPlugin.dispose?.();
    quote.reject(new Error("quote completed after disposal"));
    await Bun.sleep(0);
    expect({ writes, notifications, schedulingReads }).toEqual({ writes: 0, notifications: 0, schedulingReads: 0 });
  } finally {
    alertsPlugin.dispose?.();
  }
});

test("a streamed tick triggers a price alert once, and the poll leaves streaming symbols alone", async () => {
  let emit: ((target: QuoteSubscriptionTarget, quote: Quote) => void) | null = null;
  let streamedTargets: QuoteSubscriptionTarget[] = [];
  const clock = createManualFrameDriver(100);
  const frames = new DataFrameScheduler(clock.driver);
  const coordinator = new MarketDataCoordinator(createTestDataProvider({
    subscribeQuotes: (targets, onQuote) => {
      streamedTargets = targets;
      emit = onQuote;
      return () => {};
    },
  }), { frames });
  setSharedMarketDataCoordinator(coordinator);
  const store = new Map<string, string>([["alerts", serializeAlerts([
    { ...makeAlert("above", "AAPL", "above", 200), lastCheckedPrice: 195 },
  ])]]);
  let polled = 0;
  const notifications: string[] = [];
  const ctx = {
    registerCommand() {}, registerPane() {}, registerPaneTemplate() {},
    configState: { get: (key: string) => store.get(key) ?? null, set: (key: string, value: string) => { store.set(key, value); } },
    marketData: { getQuote: async () => { polled += 1; throw new Error("no poll expected"); } },
    paneSettings: { get: () => "15" },
    notify: (notification: { body: string }) => { notifications.push(notification.body); },
    showPane() {},
    log: { info() {}, warn() {} },
  };
  try {
    await alertsPlugin.setup?.(ctx as any);
    // Off screen and low priority: an alert must not outrank what the user watches.
    expect(streamedTargets.map((target) => [target.symbol, target.visible, target.weight])).toEqual([["AAPL", false, 20]]);
    const tick = (price: number) => emit!(streamedTargets[0]!, {
      symbol: "AAPL", price, change: 0, changePercent: 0, currency: "USD",
      lastUpdated: Date.now(), delivery: "stream", dataSource: "live", marketState: "REGULAR",
    } as Quote);
    // Corruption arriving while still subscribed must block notification, before any save guard runs.
    const healthy = store.get("alerts")!;
    const corrupt = JSON.stringify([...JSON.parse(healthy), null]);
    store.set("alerts", corrupt);
    await act(async () => { tick(201); clock.advance(1_000); await Bun.sleep(0); });
    expect(notifications).toEqual([]);
    expect(store.get("alerts")).toBe(corrupt);
    store.set("alerts", healthy);
    await act(async () => { tick(202); clock.advance(1_000); await Bun.sleep(0); });
    await act(async () => { tick(203); clock.advance(1_000); await Bun.sleep(0); });
    expect(notifications).toHaveLength(1);
    expect(deserializeAlerts(store.get("alerts")!)[0]).toMatchObject({ status: "triggered", lastCheckedPrice: 202 });
    // The first poll ran before any tick; nothing streaming is re-quoted after it.
    const before = polled;
    await Bun.sleep(5);
    expect(polled).toBe(before);
  } finally {
    alertsPlugin.dispose?.();
    coordinator.destroy();
    setSharedMarketDataCoordinator(null);
  }
});


test("Add Alert refuses unreadable storage, including corruption arriving during its quote lookup", async () => {
  const old = makeAlert("old", "AAPL", "above", 200, "triggered");
  const broken = ["[{broken", JSON.stringify([old, null]), { unexpected: true }];
  for (const corrupt of broken) {
    for (const duringLookup of [false, true]) {
      let raw: unknown = duringLookup ? JSON.stringify([old]) : corrupt;
      const commands: any[] = [];
      const notifications: any[] = [];
      let writes = 0;
      const ctx = {
        registerCommand: (command: any) => commands.push(command), registerPane() {}, registerPaneTemplate() {},
        configState: { get: (key: string) => key === "alerts" ? raw : undefined, set: () => { writes++; } },
        marketData: { getQuote: async () => {
          if (duringLookup) raw = corrupt;
          return { symbol: "AAPL", price: 201, change: 0, changePercent: 0, currency: "USD", lastUpdated: Date.now() };
        } },
        tickerRepository: { loadTicker: async () => null, loadAllTickers: async () => [] },
        notify: (value: unknown) => notifications.push(value), log: { info() {}, warn() {} },
      };
      try {
        await alertsPlugin.setup?.(ctx as any);
        const command = commands.find((entry) => entry.id === "set-alert");
        await expect(command.execute({ shortcut: "AAPL above 200" })).rejects.toThrow("Saved price alerts");
        expect(raw).toBe(corrupt);
        expect(writes).toBe(0);
        expect(notifications).toEqual([]);
      } finally { alertsPlugin.dispose?.(); }
    }
  }
});

test("Add Alert waits for persistence and never announces a failed save", async () => {
  const commands: any[] = [];
  const notifications: any[] = [];
  const saved = Promise.withResolvers<void>();
  let writing = false;
  const ctx = {
    registerCommand: (command: any) => commands.push(command), registerPane() {}, registerPaneTemplate() {},
    configState: { get: () => undefined, set: () => { writing = true; return saved.promise; } },
    marketData: { getQuote: async () => ({ symbol: "AAPL", price: 201, change: 0, changePercent: 0, currency: "USD", lastUpdated: Date.now() }) },
    tickerRepository: { loadTicker: async () => null, loadAllTickers: async () => [] },
    notify: (value: unknown) => notifications.push(value), log: { info() {}, warn() {} },
  };
  try {
    await alertsPlugin.setup?.(ctx as any);
    const command = commands.find((entry) => entry.id === "set-alert");
    const result = command.execute({ shortcut: "AAPL above 200" });
    const rejected = result.then(() => null, (error: Error) => error);
    await Bun.sleep(0);
    expect(writing).toBe(true);
    expect(notifications).toEqual([]);
    saved.reject(new Error("disk unavailable"));
    expect((await rejected)?.message).toBe("disk unavailable");
    expect(notifications).toEqual([]);
  } finally { alertsPlugin.dispose?.(); }
});

test("a background quote finishing after partial corruption neither triggers nor rewrites the store", async () => {
  const old = makeAlert("old", "AAPL", "above", 200);
  let raw = serializeAlerts([old]);
  const quote = Promise.withResolvers<Quote>();
  let writes = 0;
  let notifications = 0;
  const ctx = {
    registerCommand() {}, registerPane() {}, registerPaneTemplate() {},
    configState: { get: (key: string) => key === "alerts" ? raw : undefined, set: () => { writes++; } },
    marketData: { getQuote: () => quote.promise },
    notify: () => { notifications++; }, log: { info() {}, warn() {} },
  };
  try {
    await alertsPlugin.setup?.(ctx as any);
    raw = JSON.stringify([old, null]);
    quote.resolve({ symbol: "AAPL", price: 220, change: 0, changePercent: 0, currency: "USD", lastUpdated: Date.now() } as Quote);
    await Bun.sleep(0);
    expect({ writes, notifications }).toEqual({ writes: 0, notifications: 0 });
    expect(raw).toBe(JSON.stringify([old, null]));
  } finally { alertsPlugin.dispose?.(); }
});

for (const action of ["d", "e"] as const) {
  test(`an open ${action === "d" ? "delete confirmation" : "edit dialog"} refuses newly unreadable storage`, async () => {
    const alerts = [makeAlert("old", "AAPL", "above", 200)];
    const notifications: any[] = [];
    let writes = 0;
    const runtime = makeRuntime({ notify: (value: unknown) => { notifications.push(value); }, setConfigState: async () => { writes++; } });
    await tui.render(<AlertsHarness alerts={alerts} runtime={runtime} />, { width: 110, height: 18 });
    await renderSettled();
    await act(async () => { await tui.setup().mockInput.typeText(action); await tui.setup().renderOnce(); });
    await renderSettled();
    const raw = JSON.stringify([...alerts, null]);
    await act(async () => {
      const config = harnessState!.config;
      harnessDispatch!({ type: "SET_CONFIG", config: { ...config, pluginConfig: { ...config.pluginConfig, alerts: { alerts: raw } } } });
      await tui.setup().renderOnce();
    });
    await act(async () => { tui.setup().mockInput.pressEnter(); await tui.setup().renderOnce(); });
    await renderSettled();
    expect(writes).toBe(0);
    expect(harnessState!.config.pluginConfig.alerts!.alerts).toBe(raw);
    if (action === "e") {
      expect(tui.frame()).toContain("Edit alert");
      expect(tui.frame()).toContain("unreadable entry");
    } else {
      expect(notifications).toEqual([expect.objectContaining({ type: "error", body: expect.stringContaining("unreadable entry") })]);
    }
  });
}

test("a delete confirmation uses the latest readable list and keeps alerts added meanwhile", async () => {
  const alerts = [makeAlert("old", "AAPL", "above", 200)];
  await tui.render(<AlertsHarness alerts={alerts} />, { width: 110, height: 18 });
  await renderSettled();
  await act(async () => { await tui.setup().mockInput.typeText("d"); await tui.setup().renderOnce(); });
  await renderSettled();
  const added = makeAlert("new", "MSFT", "below", 300);
  await act(async () => {
    const config = harnessState!.config;
    harnessDispatch!({ type: "SET_CONFIG", config: { ...config, pluginConfig: { ...config.pluginConfig, alerts: { alerts: serializeAlerts([...alerts, added]) } } } });
    await tui.setup().renderOnce();
  });
  await act(async () => { tui.setup().mockInput.pressEnter(); await tui.setup().renderOnce(); });
  await renderSettled();
  expect(storedAlerts()).toEqual([added]);
});
