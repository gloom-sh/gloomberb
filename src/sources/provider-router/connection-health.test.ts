import { describe, expect, test } from "bun:test";
import { ConnectionHealthRegistry } from "../../core/connection-health";
import type { DataProvider } from "../../types/data-provider";
import { withProviderConnectionHealth } from "./connection-health";

describe("withProviderConnectionHealth", () => {
  test("attributes provider calls without reporting cache reads", async () => {
    const health = new ConnectionHealthRegistry();
    health.registerSource({ id: "asset-data.yahoo", name: "Yahoo", kind: "asset-data" });
    const provider = withProviderConnectionHealth({
      id: "yahoo",
      name: "Yahoo",
      getCachedFinancialsForTargets: () => new Map(),
      getQuote: async () => ({ price: 1 }),
    } as unknown as DataProvider, health);

    provider.getCachedFinancialsForTargets?.([]);
    await provider.getQuote("AAPL");

    const state = health.getSnapshot().sources[0]!;
    expect(state.lastOperation).toBe("getQuote");
    expect(state.recentRequests).toHaveLength(1);
  });
});
