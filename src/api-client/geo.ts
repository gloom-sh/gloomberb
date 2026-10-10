/**
 * Geo layers, as GET /cloud/geo/* serves them: anything with a place (a ship,
 * a port, a pipeline) as map features, an entity table and chart series. The
 * types mirror the server's wire contract field for field. The app knows only
 * this contract, so a layer the server adds needs no release.
 *
 * Failures carry `{ error, message }`: 404 `not_found`, 400 `invalid_bbox`,
 * 403 `pro_required`, 429 `geo_rate_limited` with Retry-After, 503
 * `geo_unavailable`. A layer that cannot serve still answers 200 with an
 * empty body and its `status` and `statusNote`.
 */
type Lon = number;
type Lat = number;

type GeoGeometry =
  | { type: "Point"; coordinates: [Lon, Lat] }
  | { type: "LineString"; coordinates: [Lon, Lat][] }
  | { type: "MultiLineString"; coordinates: [Lon, Lat][][] }
  | { type: "Polygon"; coordinates: [Lon, Lat][][] };

export interface GeoTickerLink {
  symbol: string;
  exchange?: string;
  /** How the entity relates to the company. */
  via: "owner" | "operator" | "route" | "sector";
  confidence: "reviewed" | "inferred";
  /** Short, e.g. "Operates the pipeline". */
  note?: string;
}

export type GeoPropValue = string | number | boolean | null;

export interface GeoFeature {
  /** Stable within the layer, e.g. "mmsi:123456789", "iata:JFK", "choke:suez". */
  id: string;
  layer: string;
  entityKind: string;
  label: string;
  geometry: GeoGeometry;
  /** ISO time of the observation; null for static layers. */
  ts: string | null;
  /** Flat, display-ready values. */
  props: Record<string, GeoPropValue>;
  tickers?: GeoTickerLink[];
}

/** `percent1` values are percentage points: 12.3 reads 12.3%. */
export type GeoColumnFormat = "text" | "int" | "decimal1" | "percent1" | "datetime" | "knots" | "km";

export interface GeoColumn {
  key: string;
  label: string;
  align?: "left" | "right";
  format?: GeoColumnFormat;
}

export interface GeoSeriesInfo {
  id: string;
  name: string;
  unit: string;
  frequency: "daily" | "weekly" | "monthly";
  entityId?: string;
}

type GeoLayerGroup = "ships" | "air" | "energy" | "ports" | "infrastructure";
type GeoLayerStatus = "ok" | "partial" | "unavailable";

export interface GeoLayerInfo {
  id: string;
  name: string;
  /** A group the app does not know yet still lists, under its own name. */
  group: GeoLayerGroup | (string & {});
  geometry: "point" | "line" | "area";
  cadence: "live" | "daily" | "static";
  /** How often a client should re-request features; null for static layers. */
  refreshSeconds: number | null;
  asOf: string | null;
  count: number | null;
  status: GeoLayerStatus;
  /** Short plain words, never a source name. */
  statusNote?: string;
  access: "free" | "pro";
  /** The entity table's columns; the first is the label. */
  columns: GeoColumn[];
  series: GeoSeriesInfo[];
  defaultVisible: boolean;
  /** Below this zoom the client requests nothing. */
  minZoom?: number;
}

export interface GeoLayersPayload {
  layers: GeoLayerInfo[];
  asOf: string | null;
}

export interface GeoCluster {
  id: string;
  lon: Lon;
  lat: Lat;
  count: number;
  kinds?: Record<string, number>;
}

/**
 * A clustering answer has no features: everything is in `clusters`. Closer
 * in, a capped answer keeps the top features by rank and sets `truncated`.
 */
export interface GeoFeaturesPayload {
  layer: string;
  asOf: string | null;
  features: GeoFeature[];
  total: number;
  truncated: boolean;
  clusters?: GeoCluster[];
  /** Present when the layer cannot serve right now, with the same words as the catalog. */
  status?: GeoLayerStatus;
  statusNote?: string;
}

export interface GeoEntityRow {
  id: string;
  label: string;
  lon: Lon;
  lat: Lat;
  props: Record<string, GeoPropValue>;
  tickers?: GeoTickerLink[];
}

