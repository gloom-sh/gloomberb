import { describe, expect, test } from "bun:test";
import type { GeoLayerInfo } from "../../../api-client/geo";
import {
  applyMapSetting,
  buildMapSettingsDef,
  geoViewForViewport,
  LAYERS_SETTING_KEY,
  parseMapPreset,
  resolveActiveLayers,
  VENUES_SETTING_KEY,
  WORLD_GEO_VIEW,
} from "./layers";
import { DEFAULT_WORLD_MAP_VIEWPORT } from "./model";

function layer(id: string, group: string, cadence: GeoLayerInfo["cadence"] = "static"): GeoLayerInfo {
  return {
    id, name: id, group, geometry: "point", cadence, refreshSeconds: cadence === "live" ? 30 : null, asOf: null, count: null,
    status: "ok", access: "free", columns: [{ key: "label", label: "Name" }], series: [], defaultVisible: false,
  };
}

const catalog = [
  layer("chokepoints", "ships", "daily"),
  layer("vessels", "ships", "live"),
  layer("ports", "ports", "daily"),
  layer("airports", "air"),
  layer("flights", "air", "live"),
  layer("pipelines", "energy"),
  layer("oil-gas-fields", "energy"),
  layer("terminals", "energy"),
  layer("tankers-live", "ships", "live"),
];

describe("map layers", () => {
  test("presets expand groups and stay within the live and total caps, newest first to stay", () => {
    expect(parseMapPreset("ships")).toEqual({ layers: ["ships"], venues: false });
    expect(parseMapPreset("ports, airports venues")).toEqual({ layers: ["ports", "airports"], venues: true });
    expect(parseMapPreset("  ")).toBeNull();

    expect(resolveActiveLayers(["energy"], catalog).map((entry) => entry.id)).toEqual(["pipelines", "oil-gas-fields", "terminals"]);
    expect(resolveActiveLayers(["ships"], catalog).map((entry) => entry.id)).toEqual(["chokepoints", "vessels", "tankers-live"]);
    // A third live layer does not fit: the earliest live pick gives way.
    expect(resolveActiveLayers(["flights", "ships"], catalog).map((entry) => entry.id)).toEqual(["chokepoints", "vessels", "tankers-live"]);
    // Four at most in all.
    expect(resolveActiveLayers(["ports", "energy", "airports"], catalog).map((entry) => entry.id))
      .toEqual(["pipelines", "oil-gas-fields", "terminals", "airports"]);
    expect(resolveActiveLayers(["nope"], catalog)).toEqual([]);
    expect(resolveActiveLayers(["ships"], null)).toEqual([]);
  });

  test("the picker only exists with a catalog, and edits keep venues and drop the oldest pick", () => {
    expect(buildMapSettingsDef({}, null)).toBeUndefined();
    expect(buildMapSettingsDef({}, [])).toBeUndefined();

    const def = buildMapSettingsDef({}, catalog)!;
    expect(def.fields.map((field) => field.key)).toEqual([VENUES_SETTING_KEY, "layers:ships", "layers:ports", "layers:air", "layers:energy"]);
    expect(def.values?.[VENUES_SETTING_KEY]).toBe(true);

    // A plain venue map that gains a layer keeps its venues.
    const withPorts = applyMapSetting({}, "layers:ports", ["ports"], catalog);
    expect(withPorts).toEqual({ [LAYERS_SETTING_KEY]: ["ports"], [VENUES_SETTING_KEY]: true });

    const full = applyMapSetting(withPorts, "layers:energy", ["pipelines", "oil-gas-fields", "terminals"], catalog);
    expect(full[LAYERS_SETTING_KEY]).toEqual(["ports", "pipelines", "oil-gas-fields", "terminals"]);
    const capped = applyMapSetting(full, "layers:air", ["airports"], catalog);
    expect(capped[LAYERS_SETTING_KEY]).toEqual(["pipelines", "oil-gas-fields", "terminals", "airports"]);
    // Unticking a layer removes only that one.
    expect(applyMapSetting(capped, "layers:energy", ["terminals"], catalog)[LAYERS_SETTING_KEY]).toEqual(["terminals", "airports"]);
  });

  test("the view covers the world until zoomed, then a rounded box", () => {
    expect(geoViewForViewport(DEFAULT_WORLD_MAP_VIEWPORT, 120, 60)).toBe(WORLD_GEO_VIEW);
    const view = geoViewForViewport({ zoom: 4, centerLongitude: 103.8, centerLatitude: 1.3 }, 120, 60);
    expect(view.zoom).toBe(2);
    const [west, south, east, north] = view.bbox;
    expect(west).toBeLessThan(103.8);
    expect(east).toBeGreaterThan(103.8);
    expect(south).toBeLessThan(1.3);
    expect(north).toBeGreaterThan(1.3);
    expect(east - west).toBeLessThan(120);
    // Edges snap to half degrees, so small pans reuse the same request.
    expect(view.bbox.every((edge) => Number.isInteger(edge * 2))).toBe(true);
  });
});
