/**
 * The geo layers contract (/cloud/geo/*) served from trimmed real-shaped
 * samples: chokepoint and port databases with daily counts, large airports,
 * US crude trunk lines and shale plays, LNG terminals, and ships made by hand
 * from the documented position report fields. It answers the way the server
 * does: clusters for dense point layers, default sorts, empty bodies for an
 * unavailable layer and `{ error, message }` failures. Tests hand
 * `createGeoFixtureRequest()` to the client as its request function.
 */
import { ApiRequestError } from "../api-client/errors";
import type {
  GeoCluster,
  GeoEntitiesPayload,
  GeoEntityPayload,
  GeoFeature,
  GeoFeaturesPayload,
  GeoLayersPayload,
  GeoPropValue,
  GeoRequest,
  GeoSeriesPayload,
  GeoSeriesSearchHit,
  GeoSeriesSearchPayload,
} from "../api-client/geo";
import fixtures from "./geo.fixture.json";

interface FixtureSeries extends GeoSeriesSearchHit {
  points: [string, number][];
}

type FixtureFeature = GeoFeature & { detail?: Record<string, GeoPropValue> };

interface GeoFixtureData {
  base: string;
  layers: GeoLayersPayload;
  behaviour: Record<string, { defaultSort: { key: string; dir: "asc" | "desc" }; clusterBelowZoom?: number }>;
  features: Record<string, FixtureFeature[]>;
  trails: Record<string, [number, number, string][]>;
  series: Record<string, FixtureSeries>;
}

const data = fixtures as unknown as GeoFixtureData;

/** The server's clustering rule: a dense point layer clusters below its own zoom, any layer above the cap. */
const CLUSTER_MIN_FEATURES = 200;
const CLUSTER_MAX_ZOOM = 8;

export interface GeoFixtureOptions {
  /** Shifts live timestamps so they read as recent; defaults to the fixture's own base time. */
  now?: number;
  /** Answers every route with 404, like a server without geo layers. */
  absent?: boolean;
  /** Called with each request path, for tests that count or inspect requests. */
  onRequest?: (path: string, init?: RequestInit) => void;
}

function fail(status: number, code: string, message: string): never {
  throw new ApiRequestError(message, status, undefined, code);
}

function shiftIso(value: string | null, offsetMs: number): string | null {
  if (!value || offsetMs === 0) return value;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time + offsetMs).toISOString() : value;
}

function liveLayer(layerId: string): boolean {
  return data.layers.layers.find((layer) => layer.id === layerId)?.cadence === "live";
}

function wire(feature: FixtureFeature, offsetMs: number): GeoFeature {
  const { detail: _detail, ...rest } = feature;
  if (!liveLayer(feature.layer) || offsetMs === 0) return rest;
  const props = { ...rest.props };
  if (typeof props.lastSeen === "string") props.lastSeen = shiftIso(props.lastSeen, offsetMs);
  return { ...rest, ts: shiftIso(rest.ts, offsetMs), props };
}

function coordinates(feature: GeoFeature): [number, number][] {
  const geometry = feature.geometry;
  switch (geometry.type) {
    case "Point": return [geometry.coordinates];
    case "LineString": return geometry.coordinates;
    case "MultiLineString": return geometry.coordinates.flat();
    case "Polygon": return geometry.coordinates.flat();
  }
}

function anchor(feature: GeoFeature): [number, number] {
  const points = coordinates(feature);
  if (feature.geometry.type === "Point") return points[0]!;
  const lon = points.reduce((sum, point) => sum + point[0], 0) / points.length;
  const lat = points.reduce((sum, point) => sum + point[1], 0) / points.length;
  return [Number(lon.toFixed(4)), Number(lat.toFixed(4))];
}

function parseBbox(value: string | null): [number, number, number, number] | null {
  if (!value) return null;
  const parts = value.split(",").map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite) || parts[1]! > parts[3]!) fail(400, "invalid_bbox", "Invalid bbox");
  return parts as [number, number, number, number];
}

function inBbox(feature: GeoFeature, bbox: [number, number, number, number] | null): boolean {
  if (!bbox) return true;
  const [west, south, east, north] = bbox;
  return coordinates(feature).some(([lon, lat]) => lat >= south && lat <= north
    && (west <= east ? lon >= west && lon <= east : lon >= west || lon <= east));
}

