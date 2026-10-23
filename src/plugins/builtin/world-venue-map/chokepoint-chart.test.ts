import { afterEach, describe, expect, test } from "bun:test";
import { resetGeoCatalogCache } from "../../../api-client/geo";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createGeoFixtureRequest } from "../../../test-support/test-fixture-geo";
import { resolveChartSpecData } from "../../../time-series/resolve";
import type { ChartSpec } from "../../../time-series/types";
import { buildCustomChartPreset } from "../chart-composer/presets";
import { createChokepointInstance } from "./chokepoint-chart";
import { resolveGeoChartSeries } from "./geo-series";

afterEach(() => resetGeoCatalogCache());

const chartOf = (instance: Awaited<ReturnType<typeof createChokepointInstance>>) => instance.settings?.chartSpec as ChartSpec;

describe("CHOKE", () => {
  test("charts the key straits together, each under a short name the legend can show whole", async () => {
    const instance = await createChokepointInstance(createGeoFixtureRequest());
    expect(instance.title).toBe("G Chokepoint transits");
    expect(chartOf(instance).series.map((series) => series.label)).toEqual(["Suez", "Panama", "Hormuz", "Bab el-Mandeb", "Malacca"]);
  });

  test("a named chokepoint charts alone under the full name the index gives it", async () => {
    const instance = await createChokepointInstance(createGeoFixtureRequest(), "Bab el-Mandeb");
    expect(instance.title).toBe("G BABELMANDEB transits");
    expect(chartOf(instance).series.map((series) => series.label)).toEqual([undefined]);
  });

  test("an argument that is no chokepoint is told which straits exist and opens no chart", async () => {
    await expect(createChokepointInstance(createGeoFixtureRequest(), "NVDA")).rejects.toThrow(
      "No chokepoint named NVDA. Try CHOKE SUEZ, PANAMA, HORMUZ, BAB EL-MANDEB, MALACCA or BOSPHORUS.",
    );
  });

  test("a map series that does not exist names what was typed in the chart, never the id the chart gave it", async () => {
    const request = createGeoFixtureRequest();
    const spec = buildCustomChartPreset("GEO:NVDA");
    expect(spec.series[0]?.id).toContain("geo-series");
    const result = await resolveChartSpecData(spec, {
      dataProvider: createTestDataProvider(),
      loadFredSeries: async () => { throw new Error("not charted"); },
      now: new Date("2026-10-01"),
      resolveCapabilitySeries: (source, viewport) => resolveGeoChartSeries(request, source.seriesId, viewport),
    });
    expect(result.errors).toEqual(["NVDA: No map series named NVDA."]);
    expect([...result.errors, ...result.warnings].join("\n")).not.toContain("geo-series");
  });
});
