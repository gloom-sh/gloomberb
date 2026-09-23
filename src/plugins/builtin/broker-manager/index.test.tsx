import { afterEach, describe, expect, test } from "bun:test";
import { act, useReducer } from "react";
import { Box } from "../../../ui";
import { PaneFooterBar, PaneFooterKeys, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { emitKeypress, testRender } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createDefaultConfig, type BrokerInstanceConfig } from "../../../types/config";
import { testBroker } from "../../../brokers/test-broker";
import { BrokersPane } from "./index";
import { TestPaneProvider } from "../../../test-support/pane";

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

function Harness({
  instance,
  calls,
  paneHeight = 24,
}: {
  instance?: BrokerInstanceConfig;
  calls: string[];
  paneHeight?: number;
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
    <TestPaneProvider state={state} dispatch={dispatch} paneId="brokers:test" pluginId="broker" runtime={runtime}>
      <BrokersPane focused width={92} height={paneHeight} />
    </TestPaneProvider>
  );
}

function FooterHarness({
  height = 25,
  ...props
}: {
  instance?: BrokerInstanceConfig;
  calls: string[];
  height?: number;
}) {
  return (
    <PaneFooterProvider>
      {(footer) => (
        <Box width={92} height={height} flexDirection="column">
          <Harness {...props} paneHeight={height - 1} />
          <PaneFooterBar footer={footer} focused width={92} />
          <PaneFooterKeys paneId="brokers:test" footer={footer} focused />
        </Box>
      )}
    </PaneFooterProvider>
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
    testSetup = await testRender(<FooterHarness calls={calls} instance={createGatewayInstance()} height={35} />, { width: 92, height: 35 });
    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    let frame = testSetup.captureCharFrame();
    expect(frame).toContain("PROFILE");
    expect(frame).toContain("STATUS");
    expect(frame).toContain("ACCOUNTS");
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
    testSetup = await testRender(<FooterHarness calls={calls} instance={instance} height={35} />, { width: 92, height: 35 });
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
});
