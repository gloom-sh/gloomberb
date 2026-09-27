import { expect, test } from "bun:test";
import type { BrokerAdapter } from "../types/broker";
import { brokerMethodLabel, buildBrokerDirectory } from "./directory";
import type { SignedInBroker } from "./signed-in/client";

function adapter(id: string, name: string, configurable = true): BrokerAdapter {
  return {
    id,
    name,
    configSchema: configurable ? [{ key: "token", label: "Token", type: "password", required: true }] : [],
    validate: async () => true,
    importPositions: async () => [],
  };
}

function signedIn(id: string, name: string): SignedInBroker {
  return { id, name, capabilities: { history: true, executions: true, orders: false, singleConnection: false } };
}

test("one broker offered both ways is one entry, signing in first, and labels say which way", () => {
  const directory = buildBrokerDirectory({
    signedIn: [signedIn("ibkr", "Interactive Brokers"), signedIn("robinhood", "Robinhood")],
    adapters: [adapter("ibkr", "Interactive Brokers"), adapter("tradier", "Tradier"), adapter("signed-in", "Signed-in broker", false)],
  });

  expect(directory.map((entry) => [entry.key, entry.methods.map((method) => method.kind)])).toEqual([
    ["ibkr", ["signed-in", "device"]],
    ["robinhood", ["signed-in"]],
    ["tradier", ["device"]],
  ]);
  const [ibkr, robinhood, tradier] = directory;
  expect(ibkr!.methods.map((method) => brokerMethodLabel(ibkr!, method))).toEqual([
    "Sign in (recommended)",
    "On this device (Interactive Brokers)",
  ]);
  expect(brokerMethodLabel(robinhood!, robinhood!.methods[0]!)).toBe("Sign in");
  expect(brokerMethodLabel(tradier!, tradier!.methods[0]!)).toBe("Tradier");
});

test("lists installed brokers alone before the connector list loads or where signing in is unavailable", () => {
  const installedOnly = [{ key: "ibkr", name: "Interactive Brokers", methods: [{ kind: "device", adapter: expect.anything() }] }];
  const signedInAdapter = adapter("signed-in", "Signed-in broker", false);
  expect(buildBrokerDirectory({ signedIn: [], adapters: [adapter("ibkr", "Interactive Brokers"), signedInAdapter] }))
    .toEqual(installedOnly);
  expect(buildBrokerDirectory({ signedIn: [signedIn("ibkr", "Interactive Brokers")], adapters: [adapter("ibkr", "Interactive Brokers")] }))
    .toEqual(installedOnly);
});
