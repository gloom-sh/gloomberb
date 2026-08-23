import { afterEach, describe, expect, test } from "bun:test";
import { act, useReducer } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import {
  AppContext,
  PaneInstanceProvider,
  appReducer,
  createInitialState,
  type AppState,
} from "../../../state/app/context";
import { cloneLayout, createDefaultConfig, type AppConfig } from "../../../types/config";
import { PluginRenderProvider, type PluginRuntimeAccess } from "../../runtime";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createConfigBackedTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box } from "../../../ui";
import { deserializeAlerts, serializeAlerts } from "./alert-engine";
import { alertsPlugin } from "./index";
import { AlertsPane } from "./pane";
import type { AlertCondition, AlertRule, AlertStatus } from "./types";

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
  const baseConfig = createDefaultConfig("/tmp/gloomberb-alerts");
  const layout: AppConfig["layout"] = {
    dockRoot: { kind: "pane", instanceId: TEST_PANE_ID },
    instances: [{
      instanceId: TEST_PANE_ID,
      paneId: "alerts",
      binding: { kind: "none" },
    }],
    floating: [],
    detached: [],
  };

  return {
    ...baseConfig,
    layout,
    layouts: [{ name: "Default", layout: cloneLayout(layout) }],
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
    <AppContext value={{ state, dispatch }}>
      <PaneInstanceProvider paneId={TEST_PANE_ID}>
        <PluginRenderProvider pluginId="alerts" runtime={runtime}>
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
        </PluginRenderProvider>
      </PaneInstanceProvider>
    </AppContext>
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

  test("updates alerts from table action clicks", async () => {
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
    await clickFrameText("Re-arm");

    expect(storedAlerts().find((alert) => alert.id === "alert-msft")?.status).toBe("active");

    await clickFrameText("[d]");

    expect(storedAlerts().map((alert) => alert.id)).toEqual(["alert-msft"]);
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