function zoomFor(params: URLSearchParams, bbox: [number, number, number, number] | null): number {
  const asked = params.get("zoom");
  if (asked !== null && Number.isFinite(Number(asked))) return Math.max(0, Number(asked));
  if (!bbox) return 0;
  const width = bbox[2] >= bbox[0] ? bbox[2] - bbox[0] : bbox[2] + 360 - bbox[0];
  return Math.max(0, Math.min(20, Math.log2(360 / width)));
}

function cluster(features: GeoFeature[], zoom: number): GeoCluster[] {
  const level = Math.floor(zoom);
  const size = 360 / 2 ** Math.max(0, level) / 5;
  const cells = new Map<string, { lon: number; lat: number; count: number; kinds: Record<string, number> }>();
  for (const feature of features) {
    const [lon, lat] = anchor(feature);
    const key = `${Math.floor(lon / size)}:${Math.floor(lat / size)}`;
    const cell = cells.get(key) ?? { lon: 0, lat: 0, count: 0, kinds: {} };
    cell.lon += lon;
    cell.lat += lat;
    cell.count += 1;
    const kind = typeof feature.props.class === "string" ? feature.props.class.toLowerCase() : feature.entityKind;
    cell.kinds[kind] = (cell.kinds[kind] ?? 0) + 1;
    cells.set(key, cell);
  }
  return [...cells.entries()]
    .map(([key, cell]) => ({
      id: `c:${level}:${key}`,
      lon: Math.round((cell.lon / cell.count) * 1e4) / 1e4,
      lat: Math.round((cell.lat / cell.count) * 1e4) / 1e4,
      count: cell.count,
      kinds: cell.kinds,
    }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

function compare(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === null || left === undefined) return 1;
  if (right === null || right === undefined) return -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right));
}

function layerFor(layerId: string) {
  const layer = data.layers.layers.find((entry) => entry.id === layerId);
  if (!layer) fail(404, "not_found", "Unknown map layer");
  return layer;
}

function features(layerId: string, params: URLSearchParams, offsetMs: number): GeoFeaturesPayload {
  const layer = layerFor(layerId);
  if (layer.status === "unavailable") {
    return { layer: layer.id, asOf: null, features: [], total: 0, truncated: false, status: layer.status, ...(layer.statusNote ? { statusNote: layer.statusNote } : {}) };
  }
  const bbox = parseBbox(params.get("bbox"));
  const zoom = zoomFor(params, bbox);
  const limit = Math.max(1, Math.min(Number(params.get("limit") ?? 1500), 5000));
  const visible = (data.features[layer.id] ?? []).filter((feature) => inBbox(feature, bbox));
  const asOf = shiftIso(layer.asOf, liveLayer(layer.id) ? offsetMs : 0);
  const total = visible.length;
  const clusterBelow = data.behaviour[layer.id]?.clusterBelowZoom;
  const clusters = layer.geometry === "point" && !(total < CLUSTER_MIN_FEATURES && total <= limit)
    && ((clusterBelow !== undefined && zoom < clusterBelow) || (total > limit && zoom < CLUSTER_MAX_ZOOM));
  if (clusters) return { layer: layer.id, asOf, features: [], total, truncated: true, clusters: cluster(visible, zoom) };
  const rows = visible.slice(0, limit);
  return { layer: layer.id, asOf, features: rows.map((feature) => wire(feature, offsetMs)), total, truncated: total > rows.length };
}

function entities(layerId: string, params: URLSearchParams, offsetMs: number): GeoEntitiesPayload {
  const layer = layerFor(layerId);
  if (layer.status === "unavailable") {
    return { layer: layer.id, asOf: null, columns: layer.columns, rows: [], total: 0, status: layer.status, ...(layer.statusNote ? { statusNote: layer.statusNote } : {}) };
  }
  const q = params.get("q")?.trim().toLowerCase() ?? "";
  const asked = params.get("sort");
  const fallback = data.behaviour[layer.id]?.defaultSort ?? { key: "label", dir: "asc" as const };
  const column = layer.columns.find((entry) => entry.key === asked);
  const sort = column
    ? { key: column.key, dir: params.get("dir") === "asc" || params.get("dir") === "desc" ? params.get("dir")! : column.align === "right" ? "desc" : "asc" }
    : fallback;
  const sign = sort.dir === "desc" ? -1 : 1;
  const limit = Math.max(1, Math.min(Number(params.get("limit") ?? 100), 500));
  const offset = Math.max(0, Number(params.get("offset") ?? 0));
  const rows = (data.features[layer.id] ?? [])
    .filter((feature) => inBbox(feature, parseBbox(params.get("bbox"))))
    .filter((feature) => !q || feature.label.toLowerCase().includes(q)
      || Object.values(feature.props).some((value) => value !== null && String(value).toLowerCase().includes(q)))
    .map((feature) => wire(feature, offsetMs))
    .sort((left, right) => sign * compare(
      sort.key === "label" ? left.label : left.props[sort.key],
      sort.key === "label" ? right.label : right.props[sort.key],
    ) || compare(left.label, right.label));
  return {
    layer: layer.id,
    asOf: shiftIso(layer.asOf, liveLayer(layer.id) ? offsetMs : 0),
    columns: layer.columns,
    rows: rows.slice(offset, offset + limit).map((feature) => {
      const [lon, lat] = anchor(feature);
      return { id: feature.id, label: feature.label, lon, lat, props: feature.props, ...(feature.tickers ? { tickers: feature.tickers } : {}) };
    }),
    total: rows.length,
  };
}

