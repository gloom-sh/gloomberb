/**
 * Which geo layers a map shows and how they read: the layer picker, presets,
 * caps, the view a request covers, and plain-value formatting shared by the
 * pane, the terminal map and the headless report.
 */
import {
  GEO_MAX_LIVE_LAYERS,
  type GeoBbox,
  type GeoColumn,
  type GeoColumnFormat,
  type GeoFeature,
  type GeoLayerInfo,
  type GeoPropValue,
  type GeoTickerLink,
} from "../../../api-client/geo";
import type { PaneSettingField, PaneSettingsDef } from "../../../types/plugin";
import { publicTickerKey } from "../../../utils/exchanges";
import { unprojectWorldPoint, type WorldMapViewport } from "./model";

export const LAYERS_SETTING_KEY = "layers";
export const VENUES_SETTING_KEY = "venues";
/** Layers that refresh on their own (ships, flights) are the expensive ones. */
const MAX_LIVE_LAYERS = GEO_MAX_LIVE_LAYERS;
const MAX_DATA_LAYERS = 4;
/** Drawn per layer; the server caps an answer at 1500 and clusters above it. */
export const MAX_RENDERED_FEATURES = 2000;
export const MAX_RENDERED_CLUSTERS = 600;

const GROUP_PREFIX = "layers:";

const GROUP_TITLES: Record<string, string> = {
  ships: "Ships",
  air: "Air",
  energy: "Energy",
  ports: "Ports",
  infrastructure: "Infrastructure",
};

export function groupTitle(group: string): string {
  return GROUP_TITLES[group] ?? (group ? group.charAt(0).toUpperCase() + group.slice(1) : "Other");
}

/** Layer ids or group names, from a setting (array) or typed text ("ships", "ports, airports"). */
export function parseLayerTokens(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,;+]+/) : [];
  const tokens: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const token = entry.trim().toLowerCase();
    if (token && token !== "venues" && !tokens.includes(token)) tokens.push(token);
  }
  return tokens;
}

function isLive(layer: GeoLayerInfo): boolean {
  return layer.cadence === "live";
}

/**
 * Keeps the newest choices within the caps: at most two live layers and four
 * in all. `ordered` is oldest first, so the earliest pick gives way.
 */
function capLayerSelection(ordered: readonly GeoLayerInfo[]): GeoLayerInfo[] {
  const kept: GeoLayerInfo[] = [];
  let live = 0;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const layer = ordered[index]!;
    if (kept.length >= MAX_DATA_LAYERS) break;
    if (isLive(layer)) {
      if (live >= MAX_LIVE_LAYERS) continue;
      live += 1;
    }
    kept.unshift(layer);
  }
  return kept;
}

/** Expands groups to their layers, drops what the server does not list, and applies the caps. */
export function resolveActiveLayers(tokens: readonly string[], layers: readonly GeoLayerInfo[] | null | undefined): GeoLayerInfo[] {
  if (!layers?.length || !tokens.length) return [];
  const ordered: GeoLayerInfo[] = [];
  const add = (layer: GeoLayerInfo) => {
    if (!ordered.includes(layer)) ordered.push(layer);
  };
  for (const token of tokens) {
    const layer = layers.find((entry) => entry.id.toLowerCase() === token);
    if (layer) {
      add(layer);
      continue;
    }
    for (const member of layers.filter((entry) => String(entry.group).toLowerCase() === token)) add(member);
  }
  return capLayerSelection(ordered);
}

export interface MapPreset {
  layers: string[];
  venues: boolean;
}

/** `MAP ships` and friends: the typed words become layer tokens, resolved once the catalog is known. */
export function parseMapPreset(arg: string | null | undefined): MapPreset | null {
  const tokens = parseLayerTokens(arg ?? "");
  if (!tokens.length) return null;
  return { layers: tokens, venues: /\bvenues\b/i.test(arg ?? "") };
}

export const MAP_PRESET_OPTIONS = [
  { value: "ships", label: "Ships and chokepoints" },
  { value: "ports", label: "Ports" },
  { value: "energy", label: "Pipelines, fields and terminals" },
  { value: "air", label: "Airports" },
] as const;

