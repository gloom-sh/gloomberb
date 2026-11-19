import type { CloudWorldVenuePayload } from "../../../api-client";
import { getGeoEntities, loadGeoCatalog, type GeoBbox, type GeoRequest } from "../../../api-client/geo";
import type { AppConfig, PaneInstanceConfig } from "../../../types/config";
import { HOME_AREA_SETTING_KEY } from "./layers";
import { savedWorldMapViewport } from "./model";
import { logFailure } from "../../../utils/log-failure";

export interface MapPlace {
  label: string;
  longitude: number;
  latitude: number;
  zoom: number;
}

export interface MapStart {
  place: MapPlace | null;
  note: string | null;
  /** The place is the home area from the app's settings, not one the pane was made with. */
  home?: true;
}

export function mapHomeArea(config: AppConfig): string {
  const value = config.pluginConfig?.["market-overview"]?.[HOME_AREA_SETTING_KEY];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The pane as a share carries it, without a starting place that is the home
 * area: maps made before the home area was read at render time stored it in
 * their settings and, with a layer preset, in their title.
 */
export function paneWithoutHomeArea(pane: PaneInstanceConfig, homeArea: string): PaneInstanceConfig {
  const place = pane.settings?.place;
  const same = (left: string, right: string) => left.trim().toLowerCase() === right.trim().toLowerCase();
  if (!homeArea.trim() || typeof place !== "string" || !same(place, homeArea)) return pane;
  const { place: _place, ...settings } = pane.settings!;
  const suffix = ` · ${place.trim()}`;
  const title = pane.title?.trim();
  const shortened = title && title.length > suffix.length && same(title.slice(-suffix.length), suffix)
    ? title.slice(0, -suffix.length)
    : pane.title;
  return { ...pane, settings, ...(shortened === undefined ? {} : { title: shortened }) };
}

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export async function resolveMapPlace(
  text: string,
  sources: { venues: () => Promise<readonly CloudWorldVenuePayload[]>; request: GeoRequest; signal?: AbortSignal },
): Promise<MapStart> {
  const typed = text.trim();
  if (!typed) return { place: null, note: null };
  const coordinates = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*,\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/.exec(typed);
  if (coordinates) {
    const latitude = Number(coordinates[1]);
    const longitude = Number(coordinates[2]);
    if (Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
      return { place: { label: typed, latitude, longitude, zoom: 32 }, note: null };
    }
  } else {
    const name = normalize(typed);
    const { COUNTRY_LABELS } = await import("./natural-earth/labels.chunk.js");
    const country = COUNTRY_LABELS.find(([label]) => normalize(label) === name);
    if (country) return { place: { label: country[0], longitude: country[1], latitude: country[2], zoom: 4 }, note: null };
    const venues = await sources.venues().catch((error: unknown) => {
      logFailure("world-venue-map.place", "Loading venue places failed")(error);
      return [];
    });
    const venue = venues.find((entry) => [entry.city, entry.title, entry.mic, entry.country, entry.countryCode].some((label) => normalize(label) === name));
    if (venue) return { place: { label: typed, longitude: venue.longitude, latitude: venue.latitude, zoom: 32 }, note: null };
    const catalog = await loadGeoCatalog(sources.request, { signal: sources.signal });
    const layers = [...(catalog?.layers ?? [])].sort((left, right) => {
      const priority = (id: string) => ["chokepoints", "ports", "airports"].indexOf(id);
      const rank = (id: string) => priority(id) < 0 ? 3 : priority(id);
      return rank(left.id) - rank(right.id);
    });
    for (const layer of layers) {
      if (layer.status === "unavailable" || sources.signal?.aborted) continue;
      const page = await getGeoEntities(sources.request, layer.id, { q: typed, limit: 20 }, sources.signal).catch((error: unknown) => {
        if (!sources.signal?.aborted) logFailure("world-venue-map.place", "Searching map places failed")(error);
        return null;
      });
      const row = page?.rows.find((entry) => Number.isFinite(entry.lon) && Number.isFinite(entry.lat)
        && [entry.label, entry.id, ...Object.values(entry.props).filter((value): value is string => typeof value === "string")]
          .some((value) => normalize(value) === name)) ?? (page?.rows.length === 1 ? page.rows[0] : null);
      if (row && Number.isFinite(row.lon) && Number.isFinite(row.lat)) {
        return { place: { label: row.label, longitude: row.lon, latitude: row.lat, zoom: 32 }, note: null };
      }
    }
  }
  return { place: null, note: `Unknown place "${typed}"; showing world.` };
}

export function mapPlaceBbox(place: MapPlace): GeoBbox {
  const span = 180 / place.zoom;
  const west = place.longitude - span;
  const east = place.longitude + span;
  return [west < -180 ? west + 360 : west, Math.max(-90, place.latitude - span), east > 180 ? east - 360 : east, Math.min(90, place.latitude + span)];
}

export function initialMapFocus(place: MapPlace | null, savedViewport: unknown, transient = false) {
  return place && !savedWorldMapViewport(savedViewport)
    ? { key: "initial-place", ...place, initial: true, ...(transient ? { transient: true } : {}) }
    : null;
}

export function nearestPlaces<Row>(rows: readonly Row[], place: MapPlace | null, point: (row: Row) => { longitude: number; latitude: number }): Row[] {
  if (!place) return [...rows];
  const distance = (row: Row) => {
    const location = point(row);
    const radians = Math.PI / 180;
    return Math.sin((location.latitude - place.latitude) * radians / 2) ** 2
      + Math.cos(place.latitude * radians) * Math.cos(location.latitude * radians)
      * Math.sin((location.longitude - place.longitude) * radians / 2) ** 2;
  };
  return [...rows].sort((left, right) => distance(left) - distance(right));
}