export interface GeoEntitiesPayload {
  layer: string;
  asOf: string | null;
  columns: GeoColumn[];
  rows: GeoEntityRow[];
  total: number;
  status?: GeoLayerStatus;
  statusNote?: string;
}

/** Longitude, latitude and the ISO time the entity was seen there. */
type GeoTrailPoint = [Lon, Lat, string];

export interface GeoEntityPayload {
  feature: GeoFeature;
  detail: Record<string, GeoPropValue>;
  /** Oldest first. */
  trail?: GeoTrailPoint[];
  series?: GeoSeriesInfo[];
}

/** `alias` is the short form G takes (SUEZ, HORMUZ.TANKER); ids are the server's own. */
export type GeoSeriesSearchHit = GeoSeriesInfo & { layer: string; alias?: string };

export interface GeoSeriesSearchPayload {
  series: GeoSeriesSearchHit[];
}

export interface GeoSeriesPayload {
  id: string;
  name: string;
  unit: string;
  frequency: GeoSeriesInfo["frequency"];
  /** [YYYY-MM-DD, value], oldest first. */
  points: [string, number][];
  asOf: string | null;
}

/** West, south, east, north in degrees. */
export type GeoBbox = [number, number, number, number];

/** A request under /cloud/geo/, through the shared Cloud client (`apiClient.geo`). */
export type GeoRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

/** The server's default cap on one features answer; above it a point layer answers clusters. */
export const GEO_FEATURE_LIMIT = 1500;
const GEO_FEATURE_LIMIT_MAX = 5000;
/** Live layers a client may keep refreshing at once. */
export const GEO_MAX_LIVE_LAYERS = 2;
const CATALOG_TTL_MS = 5 * 60_000;
/** A server without geo layers is asked again only after this long. */
const ABSENT_TTL_MS = 10 * 60_000;

function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  // Commas stay literal (bbox=w,s,e,n), as the contract writes them and caches key them.
  const text = search.toString().replaceAll("%2C", ",");
  return text ? `?${text}` : "";
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function bboxParam(bbox: GeoBbox | undefined): string | undefined {
  return bbox ? bbox.map((value) => Number(value.toFixed(3))).join(",") : undefined;
}

export interface GeoFeaturesQuery {
  bbox?: GeoBbox;
  zoom?: number;
  limit?: number;
}

export function getGeoFeatures(
  request: GeoRequest,
  layerId: string,
  options: GeoFeaturesQuery = {},
  signal?: AbortSignal,
): Promise<GeoFeaturesPayload> {
  const limit = Math.max(1, Math.min(options.limit ?? GEO_FEATURE_LIMIT, GEO_FEATURE_LIMIT_MAX));
  return request<GeoFeaturesPayload>(
    `layers/${segment(layerId)}/features${query({ bbox: bboxParam(options.bbox), zoom: options.zoom, limit })}`,
    signal ? { signal } : undefined,
  );
}

export interface GeoEntitiesQuery {
  q?: string;
  sort?: string;
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
  bbox?: GeoBbox;
}

export function getGeoEntities(
  request: GeoRequest,
  layerId: string,
  options: GeoEntitiesQuery = {},
  signal?: AbortSignal,
): Promise<GeoEntitiesPayload> {
  return request<GeoEntitiesPayload>(
    `layers/${segment(layerId)}/entities${query({
      q: options.q?.trim(),
      sort: options.sort,
      dir: options.sort ? options.dir : undefined,
      limit: options.limit,
      offset: options.offset,
      bbox: bboxParam(options.bbox),
    })}`,
    signal ? { signal } : undefined,
  );
}

export function getGeoEntity(
  request: GeoRequest,
  layerId: string,
  entityId: string,
  signal?: AbortSignal,
): Promise<GeoEntityPayload> {
  return request<GeoEntityPayload>(`entities/${segment(layerId)}/${segment(entityId)}`, signal ? { signal } : undefined);
}