function shortDate(iso: string): string | null {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

/** Status and cadence in plain words, for the layer picker. */
function describeLayer(layer: GeoLayerInfo): string {
  if (layer.status === "unavailable") return layer.statusNote ? `Unavailable: ${layer.statusNote}` : "Unavailable";
  const cadence = layer.cadence === "live"
    ? layer.refreshSeconds ? `Live, every ${formatSeconds(layer.refreshSeconds)}` : "Live"
    : layer.cadence === "daily"
      ? layer.asOf && shortDate(layer.asOf) ? `Daily, as of ${shortDate(layer.asOf)}` : "Daily"
      : "Reference";
  const parts = [
    ...(layer.access === "pro" ? ["Pro"] : []),
    cadence,
    ...(layer.status === "partial" ? [layer.statusNote ? `partial: ${layer.statusNote}` : "partial"] : []),
  ];
  return parts.join(" · ");
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

function groupsOf(layers: readonly GeoLayerInfo[]): string[] {
  const groups: string[] = [];
  for (const layer of layers) {
    const group = String(layer.group || "other");
    if (!groups.includes(group)) groups.push(group);
  }
  return groups;
}

export function readVenuesSetting(settings: Record<string, unknown> | undefined, activeLayers: number): boolean {
  const value = settings?.[VENUES_SETTING_KEY];
  if (typeof value === "boolean") return value;
  // A preset opens on its layers; a plain MAP stays the venue map.
  return activeLayers === 0;
}

/**
 * The layer picker in the pane settings: venues, then one list per group with
 * each layer's cadence and status. Without a catalog there is nothing to add,
 * so a server without geo layers shows the settings it always had.
 */
export function buildMapSettingsDef(
  settings: Record<string, unknown>,
  layers: readonly GeoLayerInfo[] | null | undefined,
): PaneSettingsDef | undefined {
  if (!layers?.length) return undefined;
  const active = resolveActiveLayers(parseLayerTokens(settings[LAYERS_SETTING_KEY]), layers);
  const values: Record<string, unknown> = { [VENUES_SETTING_KEY]: readVenuesSetting(settings, active.length) };
  const fields: PaneSettingField[] = [{
    key: VENUES_SETTING_KEY,
    label: "Venues",
    description: "Trading venues with open or closed status.",
    type: "toggle",
  }];
  for (const group of groupsOf(layers)) {
    const members = layers.filter((layer) => String(layer.group || "other") === group);
    const key = `${GROUP_PREFIX}${group}`;
    values[key] = active.filter((layer) => members.includes(layer)).map((layer) => layer.id);
    fields.push({
      key,
      label: groupTitle(group),
      type: "multi-select",
      options: members.map((layer) => ({ value: layer.id, label: layer.name, description: describeLayer(layer) })),
    });
  }
  return {
    title: "Map Layers",
    values,
    fields,
    applyValue: (current, field, value) => applyMapSetting(current, field.key, value, layers),
  };
}

export function applyMapSetting(
  settings: Record<string, unknown>,
  key: string,
  value: unknown,
  layers: readonly GeoLayerInfo[],
): Record<string, unknown> {
  if (key === VENUES_SETTING_KEY) return { ...settings, [VENUES_SETTING_KEY]: value === true };
  if (!key.startsWith(GROUP_PREFIX)) return { ...settings, [key]: value };
  const group = key.slice(GROUP_PREFIX.length);
  const members = new Set(layers.filter((layer) => String(layer.group || "other") === group).map((layer) => layer.id));
  const picked = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && members.has(entry)) : [];
  const before = resolveActiveLayers(parseLayerTokens(settings[LAYERS_SETTING_KEY]), layers);
  // Other groups keep their order; this group's picks follow, newest last, so the caps drop the oldest.
  const kept = before.filter((layer) => !members.has(layer.id) || picked.includes(layer.id));
  const added = picked.filter((id) => !kept.some((layer) => layer.id === id))
    .map((id) => layers.find((layer) => layer.id === id)!)
    .filter(Boolean);
  const next = capLayerSelection([...kept, ...added]).map((layer) => layer.id);
  const venues = readVenuesSetting(settings, before.length);
  return { ...settings, [LAYERS_SETTING_KEY]: next, [VENUES_SETTING_KEY]: venues };
}

export interface GeoView {
  bbox: GeoBbox;
  /** 0 for the whole world, one more for each doubling, as the server reads it. */
  zoom: number;
}

export const WORLD_GEO_VIEW: GeoView = { bbox: [-180, -90, 180, 90], zoom: 0 };

/** The map shows all 360 degrees at its widest, so each doubling of its zoom is one level. */
function geoZoomLevel(viewport: WorldMapViewport): number {
  return Math.log2(Math.max(1, viewport.zoom));
}

/** What a viewport covers, rounded so small pans reuse the same request. */
export function geoViewForViewport(
  viewport: WorldMapViewport,
  width: number,
  height: number,
  yUnitAspect = 1,
): GeoView {
  if (viewport.zoom <= 1 || width <= 1 || height <= 1) return WORLD_GEO_VIEW;
  const topLeft = unprojectWorldPoint(0, 0, width, height, yUnitAspect, viewport);
  const bottomRight = unprojectWorldPoint(width - 1, height - 1, width, height, yUnitAspect, viewport);
  const step = viewport.zoom >= 6 ? 0.1 : 0.5;
  const floor = (value: number) => Math.floor(value / step) * step;
  const ceil = (value: number) => Math.ceil(value / step) * step;
  const round = (value: number) => Number(value.toFixed(2));
  return {
    bbox: [
      round(Math.max(-180, floor(topLeft.longitude))),
      round(Math.max(-90, floor(bottomRight.latitude))),
      round(Math.min(180, ceil(bottomRight.longitude))),
      round(Math.min(90, ceil(topLeft.latitude))),
    ],
    zoom: Number(geoZoomLevel(viewport).toFixed(1)),
  };
}

export function geoViewKey(view: GeoView): string {
  return `${view.bbox.join(",")}@${Math.floor(view.zoom)}`;
}

export function sameGeoView(left: GeoView, right: GeoView): boolean {
  return geoViewKey(left) === geoViewKey(right);
}

/** The point a feature is placed, selected and centred at. */
export function featureAnchor(feature: Pick<GeoFeature, "geometry">): [number, number] {
  const geometry = feature.geometry;
  if (geometry.type === "Point") return geometry.coordinates;
  const points = geometry.type === "LineString" ? geometry.coordinates : geometry.coordinates.flat();
  if (!points.length) return [0, 0];
  if (geometry.type === "LineString") return points[Math.floor(points.length / 2)]!;
  const lon = points.reduce((sum, point) => sum + point[0], 0) / points.length;
  const lat = points.reduce((sum, point) => sum + point[1], 0) / points.length;
  return [lon, lat];
}

/** Lines of a feature as coordinate runs; areas give their rings. */
export function featureLines(feature: Pick<GeoFeature, "geometry">): [number, number][][] {
  const geometry = feature.geometry;
  switch (geometry.type) {
    case "Point": return [];
    case "LineString": return [geometry.coordinates];
    case "MultiLineString": return geometry.coordinates;
    case "Polygon": return geometry.coordinates;
  }
}

function groupDigits(value: number, decimals: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function relativeAge(iso: string, now: number): string | null {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 36 * 3600) return `${Math.round(seconds / 3600)}h ago`;
  return shortDate(iso);
}

/** A column that reads as a change (a sign and a colour), not a level such as a share. */
export function isChangeColumn(column: Pick<GeoColumn, "key" | "label" | "format">): boolean {
  return column.format === "percent1" && /chg|change|delta/i.test(`${column.key} ${column.label}`);
}

/** A prop as the table shows it; `signed` puts a + on rises. */
export function formatGeoValue(value: GeoPropValue | undefined, format: GeoColumnFormat | undefined, now = Date.now(), signed = false): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    switch (format) {
      case "int": return groupDigits(Math.round(value), 0);
      case "decimal1": return groupDigits(value, 1);
      // Percentage points: 12.3 reads 12.3%.
      case "percent1": return `${signed && value > 0 ? "+" : ""}${value.toFixed(1)}%`;
      case "knots": return `${value.toFixed(1)} kn`;
      case "km": return `${groupDigits(Math.round(value), 0)} km`;
      // Identifiers (an MMSI, an IMO number) read as written.
      case "text": return String(value);
      default: return Number.isInteger(value) ? groupDigits(value, 0) : String(value);
    }
  }
  if (format === "datetime") return relativeAge(value, now) ?? value;
  // Class words arrive lower case ("tanker"); a table reads them capitalised.
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** The same prop as exports and reports write it: a bare number or the source text. */
export function plainGeoValue(value: GeoPropValue | undefined): number | string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? "yes" : "no";
  return value;
}

export function tickerLinkKey(link: GeoTickerLink): string {
  return publicTickerKey(link.symbol, link.exchange);
}

/** The ticker column: the first link, and a count of the rest. */
export function formatTickerLinks(links: readonly GeoTickerLink[] | undefined): string {
  if (!links?.length) return "";
  const first = links[0]!.symbol;
  return links.length > 1 ? `${first} +${links.length - 1}` : first;
}

export function columnValue(row: { label: string; props: Record<string, GeoPropValue> }, column: GeoColumn): GeoPropValue {
  return column.key === "label" ? row.label : row.props[column.key] ?? null;
}
