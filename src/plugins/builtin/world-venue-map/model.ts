import type { CloudWorldVenuePayload } from "../../../api-client";
import { clamp } from "../../../utils/math";

export interface WorldMapPoint {
  x: number;
  y: number;
}

export interface WorldVenueCluster extends WorldMapPoint {
  id: string;
  venues: CloudWorldVenuePayload[];
  isOpen: boolean;
}

export interface WorldMapViewport {
  zoom: number;
  centerLongitude: number;
  centerLatitude: number;
}

/** The map's northern and southern edges; the land data is cut at the south one. */
export const MAX_LATITUDE = 80;
export const MIN_LATITUDE = -60;
const LONGITUDE_SPAN = 360;
/** The most the map zooms in a narrow pane: 4,096 times the world. A wider pane stops sooner, at a pixel density (see map.tsx). */
export const MAX_WORLD_MAP_ZOOM = 4096;

/** Web Mercator stops here, where the projection runs to infinity. */
const MERCATOR_LIMIT = 85.0511287798;

/**
 * Where a latitude falls on the map's vertical axis: Mercator, in degrees of
 * longitude at the equator, so one unit north is one unit east wherever the
 * point is. That keeps a country's proportions at every latitude, as on any
 * web map. Plain latitude would stretch everything sideways by 1/cos(latitude):
 * France drew about 1.4 times wider than it is tall.
 */
export function mercatorY(latitude: number): number {
  const radians = (clamp(latitude, -MERCATOR_LIMIT, MERCATOR_LIMIT) * Math.PI) / 180;
  return (Math.log(Math.tan(Math.PI / 4 + radians / 2)) * 180) / Math.PI;
}

/** The latitude at a Mercator `y`, the inverse of {@link mercatorY}. */
function latitudeAtMercatorY(y: number): number {
  return (Math.atan(Math.exp((y * Math.PI) / 180)) * 360) / Math.PI - 90;
}

const MERCATOR_TOP = mercatorY(MAX_LATITUDE);
const MERCATOR_BOTTOM = mercatorY(MIN_LATITUDE);
const MERCATOR_SPAN = MERCATOR_TOP - MERCATOR_BOTTOM;

/** The whole map's height over its width, for a pane that sizes itself to the world. */
export const WORLD_MAP_HEIGHT_RATIO = MERCATOR_SPAN / LONGITUDE_SPAN;

export const DEFAULT_WORLD_MAP_VIEWPORT: WorldMapViewport = {
  zoom: 1,
  centerLongitude: 0,
  centerLatitude: latitudeAtMercatorY((MERCATOR_TOP + MERCATOR_BOTTOM) / 2),
};

function mapExtent(width: number, height: number, yUnitAspect = 1) {
  const availableWidth = Math.max(width - 1, 0);
  const availableHeight = Math.max(height - 1, 0);
  const unitAspect = Math.max(yUnitAspect, Number.EPSILON);
  const effectiveHeight = availableHeight * unitAspect;
  return { availableWidth, availableHeight, unitAspect, effectiveHeight, mercatorSpan: MERCATOR_SPAN };
}

function fittedWorldMapScale(width: number, height: number, yUnitAspect = 1): number {
  const { availableWidth, effectiveHeight, mercatorSpan } = mapExtent(width, height, yUnitAspect);
  return Math.min(availableWidth / LONGITUDE_SPAN, effectiveHeight / mercatorSpan);
}

/**
 * The zoom at which the map draws `unitsPerDegree` view units to each degree of
 * longitude, so a ceiling set in screen pixels follows the size of the pane.
 */
export function zoomForDegreeScale(unitsPerDegree: number, width: number, height: number, yUnitAspect = 1): number {
  const fit = fittedWorldMapScale(width, height, yUnitAspect);
  return fit > 0 ? unitsPerDegree / fit : Number.POSITIVE_INFINITY;
}

function worldMapScale(
  width: number,
  height: number,
  yUnitAspect: number,
  viewport: WorldMapViewport,
): number {
  return fittedWorldMapScale(width, height, yUnitAspect) * Math.max(viewport.zoom, 1);
}

