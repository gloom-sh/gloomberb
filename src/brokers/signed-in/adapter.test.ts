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

  test("a sign-in the broker ended shows Gloom's own message, without its error code", async () => {
    const message = "Interactive Brokers needs you to sign in again: Authorization grant has expired, re-authentication required. Reconnect it in Gloom.";
    const shapes = [
      // As the request client builds it: the body in `details`, the code appended to the message.
      new ApiRequestError(`${message} reauth_required`, 409, undefined, "reauth_required", { error: "reauth_required", message }),
      new ApiRequestError(`${message} reauth_required`, 409, undefined, "reauth_required"),
    ];
    for (const error of shapes) {
      const { adapter } = adapterAnswering(() => error);
      await expect(adapter.importPortfolioSnapshot!(instance)).rejects.toThrow(message);
      expect(adapter.getStatus!(instance)).toMatchObject({ state: "error", message });
    }

    // A 409 that says nothing keeps the app's own guidance.
    const { adapter } = adapterAnswering(() => new ApiRequestError("", 409));
    await expect(adapter.importPortfolioSnapshot!(instance)).rejects.toThrow("Interactive Brokers needs you to sign in again. Press Connect in Brokers.");
  });

  test("connect says why the broker ended the sign-in, and still works against a server that does not", async () => {
    const connection = (lastError?: string | null) => ({ status: "reauth_required", ...(lastError === undefined ? {} : { lastError }) });
    const reasons: Array<[ReturnType<typeof connection>, string]> = [
      [connection("invalid_grant: Authorization grant has expired, re-authentication required"), "Interactive Brokers needs you to sign in again: Authorization grant has expired, re-authentication required. Press Connect in Brokers."],
      [connection("The broker refused the refresh."), "Interactive Brokers needs you to sign in again: The broker refused the refresh. Press Connect in Brokers."],
      [connection(null), "Press Connect in Brokers to sign in to Interactive Brokers."],
      [connection(), "Press Connect in Brokers to sign in to Interactive Brokers."],
    ];
    for (const [answer, message] of reasons) {
      const { adapter } = adapterAnswering(() => answer);
      await expect(adapter.connect!(instance)).rejects.toThrow(message);
      expect(adapter.getStatus!(instance)).toMatchObject({ state: "error", message });
    }
  });

  test("a successful call marks the profile connected, and an unsupported route is an empty answer", async () => {
    const { adapter } = adapterAnswering((path) => path === "/snapshot"
      ? { accounts: [{ accountId: "U123", name: "U123", source: "cloud" }], positions: [], fetchedAt: 1 }
      : new ApiRequestError("Interactive Brokers does not support this in Gloom.", 422, undefined, "unsupported"));
    expect(adapter.getStatus!(instance).state).toBe("disconnected");
    expect(await adapter.listAccounts!(instance)).toEqual([{ accountId: "U123", name: "U123", source: "cloud" }]);
    expect(await adapter.listExecutions!(instance)).toEqual([]);
    expect(await adapter.listOpenOrders!(instance)).toEqual([]);
    expect(await adapter.getPortfolioPerformance!(instance, "U123")).toBeNull();
    expect(adapter.getStatus!(instance)).toMatchObject({ state: "connected", mode: "Sign in" });
  });

  test("a broker tool that failed is an error, not an empty answer", async () => {
    const message = "Interactive Brokers could not complete the request.";
    const { adapter } = adapterAnswering(() => new ApiRequestError(message, 422, undefined, "tool_error"));
    await expect(adapter.listOpenOrders!(instance)).rejects.toThrow(message);
    await expect(adapter.listExecutions!(instance)).rejects.toThrow(message);
    await expect(adapter.getPortfolioPerformance!(instance, "U123")).rejects.toThrow(message);
    expect(adapter.getStatus!(instance)).toMatchObject({ state: "error", message });
  });

  test("falls back to the profile label while the connector list is unknown", async () => {
    const { adapter } = adapterAnswering(() => new ApiRequestError("gone", 502), []);
    expect(adapter.describeInstance!(instance)).toEqual({ brokerName: "IBKR", method: "Sign in" });
    expect(adapter.portfolioBrokerId!(instance)).toBe("ibkr");
    await expect(adapter.importPositions(instance)).rejects.toThrow("IBKR is not responding. Try again shortly.");
  });
});
