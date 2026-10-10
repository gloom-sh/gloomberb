import { afterEach, describe, expect, test } from "bun:test";
import { resetGeoCatalogCache } from "../../../api-client/geo";
import { createGeoFixtureRequest } from "../../../test-support/test-fixture-geo";
import { chokepointSeriesFor, chokepointSeriesIds, geoSeriesRange, resolveGeoChartSeries } from "./geo-series";

afterEach(() => resetGeoCatalogCache());

describe("map series in G", () => {
  test("a short alias resolves to the series it names, clipped to the chart's window", async () => {
    const paths: string[] = [];
    const request = createGeoFixtureRequest({ onRequest: (path) => paths.push(path) });
    const series = await resolveGeoChartSeries(request, "suez", { range: "1M", resolution: "auto" });
    expect(series.label).toBe("Suez Canal transits");
    expect(series.unit).toBe("vessels");
    expect(series.nativeFrequency).toBe("daily");
    expect(paths[1]).toStartWith("series/chokepoints.suez.transits?from=");
    expect(series.points.length).toBeGreaterThan(0);
    expect(series.points.every((point) => typeof point.value === "number")).toBe(true);

    await expect(resolveGeoChartSeries(request, "ATLANTIS", { range: "1Y", resolution: "auto" }))
      .rejects.toThrow("No map series named ATLANTIS.");
  });

  test("a date window wins over the range, and ALL asks for everything", () => {
    expect(geoSeriesRange({ range: "1Y", resolution: "auto", dateWindow: { start: "2026-01-02T00:00:00Z", end: "2026-03-04T00:00:00Z" } }))
      .toEqual({ from: "2026-01-02", to: "2026-03-04" });
    expect(geoSeriesRange({ range: "ALL", resolution: "auto" })).toEqual({});
    expect(geoSeriesRange({ range: "1M", resolution: "auto" }, new Date("2026-10-09T00:00:00Z"))).toEqual({ from: "2026-09-09" });
  });

  test("CHOKE charts the key straits by alias, and a typed strait finds its own", async () => {
    const request = createGeoFixtureRequest();
    expect(await chokepointSeriesIds(request)).toEqual(["SUEZ", "PANAMA", "HORMUZ", "BABELMANDEB", "MALACCA"]);
    expect(await chokepointSeriesFor(request, "Bab el-Mandeb")).toBe("BABELMANDEB");
    expect(await chokepointSeriesFor(request, "strait of hormuz")).toBe("HORMUZ");
    expect(await chokepointSeriesFor(request, "suez")).toBe("SUEZ");
  });
});
