import { describe, expect, test } from "bun:test";
import type { BrokerAdapter } from "../types/broker";
import type { BrokerInstanceConfig } from "../types/config";
import { testBroker } from "./test-broker";
import {
  buildBrokerProfileConfig,
  createBrokerProfileDraft,
  validateBrokerProfileValues,
} from "./profile-form";

function createSavedInstance(): BrokerInstanceConfig {
  return {
    id: "saved-profile",
    brokerType: "test-broker",
    label: "Saved Profile",
    connectionMode: "token",
    config: {
      connectionMode: "token",
      credentials: { token: "saved-token", accountId: "123" },
      host: "127.0.0.1",
    },
    enabled: true,
  };
}

describe("broker profile form helpers", () => {
  test("builds a nested broker config from flat form values", () => {
    const config = buildBrokerProfileConfig(testBroker, {
      connectionMode: "token",
      token: "token",
      accountId: "456",
      host: "",
    });

    expect(config).toMatchObject({
      connectionMode: "token",
      credentials: { token: "token", accountId: "456" },
    });
  });

  test("preserves saved password fields when editing leaves them blank", () => {
    const previous = createSavedInstance();
    const draft = createBrokerProfileDraft(testBroker, previous);
    draft.values.token = "";

    expect(validateBrokerProfileValues(testBroker, draft.values, previous)).toBeNull();
    expect(buildBrokerProfileConfig(testBroker, draft.values, previous)).toMatchObject({
      credentials: { token: "saved-token" },
    });
  });

  test("requires password fields for new profiles", () => {
    expect(validateBrokerProfileValues(testBroker, {
      connectionMode: "token",
      token: "",
      accountId: "123",
    })).toBe("API Token is required.");
  });

  test("falls back to raw values for generic brokers", () => {
    const adapter: BrokerAdapter = {
      id: "demo",
      name: "Demo",
      configSchema: [{ key: "apiKey", label: "API Key", type: "password", required: true }],
      validate: async () => true,
      importPositions: async () => [],
    };

    expect(buildBrokerProfileConfig(adapter, { apiKey: "secret" })).toEqual({ apiKey: "secret" });
  });
});
