import { describe, expect, test } from "bun:test";
import { ApiRequestError } from "../../api-client/errors";
import type { BrokerInstanceConfig } from "../../types/config";
import { createSignedInBrokerAdapter } from "./adapter";
import type { SignedInBroker } from "./client";

const IBKR: SignedInBroker = {
  id: "ibkr",
  name: "Interactive Brokers",
  capabilities: { history: true, executions: false, orders: false, singleConnection: true },
};

// Synced from another device: the broker is only in connectionMode.
const instance: BrokerInstanceConfig = { id: "ibkr-main", brokerType: "signed-in", label: "IBKR", connectionMode: "ibkr", config: {} };

function adapterAnswering(answer: (path: string) => unknown, brokers: SignedInBroker[] = [IBKR]) {
  const requests: string[] = [];
  const adapter = createSignedInBrokerAdapter({
    request: async <T,>(broker: string, path: string) => {
      requests.push(`${broker}${path}`);
      const result = answer(path);
      if (result instanceof Error) throw result;
      return result as T;
    },
    findBroker: (id) => brokers.find((broker) => broker.id === id) ?? null,
    refreshBrokers: async () => {},
    now: () => 1_000,
  });
  return { adapter, requests };
}

describe("signedInBrokerAdapter", () => {
  test("says what to do for each failure and keeps the last result as the profile's status", async () => {
    const cases: Array<[number, string]> = [
      [401, "Sign in to Gloom first, then connect Interactive Brokers."],
      [404, "Interactive Brokers needs you to sign in again. Press Connect in Brokers."],
      [409, "Interactive Brokers needs you to sign in again. Press Connect in Brokers."],
      [502, "Interactive Brokers is not responding. Try again shortly."],
    ];
    for (const [status, message] of cases) {
      const { adapter, requests } = adapterAnswering(() => new ApiRequestError("upstream", status));
      let notified = 0;
      adapter.subscribeStatus!(instance, () => { notified += 1; });
      await expect(adapter.importPortfolioSnapshot!(instance)).rejects.toThrow(message);
      expect(requests).toEqual(["ibkr/snapshot"]);
      expect(adapter.getStatus!(instance)).toEqual({ state: "error", message, mode: "Sign in", updatedAt: 1_000 });
      expect(notified).toBe(1);
    }
  });

  test("a successful call marks the profile connected, and an unsupported route is an empty answer", async () => {
    const { adapter } = adapterAnswering((path) => path === "/snapshot"
      ? { accounts: [{ accountId: "U123", name: "U123", source: "cloud" }], positions: [], fetchedAt: 1 }
      : new ApiRequestError("unsupported", 422));
    expect(adapter.getStatus!(instance).state).toBe("disconnected");
    expect(await adapter.listAccounts!(instance)).toEqual([{ accountId: "U123", name: "U123", source: "cloud" }]);
    expect(await adapter.listExecutions!(instance)).toEqual([]);
    expect(adapter.getStatus!(instance)).toMatchObject({ state: "connected", mode: "Sign in" });
  });

  test("falls back to the profile label while the connector list is unknown", async () => {
    const { adapter } = adapterAnswering(() => new ApiRequestError("gone", 502), []);
    expect(adapter.describeInstance!(instance)).toEqual({ brokerName: "IBKR", method: "Sign in" });
    expect(adapter.portfolioBrokerId!(instance)).toBe("ibkr");
    await expect(adapter.importPositions(instance)).rejects.toThrow("IBKR is not responding. Try again shortly.");
  });
});
