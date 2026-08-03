import { expect, test } from "bun:test";
import type { BrokerAdapter } from "../../../types/broker";
import { buildBrokerChoices } from "./broker";

function createBroker(id: string, name: string): BrokerAdapter {
  return {
    id,
    name,
    configSchema: [{ key: "apiKey", label: "API key", type: "password", required: true }],
    validate: async () => true,
    importPositions: async () => [],
  };
}

test("shows external brokers as sorted top-level choices", () => {
  const choices = buildBrokerChoices(new Map([
    ["ibkr", createBroker("ibkr", "Interactive Brokers")],
    ["newbroker", createBroker("newbroker", "newbroker")],
  ]));

  expect(choices.map((choice) => choice.id)).toEqual(["ibkr", "newbroker"]);
});
