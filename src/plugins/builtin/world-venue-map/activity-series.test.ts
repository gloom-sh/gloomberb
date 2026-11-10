import { describe, expect, test } from "bun:test";
import { findCatalogSeries } from "../../../cli/series-search";
import { getLoadablePlugins } from "../../catalog";
import { ACTIVITY_SERIES } from "./activity-series";

const ids = (query: string) => findCatalogSeries(getLoadablePlugins(), query).map((match) => match.id);

describe("US activity series in the catalog", () => {
  test("TSA's travelers are found by what a trader types for air travel", () => {
    for (const query of ["TSA", "air travel", "footfall"]) {
      expect(ids(query).slice(0, 3), query).toEqual(["geo:tsa", "geo:tsa.7d", "geo:tsa.yoy"]);
    }
    expect(findCatalogSeries(getLoadablePlugins(), "TSA")[0]).toMatchObject({
      name: "US airport checkpoint travelers",
      unit: "people",
      frequency: "daily",
      publisher: "TSA",
      expression: "GEO:TSA",
      exact: true,
    });
  });

  test("electricity demand is found as power load, grid load and electricity demand, the Lower 48 first", () => {
    for (const query of ["power load", "grid load", "electricity demand"]) {
      const found = ids(query);
      expect(found[0], query).toBe("geo:us48.load");
      for (const area of ["ercot", "pjm", "miso", "caiso", "nyiso", "isone", "spp"]) {
        expect(found, `${query} ${area}`).toContain(`geo:${area}.load`);
      }
    }
    expect(ids("PJM electricity demand")[0]).toBe("geo:pjm.load");
  });

  test("each area charts as the server's alias, in its unit, with its publisher", () => {
    const byId = new Map(ACTIVITY_SERIES.map((definition) => [definition.id, definition]));
    expect(byId.get("geo:us48.load")).toMatchObject({ expression: "GEO:US48.LOAD", unit: "GWh/day", publisher: "EIA", group: "Energy" });
    expect(byId.get("geo:us48.load.7d")).toMatchObject({ expression: "GEO:US48.LOAD.7D", unit: "GWh/day" });
    expect(byId.get("geo:ercot.load.yoy")).toMatchObject({ expression: "GEO:ERCOT.LOAD.YOY", unit: "%" });
    expect(byId.get("geo:tsa.yoy")).toMatchObject({ expression: "GEO:TSA.YOY", unit: "%", publisher: "TSA" });
    // A balancing authority's 7-day average is charted by its expression, not listed.
    expect(byId.has("geo:pjm.load.7d")).toBe(false);
    expect(ACTIVITY_SERIES).toHaveLength(3 + 3 + 7 * 2);
  });
});