export function projectWorldPoint(
  longitude: number,
  latitude: number,
  width: number,
  height: number,
  yUnitAspect = 1,
  viewport: WorldMapViewport = DEFAULT_WORLD_MAP_VIEWPORT,
): WorldMapPoint {
  const { availableWidth, unitAspect, effectiveHeight } = mapExtent(width, height, yUnitAspect);
  const scale = worldMapScale(width, height, yUnitAspect, viewport);
  const northing = mercatorY(clamp(latitude, MIN_LATITUDE, MAX_LATITUDE)) - mercatorY(viewport.centerLatitude);

  return {
    x: availableWidth / 2 + (longitude - viewport.centerLongitude) * scale,
    y: (effectiveHeight / 2 - northing * scale) / unitAspect,
  };
}

export function unprojectWorldPoint(
  x: number,
  y: number,
  width: number,
  height: number,
  yUnitAspect = 1,
  viewport: WorldMapViewport = DEFAULT_WORLD_MAP_VIEWPORT,
): { longitude: number; latitude: number } {
  const { availableWidth, unitAspect, effectiveHeight } = mapExtent(width, height, yUnitAspect);
  const scale = worldMapScale(width, height, yUnitAspect, viewport);
  return {
    longitude: viewport.centerLongitude + (x - availableWidth / 2) / scale,
    latitude: latitudeAtMercatorY(mercatorY(viewport.centerLatitude) - (y * unitAspect - effectiveHeight / 2) / scale),
  };
}

export function clampWorldMapViewport(
  viewport: WorldMapViewport,
  width: number,
  height: number,
  yUnitAspect = 1,
  maxZoom = MAX_WORLD_MAP_ZOOM,
): WorldMapViewport {
  const zoom = clamp(viewport.zoom, 1, maxZoom);
  if (zoom <= 1) return DEFAULT_WORLD_MAP_VIEWPORT;

  const { availableWidth, effectiveHeight, mercatorSpan } = mapExtent(width, height, yUnitAspect);
  // A plot with no area yet (a pane mid-layout) says nothing about what fits:
  // keep the centre rather than resetting it to the middle of the world.
  if (availableWidth <= 0 || effectiveHeight <= 0) return { ...viewport, zoom };
  const scale = fittedWorldMapScale(width, height, yUnitAspect) * zoom;
  const halfLongitude = availableWidth / (2 * scale);
  const halfNorthing = effectiveHeight / (2 * scale);
  const minLongitude = -180 + halfLongitude;
  const maxLongitude = 180 - halfLongitude;
  const minNorthing = MERCATOR_BOTTOM + halfNorthing;
  const maxNorthing = MERCATOR_TOP - halfNorthing;

  return {
    zoom,
    centerLongitude: minLongitude < maxLongitude
      ? clamp(viewport.centerLongitude, minLongitude, maxLongitude)
      : DEFAULT_WORLD_MAP_VIEWPORT.centerLongitude,
    centerLatitude: halfNorthing < mercatorSpan / 2
      ? latitudeAtMercatorY(clamp(mercatorY(viewport.centerLatitude), minNorthing, maxNorthing))
      : DEFAULT_WORLD_MAP_VIEWPORT.centerLatitude,
  };
}

/** A viewport read back from saved pane state, or null when it is not one. */
export function savedWorldMapViewport(value: unknown, maxZoom = MAX_WORLD_MAP_ZOOM): WorldMapViewport | null {
  if (!value || typeof value !== "object") return null;
  const { zoom, centerLongitude, centerLatitude } = value as Partial<WorldMapViewport>;
  if (![zoom, centerLongitude, centerLatitude].every((part) => typeof part === "number" && Number.isFinite(part))) return null;
  if (zoom! <= 1) return DEFAULT_WORLD_MAP_VIEWPORT;
  return {
    zoom: Math.min(zoom!, maxZoom),
    centerLongitude: clamp(centerLongitude!, -180, 180),
    centerLatitude: clamp(centerLatitude!, MIN_LATITUDE, MAX_LATITUDE),
  };
}

export function zoomWorldMapViewport(
  viewport: WorldMapViewport,
  width: number,
  height: number,
  point: WorldMapPoint,
  zoomFactor: number,
  yUnitAspect = 1,
  maxZoom = MAX_WORLD_MAP_ZOOM,
): WorldMapViewport {
  const nextZoom = clamp(viewport.zoom * zoomFactor, 1, maxZoom);
  if (nextZoom <= 1) return DEFAULT_WORLD_MAP_VIEWPORT;

  const geographic = unprojectWorldPoint(point.x, point.y, width, height, yUnitAspect, viewport);
  const { availableWidth, unitAspect, effectiveHeight } = mapExtent(width, height, yUnitAspect);
  const scale = fittedWorldMapScale(width, height, yUnitAspect) * nextZoom;
  return clampWorldMapViewport({
    zoom: nextZoom,
    centerLongitude: geographic.longitude - (point.x - availableWidth / 2) / scale,
    centerLatitude: latitudeAtMercatorY(mercatorY(geographic.latitude) + (point.y * unitAspect - effectiveHeight / 2) / scale),
  }, width, height, yUnitAspect, maxZoom);
}

