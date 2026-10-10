import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, useReducer, useRef, type Dispatch } from "react";
import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import { createSignedInBrokerAdapter } from "../../../brokers/signed-in/adapter";
import { refreshSignedInBrokers, resetSignedInBrokerCatalog } from "../../../brokers/signed-in/catalog";
import type { SignedInBroker } from "../../../brokers/signed-in/client";
import * as signInDialog from "../../../brokers/signed-in/sign-in-dialog";
import { FormModalHost } from "../../../components/form-modal";
import type { PluginRegistry } from "../../registry";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createDefaultConfig, type BrokerInstanceConfig } from "../../../types/config";
import type { BrokerAdapter } from "../../../types/broker";
import { createTestBrokerAdapter, testBroker } from "../../../test-support/broker";
import { BROKER_ADD_REQUEST_KEY, openBrokerAddFlow } from "./add-request";
import { BrokersPane } from "./index";
import { TestPaneFrame } from "../../../test-support/pane";

const tui = createOpenTuiTestHarness();
let spies: Array<{ mockRestore(): void }> = [];

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  spies = [];
  resetSignedInBrokerCatalog();
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
  adapters = [testBroker, signedInBroker],
  app,
  detached = false,
  beforeCreate,
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
  /** Holds a new profile's creation until it resolves. */
  beforeCreate?: () => Promise<void>;
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
      await beforeCreate?.();
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
          <BrokersPane paneId="brokers:test" paneType="brokers" focused {...body} />
          {/* The app shell's: confirms open in it. */}
          {!detached && <FormModalHost dataProvider={{} as never} pluginRegistry={{ notify } as unknown as PluginRegistry} tickerRepository={{} as never} />}
        </>
      )}
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

async function pressArrow(direction: "up" | "down") {
  await act(async () => {
    tui.setup().mockInput.pressArrow(direction);
    await tui.setup().renderOnce();
  });
}

async function pressEscape() {
  await tui.emitKeypress({ name: "escape", sequence: "\u001b" }, { frames: 2, trackPropagation: true, afterCommit: true });
}

async function settle() {
  await act(async () => {
    await Bun.sleep(5);
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
  });
}

