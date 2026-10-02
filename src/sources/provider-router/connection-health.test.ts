import { describe, expect, test } from "bun:test";
import { ConnectionHealthRegistry } from "../../core/connection-health";
import { withProviderConnectionHealth } from "./connection-health";
import { createTestDataProvider, createTestQuote } from "../../test-support/data-provider";

describe("withProviderConnectionHealth", () => {
  test("attributes network calls without reporting cached or static checks", async () => {
    const health = new ConnectionHealthRegistry();
    health.registerSource({ id: "asset-data.gloom", name: "Gloom", kind: "asset-data" });
    const provider = withProviderConnectionHealth(createTestDataProvider({
      id: "gloom",
      name: "Gloom",
      canProvide: () => true,
      getCachedFinancialsForTargets: () => new Map(),
      getChartResolutionSupport: () => [],
      getQuote: async () => createTestQuote({ price: 1 }),
    }), health);

    await provider.canProvide?.("AAPL");
    provider.getCachedFinancialsForTargets?.([]);
    await provider.getChartResolutionSupport?.("AAPL");
    await provider.getQuote("AAPL");

    const state = health.getSnapshot().sources[0]!;
    expect(state.lastOperation).toBe("getQuote");
    expect(state.recentRequests).toHaveLength(1);
  });
});