export function panWorldMapViewport(
  viewport: WorldMapViewport,
  width: number,
  height: number,
  deltaX: number,
  deltaY: number,
  yUnitAspect = 1,
  maxZoom = MAX_WORLD_MAP_ZOOM,
): WorldMapViewport {
  if (viewport.zoom <= 1) return DEFAULT_WORLD_MAP_VIEWPORT;
  const scale = worldMapScale(width, height, yUnitAspect, viewport);
  const unitAspect = Math.max(yUnitAspect, Number.EPSILON);
  return clampWorldMapViewport({
    zoom: viewport.zoom,
    centerLongitude: viewport.centerLongitude - deltaX / scale,
    centerLatitude: latitudeAtMercatorY(mercatorY(viewport.centerLatitude) + (deltaY * unitAspect) / scale),
  }, width, height, yUnitAspect, maxZoom);
}

export function clusterWorldVenues(
  venues: readonly CloudWorldVenuePayload[],
  width: number,
  height: number,
  yUnitAspect = 1,
  viewport: WorldMapViewport = DEFAULT_WORLD_MAP_VIEWPORT,
): WorldVenueCluster[] {
  const buckets = new Map<string, CloudWorldVenuePayload[]>();
  const cellWidth = Math.max(4, Math.round(width / 18));
  const cellHeight = Math.max(2, Math.round(height / 12));

  for (const venue of venues) {
    const point = projectWorldPoint(venue.longitude, venue.latitude, width, height, yUnitAspect, viewport);
    const key = `${Math.floor(point.x / cellWidth)}:${Math.floor(point.y / cellHeight)}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(venue);
    buckets.set(key, bucket);
  }

  return [...buckets.entries()].map(([id, grouped]) => {
    const point = grouped.reduce(
      (sum, venue) => {
        const projected = projectWorldPoint(venue.longitude, venue.latitude, width, height, yUnitAspect, viewport);
        return { x: sum.x + projected.x, y: sum.y + projected.y };
      },
      { x: 0, y: 0 },
    );
    return {
      id,
      x: point.x / grouped.length,
      y: point.y / grouped.length,
      venues: grouped,
      isOpen: grouped.some((venue) => venue.isOpen),
    };
  });
}

export function filterWorldVenues(
  venues: readonly CloudWorldVenuePayload[],
  query: string,
): CloudWorldVenuePayload[] {
  const normalized = query.trim().toLocaleLowerCase();
  return venues
    .filter((venue) => !normalized || [
      venue.mic,
      venue.name,
      venue.title,
      venue.city,
      venue.country,
      venue.countryCode,
    ].some((value) => value.toLocaleLowerCase().includes(normalized)))
    .sort((left, right) => Number(right.isOpen) - Number(left.isOpen)
      || left.name.localeCompare(right.name)
      || left.mic.localeCompare(right.mic));
}

export function closestWorldVenueCluster(
  clusters: readonly WorldVenueCluster[],
  x: number,
  y: number,
  maxDistance: number,
): WorldVenueCluster | null {
  let closest: WorldVenueCluster | null = null;
  let distance = maxDistance;
  for (const cluster of clusters) {
    const next = Math.hypot(cluster.x - x, cluster.y - y);
    if (next <= distance) {
      closest = cluster;
      distance = next;
    }
  }
  return closest;
}

const localTimeFormatters = new Map<string, Intl.DateTimeFormat>();

export function formatVenueLocalTime(timezone: string, now: number): string {
  let formatter = localTimeFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    localTimeFormatters.set(timezone, formatter);
  }
  return formatter.format(now);
}

export function venueRemainingSeconds(
  venue: CloudWorldVenuePayload,
  checkedAt: number,
  now: number,
): number | null {
  const source = venue.isOpen ? venue.timeToCloseSeconds : venue.timeToOpenSeconds;
  if (source == null) return null;
  return Math.max(0, source - Math.floor((now - checkedAt) / 1_000));
}

export function formatVenueCountdown(seconds: number | null): string {
  if (seconds == null) return "";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}
