import { describe, expect, test } from "bun:test";
import { createDefaultConfig, type AppConfig, type BrokerInstanceConfig } from "../../types/config";
import type { SignedInBroker } from "./client";
import { connectSignedInBrokerProfile } from "./connect";

const IBKR: SignedInBroker = {
  id: "ibkr",
  name: "Interactive Brokers",
  capabilities: { history: true, executions: true, orders: false, singleConnection: true },
};

function harness(existing: BrokerInstanceConfig[], connected: boolean) {
  let config: AppConfig = { ...createDefaultConfig("/tmp/gloomberb-signed-in-connect"), brokerInstances: existing };
  const calls: string[] = [];
  const connect = () => connectSignedInBrokerProfile(IBKR, {
    getConfig: () => config,
    requestSignIn: async (broker) => {
      calls.push(`dialog:${broker.id}`);
      return connected;
    },
    createBrokerInstance: async (brokerType, label, values) => {
      const instance: BrokerInstanceConfig = {
        id: `${brokerType}-new`,
        brokerType,
        label,
        connectionMode: String(values.connectionMode),
        config: values,
        enabled: true,
      };
      calls.push(`create:${instance.id}`);
      config = { ...config, brokerInstances: [...config.brokerInstances, instance] };
      return instance;
    },
    syncBrokerInstance: async (instanceId) => {
      calls.push(`sync:${instanceId}`);
      return instanceId;
    },
  });
  return { calls, connect, getConfig: () => config };
}

describe("connectSignedInBrokerProfile", () => {
  test("creates the profile after the dialog connects, naming the broker so a synced copy works elsewhere", async () => {
    const { calls, connect, getConfig } = harness([], true);
    expect(await connect()).toMatchObject({ instance: { id: "signed-in-new" }, synced: "signed-in-new" });
    expect(calls).toEqual(["dialog:ibkr", "create:signed-in-new", "sync:signed-in-new"]);
    expect(getConfig().brokerInstances[0]).toMatchObject({
      brokerType: "signed-in",
      label: "Interactive Brokers",
      connectionMode: "ibkr",
      config: { connectionMode: "ibkr", broker: "ibkr" },
    });
  });

  test("creates and syncs nothing when the dialog is dismissed", async () => {
    const { calls, connect } = harness([], false);
    expect(await connect()).toBeNull();
    expect(calls).toEqual(["dialog:ibkr"]);
  });

  test("syncs the profile this device already has instead of adding a second", async () => {
    // A profile that arrived by cloud sync carries connectionMode but no config.
    const synced: BrokerInstanceConfig = { id: "ibkr-main", brokerType: "signed-in", label: "IBKR", connectionMode: "ibkr", config: {} };
    const { calls, connect, getConfig } = harness([synced], true);
    expect((await connect())?.instance.id).toBe("ibkr-main");
    expect(calls).toEqual(["dialog:ibkr", "sync:ibkr-main"]);
    expect(getConfig().brokerInstances).toHaveLength(1);
  });
});
