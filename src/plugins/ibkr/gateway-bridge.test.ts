import { afterEach, describe, expect, test } from "bun:test";

import { ibkrBroker } from "./broker-adapter";
import {
  GATEWAY_UNAVAILABLE_MESSAGE,
  setIbkrGatewayBridge,
  type IbkrGatewayBridge,
} from "./gateway-bridge";
import type { BrokerInstanceConfig } from "../../types/config";

/**
 * Flex and Gateway are one broker with two connection modes, and they are about
 * to become two plugins. The property that has to hold is that a user with
 * Gateway uninstalled keeps a working Flex profile and gets a direct explanation
 * on a Gateway one — not a crash, and not a profile that silently imports
 * nothing while looking healthy.
 *
 * These run against the real adapter with the bridge unset, which is exactly the
 * state a Flex-only install will be in.
 */

function instance(config: Record<string, unknown>): BrokerInstanceConfig {
  return { id: "inst-1", brokerType: "ibkr", label: "IBKR", config } as BrokerInstanceConfig;
}

const flexProfile = instance({
  connectionMode: "flex",
  flex: { token: "t", queryId: "q" },
  token: "t",
  queryId: "q",
});

const gatewayProfile = instance({
  connectionMode: "gateway",
  gateway: { host: "127.0.0.1", port: 4001, clientId: 1 },
  host: "127.0.0.1",
  port: 4001,
  clientId: 1,
});

afterEach(() => {
  setIbkrGatewayBridge(null);
});

describe("without the Gateway plugin", () => {
  test("a Gateway profile fails validation rather than importing nothing", async () => {
    setIbkrGatewayBridge(null);

    expect(await ibkrBroker.validate!(gatewayProfile)).toBe(false);
  });

  test("a Flex profile still validates", async () => {
    setIbkrGatewayBridge(null);

    expect(await ibkrBroker.validate!(flexProfile)).toBe(true);
  });

  test("status explains what is missing instead of reporting disconnected", () => {
    setIbkrGatewayBridge(null);

    const status = ibkrBroker.getStatus!(gatewayProfile);
    expect(status.state).toBe("error");
    expect(status.message).toBe(GATEWAY_UNAVAILABLE_MESSAGE);
  });

  test("importing from a Gateway profile throws a directed error", async () => {
    setIbkrGatewayBridge(null);

    await expect(ibkrBroker.importPositions!(gatewayProfile))
      .rejects.toThrow(GATEWAY_UNAVAILABLE_MESSAGE);
  });

  test("disconnect and status subscription stay safe no-ops", async () => {
    setIbkrGatewayBridge(null);

    await ibkrBroker.disconnect!(gatewayProfile);
    const unsubscribe = ibkrBroker.subscribeStatus!(gatewayProfile, () => {});
    expect(typeof unsubscribe).toBe("function");
    unsubscribe();
  });

  test("the console profile action is disabled with the reason", () => {
    setIbkrGatewayBridge(null);

    const [action] = ibkrBroker.getProfileActions!(gatewayProfile);
    expect(action?.disabled).toBe(true);
    expect(action?.disabledReason).toBe(GATEWAY_UNAVAILABLE_MESSAGE);
  });
});

describe("with the Gateway plugin registered", () => {
  test("gateway work routes through the bridge", async () => {
    const calls: string[] = [];
    const bridge = {
      refresh: async () => { calls.push("refresh"); },
      getService: () => ({
        getPositions: async () => { calls.push("getPositions"); return []; },
      }),
      removeInstance: async () => { calls.push("removeInstance"); },
      getStatus: () => ({ state: "connected", message: "", updatedAt: 1 }),
      subscribeStatus: () => () => {},
    } as unknown as IbkrGatewayBridge;
    setIbkrGatewayBridge(bridge);

    expect(await ibkrBroker.validate!(gatewayProfile)).toBe(true);
    await ibkrBroker.importPositions!(gatewayProfile);
    expect(calls).toEqual(["refresh", "getPositions"]);
    expect(ibkrBroker.getStatus!(gatewayProfile).state).toBe("connected");
  });
});
