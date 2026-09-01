import { afterEach, describe, expect, test } from "bun:test";
import type { BrokerInstanceConfig } from "../../types/config";
import {
  getIbkrPortfolioPerformance,
  setIbkrPortfolioPerformanceResourceStore,
} from "./portfolio-performance";

function createGatewayInstance(): BrokerInstanceConfig {
  return {
    id: "ibkr-live",
    brokerType: "ibkr",
    label: "IBKR Live",
    connectionMode: "gateway",
    enabled: true,
    config: {
      connectionMode: "gateway",
      gateway: { host: "127.0.0.1", port: 4001, clientId: 1 },
    },
  };
}

afterEach(() => {
  setIbkrPortfolioPerformanceResourceStore(null);
});

describe("getIbkrPortfolioPerformance", () => {
  test("uses Flex only for historical portfolio performance", async () => {
    const performance = await getIbkrPortfolioPerformance(createGatewayInstance(), "U12345");

    expect(performance).toBeNull();
  });
});
