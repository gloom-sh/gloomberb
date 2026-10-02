import { expect, test } from "bun:test";
import { buildBrokerDirectory } from "../../../brokers/directory";
import { signedInBrokerAdapter } from "../../../brokers/signed-in/adapter";
import type { SignedInBroker } from "../../../brokers/signed-in/client";
import type { BrokerAdapter } from "../../../types/broker";
import { buildBrokerWorkflowRoute, resolveBrokerWorkflowSelection } from "./broker";
import { getVisibleWorkflowFields, getWorkflowSubmitLabel } from "./fields";
import type { CommandBarWorkflowRoute } from "./types";

const ibkrDevice: BrokerAdapter = {
  id: "ibkr",
  name: "Interactive Brokers",
  configSchema: [
    {
      key: "connectionMode",
      label: "Connection Mode",
      type: "select",
      required: true,
      options: [{ label: "Flex", value: "flex" }, { label: "Gateway", value: "gateway" }],
    },
    { key: "token", label: "Flex Token", type: "password", required: true, dependsOn: { key: "connectionMode", value: "flex" } },
  ],
  validate: async () => true,
  importPositions: async () => [],
};

function signedIn(id: string, name: string): SignedInBroker {
  return { id, name, capabilities: { history: true, executions: true, orders: false, singleConnection: true } };
}

function newPortfolioRoute(adapters: BrokerAdapter[] = [ibkrDevice, signedInBrokerAdapter]): CommandBarWorkflowRoute {
  return buildBrokerWorkflowRoute({
    directory: buildBrokerDirectory({
      signedIn: [signedIn("ibkr", "Interactive Brokers"), signedIn("robinhood", "Robinhood")],
      adapters,
    }),
    title: "New Portfolio",
    subtitle: undefined,
    submitLabel: "Create Portfolio",
  });
}

function view(route: CommandBarWorkflowRoute, values: Record<string, string>) {
  const next = { ...route, values: { ...route.values, ...values } };
  return {
    fields: getVisibleWorkflowFields(next.fields, next.values).map((field) => field.id),
    submitLabel: getWorkflowSubmitLabel(next),
    selection: resolveBrokerWorkflowSelection(next),
  };
}

test("a broker offered both ways asks for the method, and only the device method asks for its fields", () => {
  const route = newPortfolioRoute();

  const signIn = view(route, { source: "ibkr" });
  expect(signIn.fields).toEqual(["source", "method:ibkr"]);
  expect(signIn.submitLabel).toBe("Connect");
  expect(signIn.selection?.method.kind).toBe("signed-in");

  const device = view(route, { source: "ibkr", "method:ibkr": "device" });
  expect(device.fields).toEqual(["source", "method:ibkr", "ibkr:connectionMode", "ibkr:token"]);
  expect(device.submitLabel).toBe("Create Portfolio");
  expect(device.selection?.method).toEqual({ kind: "device", adapter: ibkrDevice });
});

test("the source list names each broker and says how it connects", () => {
  const route = newPortfolioRoute([ibkrDevice, { ...ibkrDevice, id: "simplefin", name: "SimpleFIN" }, signedInBrokerAdapter]);
  const source = route.fields.find((field) => field.id === "source");
  expect(source?.type === "select" ? source.options.map(({ label, description }) => [label, description]) : null).toEqual([
    ["Manual", "Add tickers and positions by hand"],
    ["Interactive Brokers", "Sign in, or on this device"],
    ["Robinhood", "Sign in"],
    ["SimpleFIN", "On this device"],
  ]);
});

test("a broker offered only by signing in has nothing to fill in", () => {
  const robinhood = view(newPortfolioRoute(), { source: "robinhood" });
  expect(robinhood.fields).toEqual(["source"]);
  expect(robinhood.submitLabel).toBe("Connect");
  expect(robinhood.selection?.method).toEqual({ kind: "signed-in", broker: signedIn("robinhood", "Robinhood") });
});
