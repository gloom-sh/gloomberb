import { afterEach, expect, test } from "bun:test";
import type { GeoLayerInfo, GeoLayersPayload, GeoRequest } from "../../../api-client/geo";
import { registerLocalGeoLayer, withLocalGeoLayers, type LocalEntityQuery, type LocalFeatureQuery } from "./local-layers";

const info = (id: string): GeoLayerInfo => ({
  id, name: id, group: "infrastructure", geometry: "point", cadence: "daily", refreshSeconds: null, asOf: null,
  count: null, status: "ok", access: "free", columns: [], series: [], defaultVisible: false,
});

let remove: (() => void) | null = null;
afterEach(() => { remove?.(); remove = null; });

function setup() {
  const asked: { features: LocalFeatureQuery[]; entities: LocalEntityQuery[]; entity: Array<[string, string | null]> } = { features: [], entities: [], entity: [] };
  remove = registerLocalGeoLayer({
    info: info("sites"),
    features: async (query) => { asked.features.push(query); return { layer: "sites", asOf: null, features: [], total: 0, truncated: false }; },
    entities: async (query) => { asked.entities.push(query); return { layer: "sites", asOf: null, columns: [], rows: [], total: 0 }; },
    entity: async (id, scope) => { asked.entity.push([id, scope]); throw new Error("unused"); },
  });
  const sent: string[] = [];
  const server = (async (path: string) => {
    sent.push(path);
    if (path === "layers") return { layers: [info("ships"), info("sites")], asOf: "2026-10-30" };
    return { forwarded: path };
  }) as GeoRequest;
  return { asked, sent, server };
}

test("a local layer is answered in the app with the pane's scope, and everything else reaches the server", async () => {
  const { asked, sent, server } = setup();
  const request = withLocalGeoLayers(server, "company:CRWV");
  await request("layers/sites/features?bbox=-10,20,30,60&zoom=3");
  await request("layers/sites/entities?q=texas&sort=mw&dir=asc&offset=100");
  await request("entities/sites/site%2F1").catch(() => {});
  expect(asked.features).toEqual([{ bbox: [-10, 20, 30, 60], zoom: 3, limit: 1500, scope: "company:CRWV" }]);
  expect(asked.entities).toEqual([{ q: "texas", sort: "mw", dir: "asc", limit: 100, offset: 100, bbox: null, scope: "company:CRWV" }]);
  expect(asked.entity).toEqual([["site/1", "company:CRWV"]]);
  expect(await request<{ forwarded: string }>("layers/ships/features?zoom=2")).toEqual({ forwarded: "layers/ships/features?zoom=2" });
  expect(sent).toEqual(["layers/ships/features?zoom=2"]);
  // The server's own entry wins over a local layer of the same id.
  const catalog = await request<GeoLayersPayload>("layers");
  expect(catalog.layers.map((layer) => layer.id)).toEqual(["ships", "sites"]);
});

test("the catalog still lists the local layers when the server's cannot load", async () => {
  const { server } = setup();
  const down = (async (path: string) => {
    if (path === "layers") throw new Error("offline");
    return server(path);
  }) as GeoRequest;
  const catalog = await withLocalGeoLayers(down)<GeoLayersPayload>("layers");
  expect(catalog.layers.map((layer) => layer.id)).toEqual(["sites"]);
  remove?.();
  remove = null;
  await expect(withLocalGeoLayers(down)("layers")).rejects.toThrow("offline");
});
