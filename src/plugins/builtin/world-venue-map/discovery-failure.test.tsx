import { afterEach, expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import type { GeoRequest } from "../../../api-client/geo";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createGeoFixtureRequest } from "../../../test-support/test-fixture-geo";
import { Text } from "../../../ui";
import { setSharedRegistryForTests, type PluginRegistry } from "../../registry";
import { useSeriesCatalogSuggestions } from "../chart-composer/use-series-catalog";
import { createChokepointInstance } from "./chokepoint-chart";
import { createGeoChartSeriesCapability, resolveGeoChartSeries } from "./geo-series";

const failed: GeoRequest = async () => { throw new ApiRequestError("Fixture outage", 503); };
const viewport = { range: "1Y", resolution: "auto" } as const;
const tui = createOpenTuiTestHarness({ width: 100, height: 5 });
afterEach(() => setSharedRegistryForTests(undefined));

test("an index-only alias reports discovery failure while known straits still open", async () => {
  await expect(createChokepointInstance(failed, "SUEZ.TANKER")).rejects.toThrow("Chokepoint search unavailable.");
  expect((await createChokepointInstance(failed, "Strait of Hormuz")).title).toBe("G HORMUZ transits");
  await expect(createChokepointInstance(createGeoFixtureRequest(), "ATLANTIS")).rejects.toThrow("No chokepoint named ATLANTIS.");
});

test("a failed chart lookup cannot masquerade as an unknown series", async () => {
  await expect(resolveGeoChartSeries(failed, "SUEZ.TANKER", viewport)).rejects.toThrow("Map series unavailable.");
  const fixture = createGeoFixtureRequest();
  const direct: GeoRequest = (path, init) => path.startsWith("series?") ? failed(path, init) : fixture(path, init);
  expect((await resolveGeoChartSeries(direct, "chokepoints.suez.transits", viewport)).points.length).toBeGreaterThan(0);
  const dataFailure: GeoRequest = (path, init) => path.startsWith("series?") ? fixture(path, init) : failed(path, init);
  await expect(resolveGeoChartSeries(dataFailure, "SUEZ", viewport)).rejects.toThrow("Fixture outage");
});

test("map search failures reach the shared picker without losing other results and clear on recovery", async () => {
  let offline = true;
  const fixture = createGeoFixtureRequest();
  const capability = createGeoChartSeriesCapability((path, init) => offline ? failed(path, init) : fixture(path, init));
  const registry = {
    marketData: createTestDataProvider({ search: async () => [] }),
    capabilityManifests: () => [capability, { id: "fixture-series", name: "Fixture Series", kind: "chart-series", operations: [] }],
    invokeCapability: async (id: string, _operation: string, input: { query: string; limit: number }, options: { signal?: AbortSignal }) =>
      id === capability.id ? capability.provider.search!({ ...input, signal: options.signal })
        : [{ seriesId: "fixture", label: "Retained result" }],
  } as unknown as PluginRegistry;
  setSharedRegistryForTests(registry);
  function Search({ query }: { query: string }) {
    const result = useSeriesCatalogSuggestions({ query, defaultInstrument: { symbol: "AAPL" }, enabled: true });
    return <Text>{[result.error ?? "No search error", ...result.suggestions.map((item) => item.label)].join(" | ")}</Text>;
  }
  await tui.render(<Search query="suez" />);
  const frame = await tui.waitForFrameToContain("Map Series search unavailable.");
  expect(frame).toContain("Retained result");
  offline = false;
  await tui.render(<Search query="panama" />);
  await tui.waitForFrameToContain("Panama");
  expect(tui.frame()).toContain("No search error");
  expect(tui.frame()).not.toContain("unavailable");
});
