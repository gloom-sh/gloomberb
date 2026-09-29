import { afterEach, describe, expect, test } from "bun:test";
import { act, useReducer, useRef } from "react";
import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import { createSignedInBrokerAdapter } from "../../../brokers/signed-in/adapter";
import { FormModalHost } from "../../../components/form-modal";
import type { PluginRegistry } from "../../registry";
import { emitKeypress, testRender } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createDefaultConfig, type BrokerInstanceConfig } from "../../../types/config";
import { testBroker } from "../../../test-support/broker";
import { BrokersPane } from "./index";
import { TestPaneFrame } from "../../../test-support/pane";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(async () => {
  if (testSetup) {
    await act(async () => {
      testSetup!.renderer.destroy();
    });
    testSetup = undefined;
  }
});

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

const signedInBroker = createSignedInBrokerAdapter({ findBroker: () => null });

function Harness({
  instance,
  instances = instance ? [instance] : [],
  calls,
  height = 25,
}: {
  instance?: BrokerInstanceConfig;
  instances?: BrokerInstanceConfig[];
  calls: string[];
  height?: number;
}) {
  // Pane state (the open profile) lives in the app state, so it needs a real reducer.
  const [state, dispatch] = useReducer(appReducer, instances, (instances) => {
    const initial = createInitialState({
      ...createDefaultConfig("/tmp/gloomberb-broker-manager-pane"),
      brokerInstances: instances,
    });
    if (instances[0]) {
      initial.brokerAccounts = {
        [instances[0].id]: [{
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
  const stateRef = useRef(state);
  stateRef.current = state;
  const notify = (notification: { body: string }) => { calls.push(`notify:${notification.body}`); };
  const runtime = createTestPluginRuntime({
    getBrokerAdapter: (brokerType) => brokerType === "ibkr" ? testBroker : brokerType === "signed-in" ? signedInBroker : null,
    openCommandBar: (query) => calls.push(`command:${query ?? ""}`),
    showPane: (paneId) => calls.push(`pane:${paneId}`),
    connectBrokerInstance: async (instanceId) => { calls.push(`connect:${instanceId}`); },
    syncBrokerInstance: async (instanceId) => { calls.push(`sync:${instanceId}`); },
    updateBrokerInstance: async (instanceId, config) => { calls.push(`update:${instanceId}:${String(config.connectionMode)}`); },
    removeBrokerInstance: async (instanceId) => {
      calls.push(`remove:${instanceId}`);
      const { config } = stateRef.current;
      dispatch({ type: "SET_CONFIG", config: { ...config, brokerInstances: config.brokerInstances.filter((entry) => entry.id !== instanceId) } });
    },
    notify,
  });

  return (
    <TestPaneFrame state={state} dispatch={dispatch} paneId="brokers:test" pluginId="broker" runtime={runtime} width={92} height={height} footerKeys>
      {(body) => (
        <>
          <BrokersPane focused {...body} />
          {/* The app shell's: confirms open in it. */}
          <FormModalHost dataProvider={{} as never} pluginRegistry={{ notify } as unknown as PluginRegistry} tickerRepository={{} as never} />
        </>
      )}
    </TestPaneFrame>
  );
}

async function pressKey(key: Parameters<NonNullable<typeof testSetup>["mockInput"]["pressKey"]>[0]) {
  await act(async () => {
    testSetup!.mockInput.pressKey(key);
    await Promise.resolve();
    await testSetup!.renderOnce();
    await testSetup!.renderOnce();
  });
  // The key's update can commit as act exits, after the frames above.
  await testSetup!.renderOnce();
}

describe("BrokersPane", () => {
  test("renders IBKR row and invokes broker actions", async () => {

    const calls: string[] = [];
    testSetup = await testRender(<Harness calls={calls} instance={createGatewayInstance()} height={35} />, { width: 92, height: 35 });
    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    let frame = testSetup.captureCharFrame();
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
    testSetup = await testRender(<Harness calls={calls} instance={instance} height={35} />, { width: 92, height: 35 });
    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    await pressKey("e");
    expect(testSetup.captureCharFrame()).toContain("> Profile Label");

    await pressKey("TAB");
    await pressKey("TAB");
    expect(testSetup.captureCharFrame()).toContain("> Connection");

    // Esc on a row without a text field would otherwise close the profile.
    await emitKeypress(testSetup, { name: "escape", sequence: "\u001b" }, { frames: 2, trackPropagation: true, afterCommit: true });
    const frame = testSetup.captureCharFrame();
    expect(frame).not.toContain("EDIT PROFILE");
    expect(frame).toContain("ACCOUNTS");

    await pressKey("e");
    await pressKey("TAB");
    await pressKey("TAB");
    await act(async () => {
      testSetup!.mockInput.pressArrow("right");
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });
    await pressKey("RETURN");
    expect(calls).toEqual(["update:ibkr-paper:local"]);
  });

  test("d confirms in the central modal, removes the profile though Gloom cannot disconnect it, and selects the next one", async () => {
    const calls: string[] = [];
    const flex: BrokerInstanceConfig = { id: "ibkr-flex", brokerType: "ibkr", label: "IBKR Flex", connectionMode: "token", config: { connectionMode: "token" }, enabled: true };
    const signedIn: BrokerInstanceConfig = { id: "signed-in-ibkr", brokerType: "signed-in", label: "Interactive Brokers", connectionMode: "ibkr", config: {}, enabled: true };
    const brokerRequest = apiClient.brokerRequest;
    apiClient.brokerRequest = (async () => { throw new ApiRequestError("Internal error", 500); }) as typeof apiClient.brokerRequest;
    try {
      testSetup = await testRender(
        <Harness calls={calls} instances={[flex, signedIn, createGatewayInstance()]} height={35} />,
        { width: 92, height: 35 },
      );
      await act(async () => {
        await testSetup!.renderOnce();
        await testSetup!.renderOnce();
      });

      await act(async () => {
        testSetup!.mockInput.pressArrow("down");
        await testSetup!.renderOnce();
      });
      await pressKey("d");
      await act(async () => { await Bun.sleep(5); });
      await testSetup.renderOnce();
      const confirm = testSetup.captureCharFrame();
      expect(confirm).toContain("Disconnect broker?");
      expect(confirm).toContain("This also disconnects Interactive Brokers from your");

      await emitKeypress(testSetup, { name: "return", sequence: "\r" }, { frames: 2, trackPropagation: true, afterCommit: true });
      await act(async () => { await Bun.sleep(5); });
      await testSetup.renderOnce();
      expect(calls).toEqual([
        "remove:signed-in-ibkr",
        "notify:Removed Interactive Brokers. Interactive Brokers is still connected to your Gloom account.",
      ]);
      expect(testSetup.captureCharFrame()).not.toContain("Disconnect broker?");

      // Enter opens the selected profile: the one after the removed row.
      await pressKey("RETURN");
      const detail = testSetup.captureCharFrame();
      expect(detail).toContain("IBKR Paper");
      expect(detail).not.toContain("IBKR Flex");
    } finally {
      apiClient.brokerRequest = brokerRequest;
    }
  });
});
