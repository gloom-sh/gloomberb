import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { Box } from "../../../ui";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { testRender } from "../../../renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, createInitialState } from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createDefaultConfig, type BrokerInstanceConfig } from "../../../types/config";
import { PluginRenderProvider } from "../../runtime";
import { testBroker } from "../../../brokers/test-broker";
import { BrokersPane } from "./index";

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
  const config = {
    ...createDefaultConfig("/tmp/gloomberb-broker-manager-pane"),
    brokerInstances: instance ? [instance] : [],
  };
  const state = createInitialState(config);
  if (instance) {
    state.brokerAccounts = {
      [instance.id]: [{
        accountId: "DU12345",
        name: "DU12345",
        currency: "USD",
        netLiquidation: 125000,
        buyingPower: 50000,
      }],
    };
  }
  const runtime = createTestPluginRuntime({
    getBrokerAdapter: (brokerType) => brokerType === "ibkr" ? testBroker : null,
    openCommandBar: (query) => calls.push(`command:${query ?? ""}`),
    showPane: (paneId) => calls.push(`pane:${paneId}`),
    connectBrokerInstance: async (instanceId) => { calls.push(`connect:${instanceId}`); },
    syncBrokerInstance: async (instanceId) => { calls.push(`sync:${instanceId}`); },
    updateBrokerInstance: async (instanceId) => { calls.push(`update:${instanceId}`); },
  });

  return (
    <AppContext value={{ state, dispatch: () => {} }}>
      <PluginRenderProvider pluginId="broker" runtime={runtime}>
        <PaneInstanceProvider paneId="brokers:test">
          <BrokersPane focused width={92} height={paneHeight} />
        </PaneInstanceProvider>
      </PluginRenderProvider>
    </AppContext>
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
        </Box>
      )}
    </PaneFooterProvider>
  );
}

async function pressKey(key: string) {
  await act(async () => {
    testSetup!.mockInput.pressKey(key);
    await Promise.resolve();
    await testSetup!.renderOnce();
    await testSetup!.renderOnce();
  });
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
});
