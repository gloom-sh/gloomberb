import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, useReducer } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppState } from "../../../state/app/context";
import type { AppConfig } from "../../../types/config";
import type { PluginRuntimeAccess } from "../../runtime";
import { createConfigBackedTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { deserializeAlerts, serializeAlerts } from "./alert-engine";
import { EVENT_ALERTS_KEY, type EventAlertRule } from "./events";
import { FIRED_LOG_KEY, readFiredAlerts } from "./fired-log";
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

  test("a quote one alert could not get is said on its row and in full in its detail, never in the footer", async () => {
    const checkedAt = Date.now() - 60_000;
    const quoted = (alert: AlertRule, price: number): AlertRule => ({ ...alert, lastCheckedPrice: price, lastCheckedAt: checkedAt });
    const missed = (alert: AlertRule, error: string): AlertRule => ({ ...alert, lastCheckedAt: checkedAt, lastCheckError: error });
    const footerLine = () => tui.frame().split("\n").find((line) => line.includes("[a]dd alert")) ?? "";
    const press = (key: "down" | "enter" | "escape") => act(async () => {
      if (key === "down") tui.setup().mockInput.pressArrow("down");
      else if (key === "enter") tui.setup().mockInput.pressEnter();
      else tui.setup().mockInput.pressEscape();
      await tui.setup().renderOnce();
    });
    await tui.render(
      <AlertsHarness height={14} alerts={[
        quoted(makeAlert("alert-aapl", "AAPL", "above", 400), 343),
        missed(makeAlert("alert-bad", "ZZQXW", "above", 10), "Not a ticker: ZZQXW."),
        missed(makeAlert("alert-msft", "MSFT", "below", 200), "Rate limited."),
      ]} />,
      { width: 110, height: 14 },
    );
    await renderSettled();
    expect(tui.frame().split("\n").find((line) => line.includes("ZZQXW"))).toContain("No quote");
    await press("down");
    await renderSettled();
    // The row says it; the reason waits in its detail.
    expect(tui.frame()).not.toContain("Not a ticker");
    await press("enter");
    await tui.waitForFrameToContain("Not a ticker: ZZQXW.");
    expect(tui.frame()).toContain("ZZQXW above 10.00");
    expect(footerLine()).not.toContain("Not a ticker");
    await press("escape");
    await tui.waitForFrameToExclude("Not a ticker");
    await press("down");
    await press("enter");
    // A reason that does not name the symbol is given it.
    await tui.waitForFrameToContain("MSFT: Rate limited.");
    expect(footerLine()).not.toContain("Rate limited");
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

  test("re-arming goes in the alert log once, and m on an alert that is already active writes nothing", async () => {
    const runtime = makeRuntime();
    await tui.render(<AlertsHarness alerts={[makeAlert("alert-msft", "MSFT", "below", 300, "triggered")]} runtime={runtime} />, { width: 110, height: 12 });
    await renderSettled();
    const pressM = async () => {
      await act(async () => {
        await tui.setup().mockInput.typeText("m");
        await tui.setup().renderOnce();
      });
      await renderSettled();
    };
    // Twice before the pane has drawn the first: the second press still sees the alert as it was.
    await act(async () => {
      await tui.setup().mockInput.typeText("m");
      await tui.setup().mockInput.typeText("m");
    });
    await renderSettled();
    expect(storedAlerts()[0]?.status).toBe("active");
    await pressM();
    const log = readFiredAlerts(runtime.getResumeState("alerts", FIRED_LOG_KEY));
    expect(log.map((entry) => [entry.action, entry.ruleId])).toEqual([["rearmed", "alert-msft"]]);
  });

  test("an open detail stays on its alert when re-arming moves it, and goes back to the list when it is deleted", async () => {
    await tui.render(
      <AlertsHarness
        alerts={[
          makeAlert("alert-nvda", "NVDA", "above", 100, "triggered"),
          makeAlert("alert-aapl", "AAPL", "above", 200),
          makeAlert("alert-msft", "MSFT", "below", 300),
        ]}
      />,
      { width: 110, height: 12 },
    );
    await renderSettled();
    const press = async (key: "down" | "enter" | "m" | "d") => act(async () => {
      if (key === "down") tui.setup().mockInput.pressArrow("down");
      else if (key === "enter") tui.setup().mockInput.pressEnter();
      else await tui.setup().mockInput.typeText(key);
      await tui.setup().renderOnce();
    });
    // The triggered alert lists last; re-armed, it is active and lists first.
    await press("down");
    await press("down");
    await press("enter");
    await tui.waitForFrameToContain("NVDA above 100.00");
    await press("m");
    await renderSettled();
    expect(storedAlerts().find((alert) => alert.id === "alert-nvda")?.status).toBe("active");
    expect(tui.frame()).toContain("NVDA above 100.00");

    await press("d");
    await tui.waitForFrameToContain("Delete alert?");
    await press("enter");
    await renderSettled();
    expect(storedAlerts().map((alert) => alert.id)).toEqual(["alert-aapl", "alert-msft"]);
    // Back on the list, not on the alert that took its row.
    const frame = await tui.waitForFrameToContain("SYMBOL");
    expect(frame).not.toContain("AAPL above 200.00");
    expect(frame).toContain("MSFT");
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
      // A target ten times the price is refused, as `alerts add` refuses it, and nothing is stored.
      await expect(command.execute({ shortcut: "AAPL above 2500" })).rejects.toThrow("A target of 2,500 is more than 10 times AAPL's last price of 201.5.");
      expect(deserializeAlerts(String(store.get("alerts")))).toHaveLength(1);
      // A price that reads two ways or as no number is refused as `alerts add` refuses it, never taken as its leading digits (2,000 as 2).
      await expect(command.execute({ shortcut: "AAPL above 2,000" })).rejects.toThrow("2,000 could be 2000 (thousands) or 2 (decimal comma)");
      await expect(command.execute({ symbol: "AAPL", condition: "above", price: "2,000" })).rejects.toThrow("2,000 could be 2000 (thousands)");
      await expect(command.execute({ shortcut: "AAPL above 20x" })).rejects.toThrow('Alert price must be a number, got "20x"; type 81000 or 81k.');
      expect(deserializeAlerts(String(store.get("alerts")))).toHaveLength(1);

      // An alert link's 7203:TSE is Tokyo, where 7203 trades, as `alerts add` reads it.
      await command.execute({ symbol: "7203:TSE", condition: "above", price: "210" });
      expect(deserializeAlerts(String(store.get("alerts")))[1]).toMatchObject({ symbol: "7203:JPX", targetPrice: 210 });
    } finally {
      alertsPlugin.dispose?.();
    }
  });

  test("reads an unquoted pair as a ratio only when the service says it is no ticker, and never a listing written with a slash", async () => {
    const commands: any[] = [];
    const quoted: string[] = [];
    let pairError = "Not a ticker: XLK/SPY.";
    const ctx = {
      registerCommand(command: any) { commands.push(command); },
      registerPane() {},
      registerPaneTemplate() {},
      configState: { get: () => undefined, set() {} },
      marketData: {
        getQuote: async (symbol: string) => {
          quoted.push(symbol);
          if (symbol === "XLK/SPY") throw new Error(pairError);
          if (symbol.includes("/")) throw new Error(`Not a ticker: ${symbol}.`);
          // The ratio's first listing is as far as this needs to go.
          throw new Error(`Quoted ${symbol} for a ratio.`);
        },
        search: async () => [],
      },
      tickerRepository: { loadTicker: async () => null, loadAllTickers: async () => [] },
      notify() {},
      log: { info() {}, warn() {}, error() {} },
    };
    try {
      await alertsPlugin.setup?.(ctx as any);
      const command = commands.find((entry) => entry.id === "set-alert");
      await expect(command.execute({ shortcut: "XLK/SPY above 0.25" })).rejects.toThrow("Quoted XLK for a ratio.");
      expect(quoted).toEqual(["XLK/SPY", "XLK"]);
      // `alerts add` reads these as one listing each (BTC-USD, BRK-B): they keep their own answer.
      for (const symbol of ["BTC/USD", "BRK/B"]) {
        quoted.length = 0;
        await expect(command.execute({ shortcut: `${symbol} above 500` })).rejects.toThrow(`Not a ticker: ${symbol}.`);
        expect(quoted).toEqual([symbol]);
      }
      // A pair the service could not answer for is not known to be no ticker.
      pairError = "The data service timed out.";
      quoted.length = 0;
      await expect(command.execute({ shortcut: "XLK/SPY above 0.25" })).rejects.toThrow("The data service timed out.");
      expect(quoted).toEqual(["XLK/SPY"]);
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
      get: (key: string) => key === "alerts" ? serializeAlerts([makeAlert("pending", "AAPL", "above", 200)]) : null,
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

test("a completed daily close persists one technical trigger and in-app history, leaving price rules intact", async () => {
  const now = spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-23T20:30Z"));
  const price = serializeAlerts([makeAlert("price", "AAPL", "above", 250, "triggered")]);
  const store = new Map<string, unknown>([
    ["alerts", price],
    ["metricAlerts", serializeAlerts([{
      ...makeAlert("daily", "TSLA", "below", 0),
      exchange: "NASDAQ", metric: { kind: "close_ma", period: 2 },
      armedAt: Date.parse("2026-10-23T19:00Z"),
    }])],
  ]);
  const device = new Map<string, unknown>();
  const notifications: string[] = [];
  const saved = Promise.withResolvers<void>();
  const ctx = {
    registerCommand() {}, registerPane() {}, registerPaneTemplate() {},
    configState: {
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => { store.set(key, value); saved.resolve(); },
    },
    resume: { getState: (key: string) => device.get(key), setState: (key: string, value: unknown) => { device.set(key, value); } },
    marketData: createTestDataProvider({
      getTickerFinancials: async () => ({ symbol: "TSLA", annualStatements: [], quarterlyStatements: [], priceHistory: [] }),
      getDetailedPriceHistory: async () => ["2026-10-21", "2026-10-22", "2026-10-23"].map((day, i) => ({
        date: new Date(day), open: 100, high: 100, low: 90, close: i === 2 ? 90 : 100, volume: 1,
      })),
    }),
    notify: (notification: { body: string }) => notifications.push(notification.body),
    showPane() {}, log: { info() {}, warn() {} },
  };
  try {
    await alertsPlugin.setup?.(ctx as any);
    await saved.promise;
    alertsPlugin.dispose?.();
    expect(deserializeAlerts(store.get("metricAlerts"))[0]).toMatchObject({
      status: "triggered", lastCheckedPrice: 90, lastCheckedTarget: 95, lastDailyClose: "2026-10-23",
    });
    expect(store.get("alerts")).toBe(price);
    expect(device.get("firedLog")).toEqual([expect.objectContaining({
      kind: "close_ma", ruleId: "daily", value: 90, source: "daily close",
    })]);
    await alertsPlugin.setup?.(ctx as any);
    await Bun.sleep(0);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("on daily close");
  } finally { alertsPlugin.dispose?.(); now.mockRestore(); }
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
  const device = new Map<string, unknown>();
  const ctx = {
    registerCommand() {}, registerPane() {}, registerPaneTemplate() {},
    configState: { get: (key: string) => store.get(key) ?? null, set: (key: string, value: string) => { store.set(key, value); } },
    resume: { getState: (key: string) => device.get(key) ?? null, setState: (key: string, value: unknown) => { device.set(key, value); } },
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
    // The device's log keeps it with the quote it went off on, for History with no sign-in.
    expect(device.get("firedLog")).toEqual([expect.objectContaining({
      kind: "price", ruleId: "above", rule: "AAPL above 200", value: 202, unit: "USD", source: "real-time", symbol: "AAPL",
      quoteAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    })]);
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

test("corrupt metric storage cannot pause a price trigger or be overwritten by its save", async () => {
  const broken = "[{broken";
  const store = new Map<string, unknown>([["alerts", serializeAlerts([makeAlert("healthy", "AAPL", "above", 200)])], ["metricAlerts", broken]]);
  const saved = Promise.withResolvers<void>();
  const notices: string[] = [];
  const ctx = {
    registerCommand() {}, registerPane() {}, registerPaneTemplate() {},
    configState: { get: (key: string) => store.get(key), set: (key: string, value: unknown) => { store.set(key, value); saved.resolve(); } },
    marketData: { getQuote: async () => ({ symbol: "AAPL", price: 201, change: 1, changePercent: 1, lastUpdated: Date.now() }) },
    notify: (notice: { body: string }) => notices.push(notice.body),
    log: { info() {}, warn() {} },
  };
  try {
    await alertsPlugin.setup?.(ctx as any);
    await saved.promise;
    expect(deserializeAlerts(store.get("alerts"))[0]?.status).toBe("triggered");
    expect(notices).toHaveLength(1);
    expect(store.get("metricAlerts")).toBe(broken);
  } finally { alertsPlugin.dispose?.(); }
});

test("a slow valuation read leaves price delivery independent and cannot overwrite its persisted trigger", async () => {
  const financials = Promise.withResolvers<any>();
  const metric = { ...makeAlert("slow-metric", "AAPL", "below", 25), metric: { kind: "pe" as const } };
  const store = new Map<string, unknown>([["alerts", serializeAlerts([makeAlert("fast-price", "AAPL", "above", 200)])], ["metricAlerts", serializeAlerts([metric])]]);
  const priceSaved = Promise.withResolvers<void>(), metricSaved = Promise.withResolvers<void>();
  const ctx = {
    registerCommand() {}, registerPane() {}, registerPaneTemplate() {},
    configState: { get: (key: string) => store.get(key), set: (key: string, value: unknown) => { store.set(key, value); (key === "alerts" ? priceSaved : metricSaved).resolve(); } },
    marketData: createTestDataProvider({
      getQuote: async () => ({ symbol: "AAPL", price: 240, currency: "USD", change: 1, changePercent: 1, lastUpdated: Date.now() }),
      getTickerFinancials: () => financials.promise,
    }),
    notify() {}, log: { info() {}, warn() {} },
  };
  try {
    await alertsPlugin.setup?.(ctx as any);
    await priceSaved.promise;
    expect(deserializeAlerts(store.get("alerts"))[0]?.status).toBe("triggered");
    expect(deserializeAlerts(store.get("metricAlerts"))[0]?.status).toBe("active");
    financials.resolve({ quote: { price: 240, lastUpdated: Date.now(), marketState: "REGULAR" }, fundamentals: { trailingPE: 24, eps: 10 } });
    await metricSaved.promise;
    expect(deserializeAlerts(store.get("alerts"))[0]?.status).toBe("triggered");
    expect(deserializeAlerts(store.get("metricAlerts"))[0]?.status).toBe("triggered");
  } finally { alertsPlugin.dispose?.(); financials.resolve({}); }
});
