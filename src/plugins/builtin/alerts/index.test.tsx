import { afterEach, describe, expect, test } from "bun:test";
import { act, useReducer } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppState } from "../../../state/app/context";
import type { AppConfig } from "../../../types/config";
import type { PluginRuntimeAccess } from "../../runtime";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createConfigBackedTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box } from "../../../ui";
import { deserializeAlerts, serializeAlerts } from "./alert-engine";
import { alertsPlugin } from "./index";
import { AlertsPane } from "./pane";
import type { AlertCondition, AlertRule, AlertStatus } from "./types";
import { TestPaneProvider, createTestPaneConfig } from "../../../test-support/pane";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { createTestDataProvider } from "../../../test-support/data-provider";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import type { Quote } from "../../../types/financials";

const TEST_PANE_ID = "alerts:test";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
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

function createAlertsConfig(alerts: AlertRule[]): AppConfig {
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
  width = 110,
  height = 12,
  runtime = makeRuntime(),
}: {
  alerts: AlertRule[];
  width?: number;
  height?: number;
  runtime?: PluginRuntimeAccess;
}) {
  const initialState = createInitialState(createAlertsConfig(alerts));
  initialState.focusedPaneId = TEST_PANE_ID;
  const [state, dispatch] = useReducer(appReducer, initialState);
  harnessState = state;
  harnessDispatch = dispatch;

  return (
    <TestPaneProvider state={state} dispatch={dispatch} paneId={TEST_PANE_ID} pluginId="alerts" runtime={runtime}>
      <PaneFooterProvider>
        {(footer) => (
          <Box flexDirection="column" width={width} height={height}>
            <AlertsPane
              paneId={TEST_PANE_ID}
              paneType="alerts"
              focused
              width={width}
              height={Math.max(1, height - 1)}
            />
            <PaneFooterBar footer={footer} focused width={width} />
          </Box>
        )}
      </PaneFooterProvider>
    </TestPaneProvider>
  );
}

async function renderSettled(): Promise<void> {
  await act(async () => {
    await testSetup!.renderOnce();
    await testSetup!.renderOnce();
  });
}

async function clickFrameText(text: string): Promise<void> {
  const frame = testSetup!.captureCharFrame();
  const rows = frame.split("\n");
  const row = rows.findIndex((line) => line.includes(text));
  const col = row >= 0 ? rows[row]!.indexOf(text) : -1;

  expect(row).toBeGreaterThanOrEqual(0);
  expect(col).toBeGreaterThanOrEqual(0);

  await act(async () => {
    await testSetup!.mockMouse.click(col + 1, row);
    await testSetup!.renderOnce();
    await testSetup!.renderOnce();
  });
}

function storedAlerts(): AlertRule[] {
  const value = (harnessState?.config.pluginConfig.alerts as any)?.alerts;
  expect(typeof value).toBe("string");
  return JSON.parse(value);
}

afterEach(async () => {
  harnessState = null;
  harnessDispatch = null;
  if (!testSetup) return;
  await act(async () => {
    testSetup!.renderer.destroy();
  });
  testSetup = undefined;
});