export function searchGeoSeries(request: GeoRequest, q: string, signal?: AbortSignal): Promise<GeoSeriesSearchPayload> {
  return request<GeoSeriesSearchPayload>(`series${query({ q: q.trim() })}`, signal ? { signal } : undefined);
}

export function getGeoSeries(
  request: GeoRequest,
  seriesId: string,
  range: { from?: string; to?: string } = {},
  signal?: AbortSignal,
): Promise<GeoSeriesPayload> {
  return request<GeoSeriesPayload>(`series/${segment(seriesId)}${query(range)}`, signal ? { signal } : undefined);
}

/**
 * Finds a series by id or short alias (SUEZ). Exact matches win over a series
 * whose name merely contains the text.
 */
export async function resolveGeoSeries(
  request: GeoRequest,
  token: string,
  signal?: AbortSignal,
): Promise<GeoSeriesSearchHit | null> {
  const needle = token.trim().toLowerCase();
  if (!needle) return null;
  const { series } = await searchGeoSeries(request, token, signal);
  return series.find((hit) => hit.id.toLowerCase() === needle)
    ?? series.find((hit) => hit.alias?.toLowerCase() === needle)
    ?? null;
}

interface CatalogEntry {
  at: number;
  payload: GeoLayersPayload | null;
}

let catalogEntry: CatalogEntry | null = null;
let catalogInFlight: Promise<GeoLayersPayload | null> | null = null;

function validLayer(value: unknown): value is GeoLayerInfo {
  if (!value || typeof value !== "object") return false;
  const layer = value as Partial<GeoLayerInfo>;
  return typeof layer.id === "string" && !!layer.id && typeof layer.name === "string"
    && (layer.geometry === "point" || layer.geometry === "line" || layer.geometry === "area")
    && Array.isArray(layer.columns);
}

function normalizeCatalog(payload: unknown): GeoLayersPayload | null {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as GeoLayersPayload).layers)) return null;
  const raw = payload as GeoLayersPayload;
  const layers = raw.layers.filter(validLayer).map((layer) => ({
    ...layer,
    series: Array.isArray(layer.series) ? layer.series : [],
    refreshSeconds: typeof layer.refreshSeconds === "number" && layer.refreshSeconds > 0 ? layer.refreshSeconds : null,
  }));
  return layers.length ? { layers, asOf: raw.asOf ?? null } : null;
}

/**
 * The layer catalog, or null when this server has no geo layers. A 404, a
 * failed request or an empty answer all read as "no layers", so the map stays
 * the venue map it was, without errors. Answers are kept for a few minutes.
 */
export async function loadGeoCatalog(
  request: GeoRequest,
  options: { force?: boolean; signal?: AbortSignal; now?: number } = {},
): Promise<GeoLayersPayload | null> {
  const now = options.now ?? Date.now();
  if (!options.force && catalogEntry) {
    const ttl = catalogEntry.payload ? CATALOG_TTL_MS : ABSENT_TTL_MS;
    if (now - catalogEntry.at < ttl) return catalogEntry.payload;
  }
  if (!catalogInFlight) {
    catalogInFlight = request<unknown>("layers")
      .then(normalizeCatalog)
      // A missing route or a refusal is an answer; a network blip is too, for a while.
      .catch(() => null)
      .then((payload) => {
        catalogEntry = { at: options.now ?? Date.now(), payload };
        return payload;
      })
      .finally(() => {
        catalogInFlight = null;
      });
  }
  const pending = catalogInFlight;
  if (!options.signal) return pending;
  return new Promise((resolve, reject) => {
    const abort = () => reject(options.signal!.reason ?? new DOMException("Aborted", "AbortError"));
    if (options.signal!.aborted) return abort();
    options.signal!.addEventListener("abort", abort, { once: true });
    void pending.then((value) => {
      options.signal!.removeEventListener("abort", abort);
      resolve(value);
    });
  });
}

/** The last catalog answer without asking the server, for synchronous readers such as pane settings. */
export function peekGeoCatalog(): GeoLayersPayload | null {
  return catalogEntry?.payload ?? null;
}

/** Test seam: forget what the server answered. */
export function resetGeoCatalogCache(): void {
  catalogEntry = null;
  catalogInFlight = null;
}
