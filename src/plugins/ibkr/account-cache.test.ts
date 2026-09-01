import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  clearPersistedBrokerAccounts,
  loadPersistedBrokerAccountMap,
  loadPersistedBrokerAccounts,
  persistBrokerAccounts,
} from "../../brokers/account-cache";
import { AppPersistence } from "../../data/app-persistence";
import type { BrokerInstanceConfig } from "../../types/config";
import type { BrokerAccount } from "../../types/trading";
import { ibkrBroker } from "./broker-adapter";

const tempPaths: string[] = [];

function createTempDbPath(name: string): string {
  const path = join(tmpdir(), `gloomberb-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  tempPaths.push(path);
  return path;
}

function createIbkrInstance(connectionMode: "flex" | "gateway", overrides: Partial<BrokerInstanceConfig> = {}): BrokerInstanceConfig {
  return {
    id: overrides.id ?? `ibkr-${connectionMode}`,
    brokerType: "ibkr",
    label: overrides.label ?? `IBKR ${connectionMode}`,
    connectionMode,
    config: connectionMode === "gateway"
      ? { connectionMode, gateway: { host: "127.0.0.1", port: 4002, clientId: 1 } }
      : { connectionMode, flex: { token: "token", queryId: "query" } },
    enabled: true,
    ...overrides,
  };
}

const TEST_ACCOUNTS: BrokerAccount[] = [{
  accountId: "DU12345",
  name: "DU12345",
  currency: "USD",
  source: "gateway",
  updatedAt: 1_717_000_000_000,
  totalCashValue: 125000,
  cashBalances: [{ currency: "USD", quantity: 125000, baseValue: 125000, baseCurrency: "USD" }],
}];

afterEach(() => {
  for (const path of tempPaths.splice(0)) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
});

describe("IBKR account cache", () => {
  test("persists and reloads account snapshots by broker instance", () => {
    const persistence = new AppPersistence(createTempDbPath("ibkr-account-cache"));
    const instance = createIbkrInstance("flex", { id: "ibkr-personal" });

    persistBrokerAccounts(persistence.resources, instance, ibkrBroker, TEST_ACCOUNTS);

    expect(loadPersistedBrokerAccounts(persistence.resources, instance, ibkrBroker)).toEqual(TEST_ACCOUNTS);
    expect(loadPersistedBrokerAccountMap(persistence.resources, [instance], new Map([["ibkr", ibkrBroker]]))).toEqual({
      "ibkr-personal": TEST_ACCOUNTS,
    });

    persistence.close();
  });

  test("drops snapshots whose config fingerprint no longer matches", () => {
    const persistence = new AppPersistence(createTempDbPath("ibkr-account-cache-mismatch"));
    const original = createIbkrInstance("gateway", { id: "ibkr-live" });
    const updated = createIbkrInstance("gateway", {
      id: "ibkr-live",
      config: { connectionMode: "gateway", gateway: { host: "127.0.0.1", port: 4003, clientId: 1 } },
    });

    persistBrokerAccounts(persistence.resources, original, ibkrBroker, TEST_ACCOUNTS);

    expect(loadPersistedBrokerAccounts(persistence.resources, updated, ibkrBroker)).toBeNull();
    expect(persistence.resources.list({
      namespace: "plugin:ibkr",
      kind: "account-snapshot",
      entityKey: "ibkr-live",
    }, {
      allowExpired: true,
      schemaVersion: 1,
    })).toHaveLength(0);

    persistence.close();
  });

  test("clears all persisted snapshots for an IBKR instance", () => {
    const persistence = new AppPersistence(createTempDbPath("ibkr-account-cache-clear"));
    const instance = createIbkrInstance("gateway", { id: "ibkr-live" });

    persistBrokerAccounts(persistence.resources, instance, ibkrBroker, TEST_ACCOUNTS);
    clearPersistedBrokerAccounts(persistence.resources, instance);

    expect(loadPersistedBrokerAccounts(persistence.resources, instance, ibkrBroker)).toBeNull();
    persistence.close();
  });
});