describe("AlertsPane", () => {
  test("renders alerts in a data table with action hints only in the footer", async () => {
    testSetup = await testRender(
      <AlertsHarness
        alerts={[
          makeAlert("alert-aapl", "AAPL", "above", 200),
          makeAlert("alert-msft", "MSFT", "below", 300, "triggered"),
        ]}
      />,
      { width: 110, height: 12 },
    );

    await renderSettled();
    const frame = testSetup.captureCharFrame();

    expect(frame).toContain("State");
    expect(frame).toContain("Symbol");
    expect(frame).toContain("Current");
    expect(frame).toContain("Away");
    expect(frame).toContain("AAPL");
    expect(frame).toContain("MSFT");
    expect(frame).toContain("[a]dd alert");
    expect(frame).toContain("[e]dit");
    expect(frame).toContain("[d]elete");
    expect(frame).not.toContain("Add Alert");
    expect(frame).not.toContain("Enter");
    expect(frame).not.toContain("Esc");
    expect(frame).not.toContain("move field");
    expect(frame).not.toContain("change condition");
    expect(frame).not.toContain("↑/↓");
    expect(frame).not.toContain("←/→");
  });

  test("keeps alert targets visible at the default floating pane width", async () => {
    testSetup = await testRender(
      <AlertsHarness
        width={82}
        height={8}
        alerts={[makeAlert("alert-aapl", "AAPL", "above", 200)]}
      />,
      { width: 82, height: 8 },
    );

    await renderSettled();
    const frame = testSetup.captureCharFrame();

    expect(frame).toContain("State");
    expect(frame).toContain("Current");
    expect(frame).toContain("Target");
    expect(frame).toContain("200");
    expect(frame).toContain("[a]dd alert");
  });

  test("edits the selected alert through the prefilled edit dialog", async () => {
    testSetup = await testRender(
      <AlertsHarness alerts={[makeAlert("alert-aapl", "AAPL", "above", 200)]} />,
      { width: 110, height: 12 },
    );

    await renderSettled();
    await act(async () => {
      await testSetup!.mockInput.typeText("e");
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    const dialogFrame = testSetup.captureCharFrame();
    expect(dialogFrame).toContain("Edit alert");
    expect(dialogFrame).toContain("AAPL above 200");

    await act(async () => {
      for (const _ of "AAPL above 200") testSetup!.mockInput.pressBackspace();
      await testSetup!.mockInput.typeText("MSFT crosses 310");
      await testSetup!.renderOnce();
    });

    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    expect(storedAlerts()).toEqual([{
      id: "alert-aapl",
      symbol: "MSFT",
      condition: "crosses",
      targetPrice: 310,
      createdAt: 1_700_000_000_000,
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

    testSetup = await testRender(<AlertsHarness alerts={[]} runtime={runtime} />, {
      width: 110,
      height: 12,
    });

    await renderSettled();
    await act(async () => {
      await testSetup!.mockInput.typeText("a");
      await testSetup!.renderOnce();
    });
    expect(workflowCalls).toEqual(["set-alert"]);

    await act(async () => {
      testSetup!.renderer.destroy();
    });
    testSetup = await testRender(<AlertsHarness alerts={[]} runtime={runtime} />, {
      width: 110,
      height: 12,
    });
    await renderSettled();
    await clickFrameText("[a]");

    expect(workflowCalls).toEqual(["set-alert", "set-alert"]);
  });

  test("re-arms the selected triggered alert from its footer action and deletes after confirming", async () => {
    testSetup = await testRender(
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
    expect(testSetup.captureCharFrame()).not.toContain("[m]");
    await act(async () => {
      testSetup!.mockInput.pressArrow("down");
      await testSetup!.renderOnce();
    });
    await renderSettled();
    await clickFrameText("[m]");

    expect(storedAlerts().find((alert) => alert.id === "alert-msft")?.status).toBe("active");

    await act(async () => {
      await testSetup!.mockInput.typeText("d");
      await testSetup!.renderOnce();
    });
    await renderSettled();
    expect(testSetup.captureCharFrame()).toContain("Delete alert?");
    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    expect(storedAlerts().map((alert) => alert.id)).toEqual(["alert-aapl"]);
  });
});

describe("alertsPlugin command", () => {
  test("registers a searchable add command with direct shortcut arguments", async () => {
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
      },
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

      expect(command?.label).toBe("Add Alert");
      expect(command?.keywords).toContain("add");
      expect(command?.shortcut).toBe("SA");
      expect(command?.shortcutArg?.placeholder).toBe("symbol condition price");
      expect(command?.shortcutArg?.parse("AMD")).toEqual({ symbol: "AMD" });
      expect(command?.shortcutArg?.parse("", { activeTicker: "MSFT" })).toEqual({ symbol: "MSFT" });
      expect(command?.shortcutArg?.parse("AMD above 200")).toEqual({
        symbol: "AMD",
        condition: "above",
        price: "200",
      });

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
  const coordinator = new MarketDataCoordinator(createTestDataProvider({
    subscribeQuotes: (targets, onQuote) => {
      streamedTargets = targets;
      emit = onQuote;
      return () => {};
    },
  }));
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
    await act(async () => { tick(201); await Bun.sleep(5); });
    await act(async () => { tick(202); await Bun.sleep(5); });
    expect(notifications).toHaveLength(1);
    expect(deserializeAlerts(store.get("alerts")!)[0]).toMatchObject({ status: "triggered", lastCheckedPrice: 201 });
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
