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

function addBrokerRoute(): CommandBarWorkflowRoute {
  const route = buildBrokerWorkflowRoute({
    directory: buildBrokerDirectory({
      signedIn: [signedIn("ibkr", "Interactive Brokers"), signedIn("robinhood", "Robinhood")],
      adapters: [ibkrDevice, signedInBrokerAdapter],
    }),
    selectorKey: "brokerType",
    title: "Add Broker Account",
    subtitle: undefined,
    submitLabel: "Connect Broker",
    includeManualOption: false,
  });
  if (!route) throw new Error("expected a route");
  return route;
}

function view(route: CommandBarWorkflowRoute, values: Record<string, string>) {
  const next = { ...route, values: { ...route.values, ...values } };
  return {
    fields: getVisibleWorkflowFields(next.fields, next.values).map((field) => field.id),
    submitLabel: getWorkflowSubmitLabel(next),
    selection: resolveBrokerWorkflowSelection(next, "brokerType"),
  };
}

test("a broker offered both ways asks for the method, and only the device method asks for its fields", () => {
  const route = addBrokerRoute();

  const signIn = view(route, { brokerType: "ibkr" });
  expect(signIn.fields).toEqual(["brokerType", "method:ibkr"]);
  expect(signIn.submitLabel).toBe("Connect");
  expect(signIn.selection?.method.kind).toBe("signed-in");

  const device = view(route, { brokerType: "ibkr", "method:ibkr": "device" });
  expect(device.fields).toEqual(["brokerType", "method:ibkr", "ibkr:connectionMode", "ibkr:token"]);
  expect(device.submitLabel).toBe("Connect Broker");
  expect(device.selection?.method).toEqual({ kind: "device", adapter: ibkrDevice });
});

test("a broker offered only by signing in has nothing to fill in", () => {
  const robinhood = view(addBrokerRoute(), { brokerType: "robinhood" });
  expect(robinhood.fields).toEqual(["brokerType"]);
  expect(robinhood.submitLabel).toBe("Connect");
  expect(robinhood.selection?.method).toEqual({ kind: "signed-in", broker: signedIn("robinhood", "Robinhood") });
});