function frame(): string {
  return tui.frame();
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
    expect(frame).not.toContain("Edit Profile");
    expect(frame).toContain("Accounts");

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

  test("d confirms in the central modal, removes the profile though Gloom cannot disconnect it, and selects the next one", async () => {
    const calls: string[] = [];
    const flex: BrokerInstanceConfig = { id: "ibkr-flex", brokerType: "ibkr", label: "IBKR Flex", connectionMode: "token", config: { connectionMode: "token" }, enabled: true };
    const signedIn: BrokerInstanceConfig = { id: "signed-in-ibkr", brokerType: "signed-in", label: "Interactive Brokers", connectionMode: "ibkr", config: {}, enabled: true };
    const brokerRequest = apiClient.brokerRequest;
    apiClient.brokerRequest = (async () => { throw new ApiRequestError("Internal error", 500); }) as typeof apiClient.brokerRequest;
    try {
      await tui.render(
        <Harness calls={calls} instances={[flex, signedIn, createGatewayInstance()]} height={35} />,
        { width: 92, height: 35 },
      );
      await act(async () => {
        await tui.setup().renderOnce();
        await tui.setup().renderOnce();
      });

      await act(async () => {
        tui.setup().mockInput.pressArrow("down");
        await tui.setup().renderOnce();
      });
      await pressKey("d");
      await act(async () => { await Bun.sleep(5); });
      await tui.setup().renderOnce();
      const confirm = tui.frame();
      expect(confirm).toContain("Disconnect broker?");
      expect(confirm).toContain("This also disconnects Interactive Brokers from your");

      await tui.emitKeypress({ name: "return", sequence: "\r" }, { frames: 2, trackPropagation: true, afterCommit: true });
      await act(async () => { await Bun.sleep(5); });
      await tui.setup().renderOnce();
      expect(calls).toEqual([
        "remove:signed-in-ibkr",
        "notify:Removed Interactive Brokers. Interactive Brokers is still connected to your Gloom account.",
      ]);
      expect(tui.frame()).not.toContain("Disconnect broker?");

      // Enter opens the selected profile: the one after the removed row.
      await pressKey("RETURN");
      const detail = tui.frame();
      expect(detail).toContain("IBKR Paper");
      expect(detail).not.toContain("IBKR Flex");
    } finally {
      apiClient.brokerRequest = brokerRequest;
    }
  });
  test("in a detached window, d confirms in the window's own dialog", async () => {
    const calls: string[] = [];
    await tui.render(
      <Harness calls={calls} instances={[createGatewayInstance()]} detached />,
      { width: 92, height: 25 },
    );
    await settle();

    await pressKey("d");
    await settle();
    expect(frame()).toContain("Disconnect broker?");
    await tui.emitKeypress({ name: "return", sequence: "\r" }, { frames: 2, trackPropagation: true, afterCommit: true });
    await settle();
    expect(calls).toEqual(["remove:ibkr-paper", "notify:Removed IBKR Paper."]);
    expect(frame()).not.toContain("Disconnect broker?");
  });

  test("a lists every broker, a broker with one method skips the method step, and Esc or Cancel at any step adds nothing", async () => {
    const calls: string[] = [];
    await fakeCloud({ connects: false });
    await tui.render(
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
    await tui.waitForFrameToContain("K7QM", 40);
    expect(frame()).toContain("Connect Robinhood");
    expect(frame()).toContain("Other AI apps linked to Robinhood get disconnected.");
    await tui.clickFrameText("Cancel");
    await settle();
    expect(frame()).not.toContain("K7QM");
    expect(frame()).toContain("No broker profiles.");

    expect(calls.filter((call) => call.startsWith("create:") || call.startsWith("sync:"))).toEqual([]);
  }, 10_000);

  test("the device path creates the profile under its label, syncs it and lands on it", async () => {
    const calls: string[] = [];
    await tui.render(
      <Harness calls={calls} instances={[createGatewayInstance()]} adapters={[simpleFin]} height={30} />,
      { width: 92, height: 30 },
    );
    await settle();

    await pressKey("a");
    await pressKey("RETURN");
    expect(frame()).toContain("Connect SimpleFIN");
    await pressKey("TAB");
    await act(async () => {
      await tui.setup().mockInput.typeText("tok-1");
      await tui.setup().renderOnce();
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

  test("Esc or Back after Connect waits for the new profile instead of leaving it made unseen", async () => {
    const calls: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await tui.render(
      <Harness calls={calls} adapters={[simpleFin]} height={30} beforeCreate={() => gate} />,
      { width: 92, height: 30 },
    );
    await settle();

    await pressKey("a");
    await pressKey("RETURN");
    await pressKey("TAB");
    await act(async () => {
      await tui.setup().mockInput.typeText("tok-1");
      await tui.setup().renderOnce();
    });
    await pressKey("RETURN");
    await settle();
    await pressEscape();
    await tui.clickFrameText("Back");
    await settle();
    expect(frame()).toContain("Connect SimpleFIN");

    await act(async () => { release(); });
    await settle();
    expect(calls).toEqual([
      'create:simplefin:SimpleFIN:{"token":"tok-1"}',
      "sync:simplefin-new",
      "notify:Connected! Positions will sync automatically.",
    ]);
    expect(frame()).not.toContain("Connect SimpleFIN");
    await pressKey("RETURN");
    expect(frame()).toContain("simplefin-new");
  });

  test("the signed-in path connects in the pane, then syncs and selects the new profile", async () => {
    const calls: string[] = [];
    await fakeCloud({ connects: true });
    await tui.render(
      <Harness calls={calls} instances={[createGatewayInstance()]} adapters={[signedInBroker]} height={30} />,
      { width: 92, height: 30 },
    );
    await settle();

    await pressKey("a");
    await pressKey("RETURN");
    await tui.waitForFrameToContain("K7QM", 40);
    // Connected shows for a beat; Enter goes on at once.
    await tui.waitForFrameToContain("Connected", 80);
    // The profile is made and synced as the key's work settles.
    await act(async () => {
      tui.setup().mockInput.pressKey("RETURN");
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

  test("c renews a sign-in the pane knows is connected or ending, and is a plain connect otherwise", async () => {
    const calls: string[] = [];
    const asked: Array<{ renew?: boolean }> = [];
    const connectedAt = new Date(Date.now() - 6.5 * 24 * 3_600_000).toISOString();
    let connection: Record<string, unknown> = { status: "connected", connectedAt };
    spies.push(spyOn(apiClient, "isSignedIn").mockReturnValue(true));
    spies.push(spyOn(apiClient, "brokerRequest").mockImplementation((async (_broker: string, path: string) => (
      path === "" ? connection : { accounts: [], positions: [] }
    )) as typeof apiClient.brokerRequest));
    spies.push(spyOn(signInDialog, "requestBrokerSignIn").mockImplementation(async (_broker, options) => {
      asked.push({ renew: options?.renew });
      return false;
    }));
    const profile = (id: string): BrokerInstanceConfig => ({ id, brokerType: "signed-in", label: id, connectionMode: "ibkr", config: {}, enabled: true });
    // One adapter that has synced this session (connected) and a new one for each profile that has not.
    const syncedAdapter = createSignedInBrokerAdapter({ findBroker: () => null });
    await syncedAdapter.listAccounts!(profile("synced"));
    const ending = { status: "connected", connectedAt, expiresAt: new Date(Date.now() + 5 * 3_600_000).toISOString(), expiresSoon: true };

    for (const [id, answer, renews] of [
      ["synced", { status: "connected", connectedAt }, true],
      ["flagged", ending, true],
      ["plain", { status: "connected", connectedAt }, false],
    ] as const) {
      asked.length = 0;
      connection = answer;
      const adapter = id === "synced" ? syncedAdapter : createSignedInBrokerAdapter({ findBroker: () => null });
      await tui.render(<Harness calls={calls} instances={[profile(id)]} adapters={[testBroker, adapter]} height={30} />, { width: 92, height: 30 });
      await settle();
      await settle();
      await pressKey("c");
      await settle();
      expect(asked).toEqual([{ renew: renews }]);
      expect(frame()).toContain(renews ? "sign-in was not renewed." : "was not connected.");
    }
  });

  // The command bar's Add Broker Account and the File menu's go through here.
  test("Add Broker Account shows the pane and starts its add flow", async () => {
    const calls: string[] = [];
    const app: { state?: AppState; dispatch?: Dispatch<AppAction> } = {};
    await tui.render(<Harness calls={calls} app={app} adapters={[simpleFin]} />, { width: 92, height: 25 });
    await settle();

    const shown: string[] = [];
    await act(async () => {
      openBrokerAddFlow({
        panes: new Map([["brokers", {}]]),
        showPane: (paneId: string) => { shown.push(paneId); },
        getLayout: () => ({
          dockRoot: null,
          instances: [{ instanceId: "brokers:test", paneId: "brokers", binding: { kind: "none" } }],
          floating: [],
          detached: [],
        }),
        updatePaneRuntimeState: (paneId: string, patch: Record<string, unknown>) => {
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

  test("Add Broker Account keeps an add or an edit under way", async () => {
    const calls: string[] = [];
    const app: { state?: AppState; dispatch?: Dispatch<AppAction> } = {};
    await tui.render(
      <Harness calls={calls} app={app} instances={[createGatewayInstance()]} adapters={[simpleFin]} height={30} />,
      { width: 92, height: 30 },
    );
    await settle();
    const request = async () => {
      await act(async () => {
        app.dispatch!({ type: "UPDATE_PANE_STATE", paneId: "brokers:test", patch: { [BROKER_ADD_REQUEST_KEY]: Date.now() } });
      });
      await settle();
    };

    await pressKey("a");
    await pressKey("RETURN");
    await pressKey("TAB");
    await act(async () => {
      await tui.setup().mockInput.typeText("tok-1");
      await tui.setup().renderOnce();
    });
    await request();
    expect(frame()).toContain("> Setup Token");
    expect(frameLine("*****").trim()).toBe("*****");

    await pressEscape();
    await pressKey("e");
    expect(frame()).toContain("> Profile Label");
    await request();
    expect(frame()).toContain("> Profile Label");
    expect(frame()).toContain("Save or cancel the edit first.");
  });
});
