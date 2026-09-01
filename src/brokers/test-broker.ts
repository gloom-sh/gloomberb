import type { BrokerAdapter } from "../types/broker";

/**
 * A stand-in broker for tests of the generic broker machinery.
 *
 * These tests used to reach for the real IBKR adapter, which now lives in its
 * own repository. Depending on a plugin to exercise host code is backwards
 * anyway: it made a core test fail whenever that plugin's schema changed, and
 * it hid which behaviour was actually under test.
 *
 * The shape mirrors what the machinery has to handle — a mode switch, a nested
 * config, and a password field that must survive an edit left blank.
 */
export const testBroker: BrokerAdapter = {
  id: "test-broker",
  name: "Test Broker",
  configSchema: [
    {
      key: "connectionMode",
      label: "Connection",
      type: "select",
      options: [
        { value: "token", label: "Token" },
        { value: "local", label: "Local" },
      ],
      defaultValue: "token",
    },
    { key: "token", label: "API Token", type: "password", required: true, visibleWhen: { connectionMode: "token" } },
    { key: "accountId", label: "Account", type: "text", required: true, visibleWhen: { connectionMode: "token" } },
    { key: "host", label: "Host", type: "text", defaultValue: "127.0.0.1", visibleWhen: { connectionMode: "local" } },
  ],

  async validate() {
    return true;
  },

  async importPositions() {
    return [];
  },

  getStatus() {
    return { state: "disconnected", message: "", updatedAt: 0 };
  },

  getProfileActions() {
    // The pane renders and invokes profile actions; one is enough to cover that.
    return [{ id: "test-console", label: "Console", paneId: "ibkr-trading" }];
  },

  toConfigValues(instance) {
    const config = instance.config as Record<string, unknown>;
    const credentials = (config.credentials ?? {}) as Record<string, unknown>;
    return {
      connectionMode: String(config.connectionMode ?? "token"),
      token: String(credentials.token ?? ""),
      accountId: String(credentials.accountId ?? ""),
      host: String(config.host ?? "127.0.0.1"),
    };
  },

  fromConfigValues(values) {
    return {
      connectionMode: values.connectionMode,
      credentials: { token: values.token, accountId: values.accountId },
      host: values.host,
    };
  },
};
