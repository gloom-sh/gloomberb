/**
 * Layers the app serves itself, beside the server's catalog. A plugin whose
 * rows have a place (TheBuildout's facilities) registers one, and the map,
 * its table and its detail read it through the same wire contract as a server
 * layer: the catalog lists it, and its feature, entity and detail requests are
 * answered in the app without reaching Gloom Cloud. A scope (the company or
 * theme the pane follows) narrows what a local layer answers; server layers
 * never see it.
 */
import {
  resetGeoCatalogCache,
  type GeoBbox,
  type GeoEntitiesPayload,
  type GeoEntityPayload,
  type GeoFeaturesPayload,
  type GeoLayerInfo,
  type GeoLayersPayload,
  type GeoRequest,
} from "../../../api-client/geo";
import { logFailure } from "../../../utils/log-failure";

/** What a linked map narrows a local layer to: `company:CRWV`, `theme:<slug>`. */
export interface GeoScope {
  key: string;
  /** The words the pane shows for it: a ticker or a theme's name. */
  label: string;
}

export interface LocalFeatureQuery {
  bbox: GeoBbox | null;
  zoom: number;
  limit: number;
  scope: string | null;
}

export interface LocalEntityQuery {
  q: string;
  sort: string | null;
  dir: "asc" | "desc";
  limit: number;
  offset: number;
  bbox: GeoBbox | null;
  scope: string | null;
}

export interface LocalGeoLayer {
  info: GeoLayerInfo;
  features: (query: LocalFeatureQuery, signal?: AbortSignal) => Promise<GeoFeaturesPayload>;
  entities: (query: LocalEntityQuery, signal?: AbortSignal) => Promise<GeoEntitiesPayload>;
  entity: (id: string, scope: string | null, signal?: AbortSignal) => Promise<GeoEntityPayload>;
}

const localLayers = new Map<string, LocalGeoLayer>();

/** Adds a layer to every map's catalog until the returned function removes it. */
export function registerLocalGeoLayer(layer: LocalGeoLayer): () => void {
  localLayers.set(layer.info.id, layer);
  // A catalog read before the layer existed would hide it for minutes.
  resetGeoCatalogCache();
  return () => {
    if (localLayers.get(layer.info.id) !== layer) return;
    localLayers.delete(layer.info.id);
    resetGeoCatalogCache();
  };
}

export function isLocalGeoLayer(layerId: string): boolean {
  return localLayers.has(layerId);
}

function bboxParam(value: string | null): GeoBbox | null {
  if (!value) return null;
  const parts = value.split(",").map(Number);
  return parts.length === 4 && parts.every(Number.isFinite) ? parts as GeoBbox : null;
}

function numberParam(value: string | null, fallback: number): number {
  const parsed = value === null ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** The server's catalog with the local layers after it; a server without one still lists them. */
async function mergedCatalog(request: GeoRequest, init?: RequestInit): Promise<GeoLayersPayload> {
  const local = [...localLayers.values()].map((layer) => layer.info);
  const server = await request<GeoLayersPayload>("layers", init).catch((error: unknown) => {
    if (!local.length) throw error;
    logFailure("cloud-geo", "Geo catalog request failed")(error);
    return null;
  });
  const serverLayers = Array.isArray(server?.layers) ? server.layers : [];
  const ids = new Set(serverLayers.map((layer) => layer?.id));
  return { layers: [...serverLayers, ...local.filter((layer) => !ids.has(layer.id))], asOf: server?.asOf ?? null };
}

/**
 * A request that answers the local layers itself and sends everything else on.
 * `scope` narrows the local layers' answers; a new scope is a new request
 * function, so the map's feed and table ask again.
 */
export function withLocalGeoLayers(request: GeoRequest, scope: string | null = null): GeoRequest {
  return (<T>(path: string, init?: RequestInit): Promise<T> => {
    const [route = "", search = ""] = path.split("?");
    const params = new URLSearchParams(search);
    const signal = init?.signal ?? undefined;
    if (route === "layers") return (localLayers.size ? mergedCatalog(request, init) : request(path, init)) as Promise<T>;
    const parts = route.split("/").map(decodeURIComponent);
    const layer = parts.length >= 3 ? localLayers.get(parts[1]!) ?? null : null;
    if (parts[0] === "layers" && layer && parts[2] === "features") {
      return layer.features({
        bbox: bboxParam(params.get("bbox")),
        zoom: numberParam(params.get("zoom"), 0),
        limit: numberParam(params.get("limit"), 1500),
        scope,
      }, signal) as Promise<T>;
    }
    if (parts[0] === "layers" && layer && parts[2] === "entities") {
      return layer.entities({
        q: params.get("q") ?? "",
        sort: params.get("sort"),
        dir: params.get("dir") === "asc" ? "asc" : "desc",
        limit: numberParam(params.get("limit"), 100),
        offset: numberParam(params.get("offset"), 0),
        bbox: bboxParam(params.get("bbox")),
        scope,
      }, signal) as Promise<T>;
    }
    const entityLayer = parts[0] === "entities" ? localLayers.get(parts[1] ?? "") : undefined;
    if (entityLayer && parts[2]) return entityLayer.entity(parts.slice(2).join("/"), scope, signal) as Promise<T>;
    return request<T>(path, init);
  }) as GeoRequest;
}
