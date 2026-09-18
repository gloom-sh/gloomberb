import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import { Text } from "../../../ui";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { setSharedRegistryForTests, type PluginRegistry } from "../../registry";
import type { SeriesCatalogSearchResult } from "./use-series-catalog";
import { useSeriesCatalogSuggestions } from "./use-series-catalog";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
let latest: SeriesCatalogSearchResult | null = null;

function Harness({ query }: { query: string }) {
  latest = useSeriesCatalogSuggestions({
    query,
    defaultInstrument: { symbol: "AAPL" },
    enabled: true,
  });
  return <Text>{latest.suggestions.map((entry) => entry.label).join(" | ")}</Text>;
}

function installRegistry(options: { pluginDelayMs: number; pluginItems: number }) {
  const marketData = createTestDataProvider({
    search: async () => [
      { providerId: "test", symbol: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", type: "EQUITY" },
      { providerId: "test", symbol: "APLE", name: "Apple Hospitality REIT", exchange: "NYSE", type: "EQUITY" },
    ],
  });
  const registry = {
    marketData,
    capabilityManifests: (kind?: string) => kind === "chart-series" || kind === undefined
      ? [{ id: "prediction-markets.series", kind: "chart-series", name: "Prediction Markets", operations: [] }]
      : [],
    invokeCapability: async (_capabilityId: string, _operationId: string, payload: unknown) => {
      await Bun.sleep(options.pluginDelayMs);
      const limit = (payload as { limit: number }).limit;
      return Array.from({ length: Math.min(limit, options.pluginItems) }, (_, index) => ({
        seriesId: `polymarket/event/${index}`,
        label: `Will Apple ship thing ${index}?`,
        detail: "Polymarket",
      }));
    },
  } as unknown as PluginRegistry;
  setSharedRegistryForTests(registry);
}

async function settle(ms: number) {
  await act(async () => {
    await Bun.sleep(ms);
    await testSetup!.renderOnce();
  });
}

afterEach(async () => {
  setSharedRegistryForTests(undefined);
  latest = null;
  if (!testSetup) return;
  await act(async () => {
    testSetup!.renderer.destroy();
  });
  testSetup = undefined;
});

describe("useSeriesCatalogSuggestions", () => {
  test("lists securities first and appends late plugin catalogs without moving them", async () => {
    installRegistry({ pluginDelayMs: 200, pluginItems: 8 });
    testSetup = await testRender(<Harness query="apple" />, { width: 120, height: 4 });

    // Ticker search settles first (80ms debounce); plugin catalogs are still pending.
    await settle(150);
    const early = latest!.suggestions.map((entry) => entry.label);
    expect(early[0]).toMatch(/^AAPL(:\w+)? · Price/);
    expect(early.some((label) => label.startsWith("Will Apple"))).toBe(false);
    expect(latest!.loading).toBe(true);

    await settle(400);
    const late = latest!.suggestions.map((entry) => entry.label);
    expect(late.slice(0, early.length)).toEqual(early);
    expect(late.length).toBe(8);
    expect(late.at(-1)).toMatch(/^Will Apple/);
    expect(latest!.loading).toBe(false);
  });

  test("a full plugin catalog never crowds out the securities", async () => {
    installRegistry({ pluginDelayMs: 0, pluginItems: 8 });
    testSetup = await testRender(<Harness query="apple" />, { width: 120, height: 4 });

    await settle(500);
    const labels = latest!.suggestions.map((entry) => entry.label);
    expect(labels[0]).toMatch(/^AAPL(:\w+)? · Price/);
    expect(labels[1]).toMatch(/^APLE(:\w+)? · Price/);
    expect(labels.filter((label) => label.startsWith("Will Apple"))).toHaveLength(6);
  });
});