function entity(layerId: string, entityId: string, offsetMs: number): GeoEntityPayload {
  layerFor(layerId);
  const feature = (data.features[layerId] ?? []).find((entry) => entry.id === entityId);
  if (!feature) fail(404, "not_found", "Unknown map entity");
  const series = Object.values(data.series).filter((entry) => entry.entityId === entityId)
    .map(({ id, name, unit, frequency, entityId: owner }) => ({ id, name, unit, frequency, ...(owner ? { entityId: owner } : {}) }));
  const trail = data.trails[entityId]?.map(([lon, lat, time]) => [lon, lat, shiftIso(time, offsetMs) ?? time] as [number, number, string]);
  return {
    feature: wire(feature, offsetMs),
    detail: feature.detail ?? {},
    ...(trail ? { trail } : {}),
    ...(series.length ? { series } : {}),
  };
}

function searchSeries(params: URLSearchParams): GeoSeriesSearchPayload {
  const q = params.get("q")?.trim().toLowerCase() ?? "";
  return {
    series: Object.values(data.series)
      .filter((entry) => !q || entry.id.toLowerCase().includes(q) || entry.name.toLowerCase().includes(q)
        || entry.alias?.toLowerCase() === q)
      .slice(0, 200)
      .map(({ points: _points, ...hit }) => hit),
  };
}

function seriesPoints(seriesId: string, params: URLSearchParams): GeoSeriesPayload {
  const entry = data.series[seriesId];
  if (!entry) fail(404, "not_found", "Unknown series");
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "9999-12-31";
  const points = entry.points.filter(([date]) => date >= from && date <= to);
  return { id: entry.id, name: entry.name, unit: entry.unit, frequency: entry.frequency, points, asOf: entry.points.at(-1)?.[0] ?? null };
}

/** Answers one /cloud/geo/ path (without that prefix). */
export function answerGeoFixture(path: string, options: GeoFixtureOptions = {}): unknown {
  if (options.absent) fail(404, "not_found", "Not found");
  const offsetMs = options.now === undefined ? 0 : options.now - Date.parse(data.base);
  const [route = "", search = ""] = path.split("?");
  const params = new URLSearchParams(search);
  const parts = route.split("/").map((part) => decodeURIComponent(part));
  if (parts.length === 1 && parts[0] === "layers") {
    return { ...data.layers, asOf: shiftIso(data.layers.asOf, offsetMs), layers: data.layers.layers.map((layer) => ({
      ...layer, asOf: shiftIso(layer.asOf, layer.cadence === "live" ? offsetMs : 0),
    })) };
  }
  if (parts[0] === "layers" && parts.length === 3 && parts[2] === "features") return features(parts[1]!, params, offsetMs);
  if (parts[0] === "layers" && parts.length === 3 && parts[2] === "entities") return entities(parts[1]!, params, offsetMs);
  if (parts[0] === "entities" && parts.length === 3) return entity(parts[1]!, parts[2]!, offsetMs);
  if (parts[0] === "series" && parts.length === 1) return searchSeries(params);
  if (parts[0] === "series" && parts.length === 2) return seriesPoints(parts[1]!, params);
  fail(404, "not_found", "Not found");
}

/** A `GeoRequest` over the fixtures. Requests honour their abort signal. */
export function createGeoFixtureRequest(options: GeoFixtureOptions = {}): GeoRequest {
  return async <T>(path: string, init?: RequestInit): Promise<T> => {
    options.onRequest?.(path, init);
    init?.signal?.throwIfAborted();
    await Promise.resolve();
    init?.signal?.throwIfAborted();
    return answerGeoFixture(path, options) as T;
  };
}
