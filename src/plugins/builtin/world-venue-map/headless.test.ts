import { afterEach, expect, test } from "bun:test";
import { resetGeoCatalogCache } from "../../../api-client/geo";
import { createTestHeadlessArgs, createTestHeadlessContext, createTestTemplateContext } from "../../../test-support/headless";
import { createGeoFixtureRequest } from "../../../test-support/test-fixture-geo";
import type { HeadlessPaneContext } from "../../../types/headless";
import { mapHeadless } from "./headless";
import { worldVenueMapModule } from "./index";
import { buildMapSettingsDef, HOME_AREA_SETTING_KEY } from "./layers";

afterEach(() => resetGeoCatalogCache());

const apiClient = { geo: createGeoFixtureRequest() } as unknown as HeadlessPaneContext["apiClient"];

test("a layer's entity table reports plain values and its linked tickers", async () => {
  const result = await mapHeadless.load(
    createTestHeadlessArgs({ options: { layer: "chokepoints", query: "strait", limit: 100 } }),
    createTestHeadlessContext({ apiClient }),
  );
  expect(result.columns?.map((column) => column.key)).toEqual([
    "label", "transits", "transits7dAvg", "transitsChgPct", "tankers7dAvg", "containers7dAvg", "dryBulk7dAvg", "capacityT7dAvg", "lastDay",
    "ticker", "lon", "lat",
  ]);
  const hormuz = result.rows.find((row) => row.label === "Strait of Hormuz")!;
  expect(hormuz.transits).toBe(4);
  // Percentage points stay plain numbers: -13.6 is -13.6%.
  expect(hormuz.transitsChgPct).toBe(-13.6);
  expect(hormuz.ticker).toBe("XOM:XNYS");
  expect(hormuz.tickers).toBe("XOM:XNYS, CVX:XNYS, FRO:XNYS");
  expect(result.rows.every((row) => String(row.label).includes("Strait"))).toBe(true);
  expect(result.metadata).toMatchObject({ layer: "chokepoints", cadence: "daily", status: "ok" });
});

test("a group typed after MAP opens its layers, and an unknown layer names the known ones", async () => {
  const template = worldVenueMapModule.paneTemplates!.find((entry) => entry.id === "world-venue-map-pane")!;
  expect(await template.createInstance!(createTestTemplateContext(), { arg: "energy" })).toMatchObject({ settings: { layers: ["energy"], venues: false } });
  expect(await template.createInstance!(createTestTemplateContext(), {})).toEqual({ placement: "floating" });

  const energy = await mapHeadless.load(createTestHeadlessArgs({ options: { limit: 5 } }), createTestHeadlessContext({ apiClient, settings: { layers: ["energy"] } }));
  expect(energy.metadata).toMatchObject({ layer: "pipelines", otherLayers: ["oil-gas-fields", "terminals"] });
  await expect(mapHeadless.load(createTestHeadlessArgs({ options: { layer: "ufo" } }), createTestHeadlessContext({ apiClient })))
    .rejects.toThrow('No map layer "ufo". Layers: chokepoints, ports, airports');
});

test("a layer reports the status its cadence implies, and a layer that cannot serve claims none", async () => {
  const freshness = async (layer: string) => (
    await mapHeadless.load(createTestHeadlessArgs({ options: { layer } }), createTestHeadlessContext({ apiClient }))
  ).freshness;
  expect(await freshness("vessels")).toEqual({ status: "live" });
  expect(await freshness("chokepoints")).toMatchObject({ status: "not-a-feed", basis: "daily data" });
  expect(await freshness("airports")).toMatchObject({ status: "not-a-feed", basis: "reference data" });
  // An unavailable live layer has no rows to call live; its error says why.
  expect(await freshness("flights")).toBeUndefined();
});

test("a new map keeps only the place that was typed: the home area is read when the map opens, and clearing it restores world", async () => {
  const template = worldVenueMapModule.paneTemplates!.find((entry) => entry.id === "world-venue-map-pane")!;
  const context = createTestHeadlessContext();
  context.config.pluginConfig["market-overview"] = { [HOME_AREA_SETTING_KEY]: "51.5,-0.1" };
  const templateContext = createTestTemplateContext({ config: context.config });
  for (const arg of ["ships", undefined]) {
    const made = await template.createInstance!(templateContext, arg ? { arg } : {});
    expect(JSON.stringify(made)).not.toContain("51.5");
    expect(made!.settings ?? {}).not.toHaveProperty("place");
  }
  expect(await template.createInstance!(templateContext, { arg: "ships" })).toMatchObject({ title: "Map · Ships", settings: { layers: ["ships"] } });
  expect(await template.createInstance!(templateContext, { arg: "air Sydney" })).toMatchObject({ title: "Map · Air · Sydney", settings: { place: "Sydney", layers: ["air"] } });
  expect(buildMapSettingsDef({}, null).fields.find((field) => field.key === HOME_AREA_SETTING_KEY)).toMatchObject({ storage: "plugin" });
  context.config.pluginConfig["market-overview"]![HOME_AREA_SETTING_KEY] = "";
  expect(await template.createInstance!(templateContext, {})).toEqual({ placement: "floating" });
});

test("headless places bound and order the table; an unknown place reports once and returns the world", async () => {
  const paths: string[] = [];
  const client = { geo: createGeoFixtureRequest({ onRequest: (path) => paths.push(path) }) } as unknown as HeadlessPaneContext["apiClient"];
  const context = createTestHeadlessContext({ apiClient: client });
  const args = createTestHeadlessArgs({ argument: "ships Suez Canal" });
  const near = await mapHeadless.load(args, context);
  expect(near.metadata?.place).toMatchObject({ label: "Suez Canal" });
  expect(near.rows.map((row) => row.label)).toEqual(["Suez Canal"]);
  expect(paths.some((path) => path.includes("bbox="))).toBe(true);
  expect(mapHeadless.describe(args, near)).toContain("near Suez Canal");
  const unknown = await mapHeadless.load(createTestHeadlessArgs({ argument: "ships Atlantis" }), context);
  expect(unknown.errors).toEqual(['Unknown place "Atlantis"; showing world.']);
  expect(unknown.rows.length).toBeGreaterThan(1);
  context.config.pluginConfig["market-overview"] = { [HOME_AREA_SETTING_KEY]: "30,32" };
  const home = await mapHeadless.load(createTestHeadlessArgs({ argument: "ships" }), context);
  expect(home.metadata?.place).toMatchObject({ latitude: 30, longitude: 32 });
  const coordinates = await mapHeadless.load(createTestHeadlessArgs({ argument: "ships 26.5,56.3" }), context);
  expect(coordinates.metadata?.place).toMatchObject({ latitude: 26.5, longitude: 56.3 });
});
