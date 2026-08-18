import { describe, expect, test } from "bun:test";
import { ConnectionHealthRegistry } from "../../core/connection-health";
import type { DataProvider } from "../../types/data-provider";
import { withProviderConnectionHealth } from "./connection-health";

describe("withProviderConnectionHealth", () => {
  test("attributes network calls without reporting cached or static checks", async () => {
    const health = new ConnectionHealthRegistry();
    health.registerSource({ id: "asset-data.yahoo", name: "Yahoo", kind: "asset-data" });
    const provider = withProviderConnectionHealth({
      id: "yahoo",
      name: "Yahoo",
      canProvide: () => true,
      getCachedFinancialsForTargets: () => new Map(),
      getChartResolutionSupport: () => [],
      getQuote: async () => ({ price: 1 }),
    } as unknown as DataProvider, health);

    await provider.canProvide?.("AAPL");
    provider.getCachedFinancialsForTargets?.([]);
    await provider.getChartResolutionSupport?.("AAPL");
    await provider.getQuote("AAPL");

    const state = health.getSnapshot().sources[0]!;
    expect(state.lastOperation).toBe("getQuote");
    expect(state.recentRequests).toHaveLength(1);
  });
});
