import { afterEach, describe, expect, test } from "bun:test";
import { createChartSeriesResolver } from "../../capabilities";
import { AppPersistence } from "../../data/app-persistence";
import { TickerRepository } from "../../data/ticker-repository";
import { SERIES_CATALOG_CAPABILITY_ID } from "../../series/capability";
import type { SeriesCatalogEntry, SeriesLoadRequest } from "../../series/types";
import { createTestDataProvider } from "../../test-support/data-provider";
import { createDefaultConfig } from "../../types/config";
import type { GloomPlugin } from "../../types/plugin";
import { PluginRegistry } from "./index";

const VIEWPORT = { range: "1Y", resolution: "auto" } as const;
let cleanup: Array<() => void> = [];

function createRegistry(options: { disabledPlugins?: string[]; remote?: boolean } = {}) {
  const persistence = new AppPersistence(":memory:");
  const remoteCalls: string[] = [];
  const registry = new PluginRegistry(createTestDataProvider(), new TickerRepository(persistence.tickers), persistence, options.remote ? {
    enableCapabilityHandlers: false,
    remoteCapabilityInvoke: async <T,>(capabilityId: string, operationId: string) => {
      remoteCalls.push(`${capabilityId}.${operationId}`);
      return { remote: true } as T;
    },
  } : {});
  registry.bindHost({
    getConfig: () => ({ ...createDefaultConfig("/tmp/gloomberb-series-test"), disabledPlugins: options.disabledPlugins ?? [] }),
  });
  cleanup.push(() => { registry.destroy(); persistence.close(); });
  return { registry, remoteCalls };
}

const requests: SeriesLoadRequest[] = [];
const gardenPlugin: GloomPlugin = {
  id: "garden",
  name: "Garden",
  version: "1.0.0",
  hosts: ["api.rainco.example"],
  series: [
    {
      id: "garden:rain", name: "Garden rainfall", unit: "number", frequency: "daily", group: "Garden",
      load: (request) => {
        requests.push(request);
        return [{ date: "2026-01-02", value: 4 }, { date: "2026-01-01", value: 3 }];
      },
    },
    // Names the service the plugin fetches from: skipped, the rest still register.
    { id: "garden:bad", name: "RainCo index", unit: "index", frequency: "daily", load: () => [] },
    { id: "garden:jobless", name: "Jobless rate", unit: "%", frequency: "monthly", expression: "FRED:UNRATE" },
  ],
  setup(ctx) {
    ctx.registerSeries({ id: "garden:soil", name: "Soil moisture", unit: "%", frequency: "daily", input: "ticker", load: ({ ticker }) => [{ date: "2026-01-01", value: ticker === "AAPL" ? 1 : 0 }] });
    expect(() => ctx.registerSeries({ id: "garden:rain", name: "Again", unit: "%", frequency: "daily", load: () => [] })).toThrow(/already registered/);
  },
};

afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  requests.length = 0;
});

describe("plugin series", () => {
  test("a plugin's static and setup series reach the catalog, and resolve through its namespace", async () => {
    const { registry } = createRegistry();
    await registry.register(gardenPlugin);
    expect(registry.series.catalog().map((entry) => entry.id)).toEqual(["garden:rain", "garden:jobless", "garden:soil"]);

    const resolve = createChartSeriesResolver(registry);
    const spec = { id: "s", source: { kind: "capability", capabilityId: "garden", seriesId: "rain" }, style: "line", transform: "raw", axis: "auto", panelId: "main", interpolation: "none" } as const;
    const rain = await resolve(spec.source, VIEWPORT, spec);
    expect(rain.points.map((point) => point.value)).toEqual([3, 4]);
    expect(rain).toMatchObject({ label: "Garden rainfall", unit: "number" });
    expect(requests[0]?.start).toBeInstanceOf(Date);
    const soil = await resolve({ kind: "capability", capabilityId: "garden", seriesId: "soil/AAPL" }, VIEWPORT, spec);
    expect(soil.points[0]!.value).toBe(1);

    // Automation and other processes see the namespace as a capability, and the catalog as one more.
    expect(registry.capabilities.manifests().map((manifest) => manifest.id)).toEqual(expect.arrayContaining(["garden", SERIES_CATALOG_CAPABILITY_ID]));
    const listed = await registry.invokeCapability<{ entries: SeriesCatalogEntry[] }>(SERIES_CATALOG_CAPABILITY_ID, "list", {});
    expect(listed.entries.map((entry) => entry.expression)).toEqual(["CAP:garden:rain", "FRED:UNRATE", "CAP:garden:soil/{ticker}"]);

    registry.unregister("garden");
    expect(registry.series.catalog()).toEqual([]);
    expect(registry.capabilities.get("garden")).toBeUndefined();
  });

  test("a switched-off plugin's series says what to turn on", async () => {
    const { registry } = createRegistry({ disabledPlugins: ["garden"] });
    await registry.register(gardenPlugin);
    await expect(registry.invokeCapability("garden", "resolve", { seriesId: "rain", viewport: VIEWPORT }))
      .rejects.toThrow("Turn on Garden to chart Garden rainfall.");
  });

  test("where capabilities live in another process, a series known here still loads here", async () => {
    const { registry, remoteCalls } = createRegistry({ remote: true });
    await registry.register(gardenPlugin);
    const local = await registry.invokeCapability<{ points: unknown[] }>("garden", "resolve", { seriesId: "rain", viewport: VIEWPORT });
    expect(local.points).toHaveLength(2);
    // One only that process registered (a file in its series folder) goes there.
    expect(await registry.invokeCapability("user", "resolve", { seriesId: "file", viewport: VIEWPORT })).toEqual({ remote: true });
    expect(remoteCalls).toEqual(["user.resolve"]);
    expect(registry.usesRemoteCapabilities).toBe(true);
  });
});
