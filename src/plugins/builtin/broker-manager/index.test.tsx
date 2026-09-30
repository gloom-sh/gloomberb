import { describe, expect, test } from "bun:test";
import { act, useReducer } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createDefaultConfig, type BrokerInstanceConfig } from "../../../types/config";
import { testBroker } from "../../../test-support/broker";
import { BrokersPane } from "./index";
import { TestPaneFrame } from "../../../test-support/pane";

const tui = createOpenTuiTestHarness();

function createGatewayInstance(): BrokerInstanceConfig {
  return {
    id: "ibkr-paper",
    brokerType: "ibkr",
    label: "IBKR Paper",
    connectionMode: "gateway",
    config: {
      connectionMode: "gateway",
      gatewaySetupMode: "manual",
      flex: { token: "", queryId: "", endpoint: "" },
      gateway: { host: "127.0.0.1", port: 4002, marketDataType: "auto" },
    },
    enabled: true,
  };
}

function Harness({
  instance,
  calls,
  height = 25,
}: {
  instance?: BrokerInstanceConfig;
  calls: string[];
  height?: number;
}) {
  // Pane state (the open profile) lives in the app state, so it needs a real reducer.
  const [state, dispatch] = useReducer(appReducer, instance, (instance) => {
    const initial = createInitialState({
      ...createDefaultConfig("/tmp/gloomberb-broker-manager-pane"),
      brokerInstances: instance ? [instance] : [],
    });
    if (instance) {
      initial.brokerAccounts = {
        [instance.id]: [{
          accountId: "DU12345",
          name: "DU12345",
          currency: "USD",
          netLiquidation: 125000,
          buyingPower: 50000,
        }],
      };
    }
    return initial;
  });
  const runtime = createTestPluginRuntime({
    getBrokerAdapter: (brokerType) => brokerType === "ibkr" ? testBroker : null,
    openCommandBar: (query) => calls.push(`command:${query ?? ""}`),
    showPane: (paneId) => calls.push(`pane:${paneId}`),
    connectBrokerInstance: async (instanceId) => { calls.push(`connect:${instanceId}`); },
    syncBrokerInstance: async (instanceId) => { calls.push(`sync:${instanceId}`); },
    updateBrokerInstance: async (instanceId, config) => { calls.push(`update:${instanceId}:${String(config.connectionMode)}`); },
  });

  return (
    <TestPaneFrame state={state} dispatch={dispatch} paneId="brokers:test" pluginId="broker" runtime={runtime} width={92} height={height} footerKeys>
      {(body) => <BrokersPane paneId="brokers:test" paneType="brokers" focused {...body} />}
    </TestPaneFrame>
  );
}

async function pressKey(key: Parameters<ReturnType<typeof tui.setup>["mockInput"]["pressKey"]>[0]) {
  await act(async () => {
    tui.setup().mockInput.pressKey(key);
    await Promise.resolve();
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
  });
  // The key's update can commit as act exits, after the frames above.
  await tui.setup().renderOnce();
}

describe("BrokersPane", () => {
  test("renders IBKR row and invokes broker actions", async () => {

    const calls: string[] = [];
    await tui.render(<Harness calls={calls} instance={createGatewayInstance()} height={35} />, { width: 92, height: 35 });
    await act(async () => {
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    let frame = tui.frame();
    expect(frame).toContain("IBKR Paper");
    expect(frame).not.toContain("DU12345");

    await pressKey("c");
    await pressKey("s");
    await pressKey("o");

    expect(calls).toEqual(["connect:ibkr-paper", "sync:ibkr-paper", "pane:ibkr-trading"]);
  });

  test("the edit form walks every field by keyboard, Esc cancels only the edit and Enter saves", async () => {
    const calls: string[] = [];
    const instance = { ...createGatewayInstance(), connectionMode: undefined, config: { connectionMode: "token", credentials: { token: "secret", accountId: "A1" } } };
    await tui.render(<Harness calls={calls} instance={instance} height={35} />, { width: 92, height: 35 });
    await act(async () => {
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    await pressKey("e");
    expect(tui.frame()).toContain("> Profile Label");

    await pressKey("TAB");
    await pressKey("TAB");
    expect(tui.frame()).toContain("> Connection");

    // Esc on a row without a text field would otherwise close the profile.
    await tui.emitKeypress({ name: "escape", sequence: "\u001b" }, { frames: 2, trackPropagation: true, afterCommit: true });
    const frame = tui.frame();
    expect(frame).not.toContain("EDIT PROFILE");
    expect(frame).toContain("ACCOUNTS");

    await pressKey("e");
    await pressKey("TAB");
    await pressKey("TAB");
    await act(async () => {
      tui.setup().mockInput.pressArrow("right");
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });
    await pressKey("RETURN");
    expect(calls).toEqual(["update:ibkr-paper:local"]);
  });
});
