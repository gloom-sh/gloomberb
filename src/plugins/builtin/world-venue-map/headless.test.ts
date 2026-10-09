import { afterEach, expect, test } from "bun:test";
import { resetGeoCatalogCache } from "../../../api-client/geo";
import { createTestHeadlessArgs, createTestHeadlessContext, createTestTemplateContext } from "../../../test-support/headless";
import { createGeoFixtureRequest } from "../../../test-support/test-fixture-geo";
import type { HeadlessPaneContext } from "../../../types/headless";
import { mapHeadless } from "./headless";
import { worldVenueMapModule } from "./index";

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
