import { afterEach, expect, test } from "bun:test";
import type { BrokerAdapter } from "../types/broker";
import type { BrokerInstanceConfig } from "../types/config";
import { createRemoteBrokerAdapter, setBrokerRemoteClient, type BrokerRemoteClient } from "./remote-broker-adapter";
import { createSignedInBrokerAdapter } from "./signed-in/adapter";

const instance: BrokerInstanceConfig = { id: "ibkr-main", brokerType: "signed-in", label: "IBKR", connectionMode: "ibkr", config: {} };

function remoteClient(invoked: string[]): BrokerRemoteClient {
  return {
    invoke: async <T,>(_instanceId: string, operation: string) => {
      invoked.push(operation);
      return { connectionMode: "gateway" } as T;
    },
    getStatus: () => null,
    subscribeStatus: () => () => {},
    subscribeQuotes: () => () => {},
    removeInstance: async () => {},
    destroyAll: async () => {},
  };
}

afterEach(() => setBrokerRemoteClient(null));

test("the desktop wrapper offers the persisted config update only when the adapter has one", async () => {
  const invoked: string[] = [];
  setBrokerRemoteClient(remoteClient(invoked));
  const base: BrokerAdapter = {
    id: "demo",
    name: "Demo",
    configSchema: [],
    validate: async () => true,
    importPositions: async () => [],
  };

  expect(createRemoteBrokerAdapter(base).getPersistedConfigUpdate).toBeUndefined();

  const withUpdate = createRemoteBrokerAdapter({ ...base, getPersistedConfigUpdate: () => null });
  expect(await withUpdate.getPersistedConfigUpdate!(instance)).toEqual({ connectionMode: "gateway" });
  expect(invoked).toEqual(["getPersistedConfigUpdate"]);
});

test("a signed-in profile has no config to persist", async () => {
  expect(await createSignedInBrokerAdapter().getPersistedConfigUpdate!(instance)).toBeNull();
});
