import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, useReducer, useRef, type Dispatch } from "react";
import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import { createSignedInBrokerAdapter } from "../../../brokers/signed-in/adapter";
import { refreshSignedInBrokers, resetSignedInBrokerCatalog } from "../../../brokers/signed-in/catalog";
import type { SignedInBroker } from "../../../brokers/signed-in/client";
import { FormModalHost } from "../../../components/form-modal";
import type { PluginRegistry } from "../../registry";
import { createTestControls, emitKeypress, testRender } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createDefaultConfig, type BrokerInstanceConfig } from "../../../types/config";
import type { BrokerAdapter } from "../../../types/broker";
import { createTestBrokerAdapter, testBroker } from "../../../test-support/broker";
import { BROKER_ADD_REQUEST_KEY, openBrokerAddFlow } from "./add-request";
import { BrokersPane } from "./index";
import { TestPaneFrame } from "../../../test-support/pane";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
let spies: Array<{ mockRestore(): void }> = [];

afterEach(async () => {
  if (testSetup) {
    await act(async () => {
      testSetup!.renderer.destroy();
    });
    testSetup = undefined;
  }
  for (const spy of spies) spy.mockRestore();
  spies = [];
  resetSignedInBrokerCatalog();
});

const { waitForFrameToContain, clickFrameText } = createTestControls(() => testSetup!);

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
  adapters = [testBroker, signedInBroker],
  app,
  detached = false,
}: {
  instance?: BrokerInstanceConfig;
  instances?: BrokerInstanceConfig[];
  calls: string[];
  height?: number;
  /** The brokers installed, for the add flow. */
  adapters?: BrokerAdapter[];
  /** The app state and dispatch as of the last render, for a test to act as the app would. */
  app?: { state?: AppState; dispatch?: Dispatch<AppAction> };
  /** A detached window, which has no form modal. */
  detached?: boolean;
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
  if (app) Object.assign(app, { state, dispatch });
  const notify = (notification: { body: string }) => { calls.push(`notify:${notification.body}`); };
  const runtime = createTestPluginRuntime({
    getBrokerAdapter: (brokerType) => brokerType === "ibkr" ? testBroker : adapters.find((adapter) => adapter.id === brokerType) ?? null,
    listBrokerAdapters: () => adapters,
    createBrokerInstance: async (brokerType, label, values) => {
      calls.push(`create:${brokerType}:${label}:${JSON.stringify(values)}`);
      const created: BrokerInstanceConfig = { id: `${brokerType}-new`, brokerType, label, config: values, enabled: true };
      const { config } = stateRef.current;
      dispatch({ type: "SET_CONFIG", config: { ...config, brokerInstances: [...config.brokerInstances, created] } });
      return created;
    },
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
          {!detached && <FormModalHost dataProvider={{} as never} pluginRegistry={{ notify } as unknown as PluginRegistry} tickerRepository={{} as never} />}
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

async function pressArrow(direction: "up" | "down") {
  await act(async () => {
    testSetup!.mockInput.pressArrow(direction);
    await testSetup!.renderOnce();
  });
}

async function pressEscape() {
  await emitKeypress(testSetup!, { name: "escape", sequence: "\u001b" }, { frames: 2, trackPropagation: true, afterCommit: true });
}

async function settle() {
  await act(async () => {
    await Bun.sleep(5);
    await testSetup!.renderOnce();
    await testSetup!.renderOnce();
  });
}

function frame(): string {
  return testSetup!.captureCharFrame();
}

/** The row of the frame that shows `text`. */
function frameLine(text: string): string {
  return frame().split("\n").find((line) => line.includes(text)) ?? "";
}

const simpleFin = createTestBrokerAdapter({
  id: "simplefin",
  name: "SimpleFIN",
  configSchema: [{ key: "token", label: "Setup Token", type: "password", required: true }],
});

const ROBINHOOD: SignedInBroker = {
  id: "robinhood",
  name: "Robinhood",
  capabilities: { history: true, executions: true, orders: false, singleConnection: true },
};

/** Gloom Cloud: signed in, two signed-in brokers (one also on this device), and a code that connects or never does. */
async function fakeCloud({ connects }: { connects: boolean }) {
  spies.push(spyOn(apiClient, "isSignedIn").mockReturnValue(true));
  spies.push(spyOn(apiClient, "brokerRequest").mockImplementation((async (broker: string, path: string) => {
    if (broker === "connectors") {
      return { connectors: [ROBINHOOD, { ...ROBINHOOD, id: "test-broker", name: "Test Broker" }] };
    }
    if (path === "/connect") {
      return { connectUrl: "https://gloom.sh/connect/K7QM", code: "K7QM", expiresAt: new Date(Date.now() + 60_000).toISOString() };
    }
    return { status: connects ? "connected" : "not_connected" };
  }) as typeof apiClient.brokerRequest));
  await refreshSignedInBrokers({ force: true });
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
  test("in a detached window, d confirms in the window's own dialog", async () => {
    const calls: string[] = [];
    testSetup = await testRender(
      <Harness calls={calls} instances={[createGatewayInstance()]} detached />,
      { width: 92, height: 25 },
    );
    await settle();

    await pressKey("d");
    await settle();
    expect(frame()).toContain("Disconnect broker?");
    await emitKeypress(testSetup, { name: "return", sequence: "\r" }, { frames: 2, trackPropagation: true, afterCommit: true });
    await settle();
    expect(calls).toEqual(["remove:ibkr-paper", "notify:Removed IBKR Paper."]);
    expect(frame()).not.toContain("Disconnect broker?");
  });

  test("a lists every broker, a broker with one method skips the method step, and Esc or Cancel at any step adds nothing", async () => {
    const calls: string[] = [];
    await fakeCloud({ connects: false });
    testSetup = await testRender(
      <Harness calls={calls} adapters={[testBroker, simpleFin, signedInBroker]} height={30} />,
      { width: 92, height: 30 },
    );
    await settle();
    expect(frame()).toContain("No broker profiles.");

    await pressKey("a");
    expect(frame()).toContain("Add Broker Account");
    expect(frameLine("Robinhood")).toContain("Sign in");
    expect(frameLine("Robinhood")).not.toContain("device");
    expect(frameLine("SimpleFIN")).toContain("On this device");
    expect(frameLine("Test Broker")).toContain("Sign in, or on this device");
    await pressEscape();
    expect(frame()).not.toContain("Add Broker Account");

    // Offered both ways: how to connect comes first.
    await pressKey("a");
    await pressArrow("down");
    await pressArrow("down");
    await pressKey("RETURN");
    expect(frame()).toContain("Sign in (recommended)");
    expect(frame()).toContain("On this device (Test Broker)");
    await pressEscape();
    expect(frame()).not.toContain("Sign in (recommended)");

    // On this device only: straight to its fields, named after the broker.
    await pressKey("a");
    await pressArrow("down");
    await pressKey("RETURN");
    expect(frame()).toContain("Connect SimpleFIN");
    expect(frame()).toContain("Setup Token");
    expect(frame()).not.toContain("On this device");
    await pressEscape();
    expect(frame()).not.toContain("Setup Token");

    // Signing in only: straight to the connect step.
    await pressKey("a");
    await pressKey("RETURN");
    await waitForFrameToContain("K7QM", 40);
    expect(frame()).toContain("Connect Robinhood");
    expect(frame()).toContain("Other AI apps linked to Robinhood get disconnected.");
    await clickFrameText("Cancel");
    await settle();
    expect(frame()).not.toContain("K7QM");
    expect(frame()).toContain("No broker profiles.");

    expect(calls.filter((call) => call.startsWith("create:") || call.startsWith("sync:"))).toEqual([]);
  }, 10_000);

  test("the device path creates the profile under its label, syncs it and lands on it", async () => {
    const calls: string[] = [];
    testSetup = await testRender(
      <Harness calls={calls} instances={[createGatewayInstance()]} adapters={[simpleFin]} height={30} />,
      { width: 92, height: 30 },
    );
    await settle();

    await pressKey("a");
    await pressKey("RETURN");
    expect(frame()).toContain("Connect SimpleFIN");
    await pressKey("TAB");
    await act(async () => {
      await testSetup!.mockInput.typeText("tok-1");
      await testSetup!.renderOnce();
    });
    await pressKey("RETURN");
    await settle();

    expect(calls).toEqual([
      'create:simplefin:SimpleFIN:{"token":"tok-1"}',
      "sync:simplefin-new",
      "notify:Connected! Positions will sync automatically.",
    ]);
    expect(frame()).not.toContain("Connect SimpleFIN");
    // The new profile is the selected row.
    await pressKey("RETURN");
    expect(frame()).toContain("simplefin-new");
  });

  test("the signed-in path connects in the pane, then syncs and selects the new profile", async () => {
    const calls: string[] = [];
    await fakeCloud({ connects: true });
    testSetup = await testRender(
      <Harness calls={calls} instances={[createGatewayInstance()]} adapters={[signedInBroker]} height={30} />,
      { width: 92, height: 30 },
    );
    await settle();

    await pressKey("a");
    await pressKey("RETURN");
    await waitForFrameToContain("K7QM", 40);
    // Connected shows for a beat; Enter goes on at once.
    await waitForFrameToContain("Connected", 80);
    // The profile is made and synced as the key's work settles.
    await act(async () => {
      testSetup!.mockInput.pressKey("RETURN");
      await Bun.sleep(5);
    });
    await settle();

    expect(calls).toEqual([
      'create:signed-in:Robinhood:{"connectionMode":"robinhood","broker":"robinhood"}',
      "sync:signed-in-new",
      "notify:Connected! Positions will sync automatically.",
    ]);
    expect(frame()).not.toContain("Connect Robinhood");
    await pressKey("RETURN");
    expect(frame()).toContain("signed-in-new");
  }, 15_000);

  // The command bar's Add Broker Account and the File menu's go through here.
  test("Add Broker Account shows the pane and starts its add flow", async () => {
    const calls: string[] = [];
    const app: { state?: AppState; dispatch?: Dispatch<AppAction> } = {};
    testSetup = await testRender(<Harness calls={calls} app={app} adapters={[simpleFin]} />, { width: 92, height: 25 });
    await settle();

    const shown: string[] = [];
    await act(async () => {
      openBrokerAddFlow({
        panes: new Map([["brokers", {}]]),
        showPane: (paneId: string) => { shown.push(paneId); },
        getLayoutFn: () => ({
          dockRoot: null,
          instances: [{ instanceId: "brokers:test", paneId: "brokers", binding: { kind: "none" } }],
          floating: [],
          detached: [],
        }),
        updatePaneRuntimeStateFn: (paneId: string, patch: Record<string, unknown>) => {
          app.dispatch!({ type: "UPDATE_PANE_STATE", paneId, patch });
        },
        notify: () => {},
      } as unknown as Parameters<typeof openBrokerAddFlow>[0]);
    });
    await settle();

    expect(shown).toEqual(["brokers"]);
    expect(frame()).toContain("Add Broker Account");
    expect(frameLine("SimpleFIN")).toContain("On this device");
    // Taken, so a reload does not start it again.
    expect(app.state!.paneState["brokers:test"]?.[BROKER_ADD_REQUEST_KEY]).toBeNull();
  });
});
