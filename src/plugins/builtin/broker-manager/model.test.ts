import { describe, expect, test } from "bun:test";
import type { BrokerAdapter } from "../../../types/broker";
import { createDefaultConfig, type BrokerInstanceConfig } from "../../../types/config";
import { testBroker } from "../../../test-support/broker";
import { buildBrokerProfileRows } from "./model";

function createInstance(patch: Partial<BrokerInstanceConfig> = {}): BrokerInstanceConfig {
  return {
    id: "demo-live",
    brokerType: "demo",
    label: "Demo Live",
    connectionMode: "gateway",
    config: { connectionMode: "gateway" },
    enabled: true,
    ...patch,
  };
}

function createAdapter(state: "connected" | "error" = "connected"): BrokerAdapter {
  return {
    id: "demo",
    name: "Demo Broker",
    configSchema: [],
    validate: async () => true,
    importPositions: async () => [],
    getStatus: () => ({ state, updatedAt: 1_000_000, message: state === "error" ? "No route" : "Ready" }),
  };
}

describe("broker manager rows", () => {
  test("derives live status and account summary", () => {
    const config = {
      ...createDefaultConfig("/tmp/gloomberb-broker-manager"),
      brokerInstances: [createInstance({ lastSyncedAt: 900_000 })],
    };
    const rows = buildBrokerProfileRows(
      config,
      new Map([["demo", createAdapter()]]),
      {
        "demo-live": [
          { accountId: "DU1", name: "DU1", currency: "USD", netLiquidation: 100 },
          { accountId: "DU2", name: "DU2", currency: "USD", netLiquidation: 50 },
        ],
      },
    );

    expect(rows[0]).toMatchObject({
      id: "demo-live",
      brokerName: "Demo Broker",
      state: "connected",
      stateLabel: "Connected",
      accountSummary: "$150.00",
      lastSyncedAt: 900_000,
    });
  });

  test("a missing currency stays blank, and an explicit code still sums", () => {
    const config = {
      ...createDefaultConfig("/tmp/gloomberb-broker-manager"),
      brokerInstances: [createInstance()],
    };
    const summary = (accounts: Array<{ accountId: string; name: string; currency?: string; netLiquidation: number }>) =>
      buildBrokerProfileRows(config, new Map([["demo", createAdapter()]]), { "demo-live": accounts })[0]?.accountSummary;
    expect(summary([
      { accountId: "A", name: "A", netLiquidation: 100 },
      { accountId: "B", name: "B", netLiquidation: 50 },
    ])).toBe("150.00");
    expect(summary([
      { accountId: "A", name: "A", currency: "EUR", netLiquidation: 100 },
      { accountId: "B", name: "B", currency: "EUR", netLiquidation: 50 },
    ])).toBe("€150.00");
    expect(summary([
      { accountId: "A", name: "A", netLiquidation: 100 },
      { accountId: "B", name: "B", currency: "USD", netLiquidation: 50 },
    ])).toBe("2 accts");
  });

  test("uses generated portfolio sync time when the profile has no direct timestamp", () => {
    const config = {
      ...createDefaultConfig("/tmp/gloomberb-broker-manager"),
      portfolios: [{
        id: "broker:demo-live:DU1",
        name: "DU1",
        currency: "USD",
        brokerId: "demo",
        brokerInstanceId: "demo-live",
        brokerAccountId: "DU1",
        lastSyncedAt: 750_000,
      }],
      brokerInstances: [createInstance()],
    };
    const rows = buildBrokerProfileRows(config, new Map([["demo", createAdapter()]]), {});

    expect(rows[0]?.lastSyncedAt).toBe(750_000);
  });

  test("falls back to cached account update time for older configs", () => {
    const config = {
      ...createDefaultConfig("/tmp/gloomberb-broker-manager"),
      brokerInstances: [createInstance()],
    };
    const rows = buildBrokerProfileRows(
      config,
      new Map([["demo", createAdapter()]]),
      {
        "demo-live": [
          { accountId: "DU1", name: "DU1", currency: "USD", updatedAt: 650_000 },
        ],
      },
    );

    expect(rows[0]?.lastSyncedAt).toBe(650_000);
  });

  test("handles disabled and unavailable profiles before adapter status", () => {
    const config = {
      ...createDefaultConfig("/tmp/gloomberb-broker-manager"),
      brokerInstances: [
        createInstance({ id: "disabled", enabled: false }),
        createInstance({ id: "missing", brokerType: "missing" }),
      ],
    };
    const rows = buildBrokerProfileRows(config, new Map([["demo", createAdapter("error")]]), {});

    expect(rows.map((row) => row.state)).toEqual(["disabled", "unavailable"]);
  });

  test("keeps real IBKR Flex profiles out of gateway status", () => {
    const config = {
      ...createDefaultConfig("/tmp/gloomberb-broker-manager"),
      brokerInstances: [{
        id: "ibkr-flex",
        brokerType: "ibkr",
        label: "IBKR Flex",
        connectionMode: "flex",
        config: {
          connectionMode: "flex",
          flex: { token: "token", queryId: "123", endpoint: "" },
          gateway: { host: "127.0.0.1" },
        },
        enabled: true,
      }],
    };
    const rows = buildBrokerProfileRows(config, new Map([["ibkr", testBroker]]), {});

    expect(rows[0]?.mode).toBe("Flex");
    expect(rows[0]?.stateLabel).toBe("Sync only");
  });
});
