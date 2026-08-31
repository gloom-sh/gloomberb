import type { CloudWorldVenuePayload } from "../../../api-client";

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

const MAX_LATITUDE = 85;
const MIN_LATITUDE = -60;
const LONGITUDE_SPAN = 360;
export const MAX_WORLD_MAP_ZOOM = 18;

export const DEFAULT_WORLD_MAP_VIEWPORT: WorldMapViewport = {
  zoom: 1,
  centerLongitude: 0,
  centerLatitude: (MAX_LATITUDE + MIN_LATITUDE) / 2,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function mapExtent(width: number, height: number, yUnitAspect = 1) {
  const availableWidth = Math.max(width - 1, 0);
  const availableHeight = Math.max(height - 1, 0);
  const unitAspect = Math.max(yUnitAspect, Number.EPSILON);
  const effectiveHeight = availableHeight * unitAspect;
  const latitudeSpan = MAX_LATITUDE - MIN_LATITUDE;
  return { availableWidth, availableHeight, unitAspect, effectiveHeight, latitudeSpan };
}

function fittedWorldMapScale(width: number, height: number, yUnitAspect = 1): number {
  const { availableWidth, effectiveHeight, latitudeSpan } = mapExtent(width, height, yUnitAspect);
  return Math.min(availableWidth / LONGITUDE_SPAN, effectiveHeight / latitudeSpan);
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
  const clampedLatitude = clamp(latitude, MIN_LATITUDE, MAX_LATITUDE);

  return {
    x: availableWidth / 2 + (longitude - viewport.centerLongitude) * scale,
    y: (effectiveHeight / 2 - (clampedLatitude - viewport.centerLatitude) * scale) / unitAspect,
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
    latitude: viewport.centerLatitude - (y * unitAspect - effectiveHeight / 2) / scale,
  };
}

export function clampWorldMapViewport(
  viewport: WorldMapViewport,
  width: number,
  height: number,
  yUnitAspect = 1,
): WorldMapViewport {
  const zoom = clamp(viewport.zoom, 1, MAX_WORLD_MAP_ZOOM);
  if (zoom <= 1) return DEFAULT_WORLD_MAP_VIEWPORT;

  const { availableWidth, effectiveHeight, latitudeSpan } = mapExtent(width, height, yUnitAspect);
  const scale = fittedWorldMapScale(width, height, yUnitAspect) * zoom;
  const halfLongitude = availableWidth / (2 * scale);
  const halfLatitude = effectiveHeight / (2 * scale);
  const minLongitude = -180 + halfLongitude;
  const maxLongitude = 180 - halfLongitude;
  const minLatitude = MIN_LATITUDE + halfLatitude;
  const maxLatitude = MAX_LATITUDE - halfLatitude;

  return {
    zoom,
    centerLongitude: minLongitude < maxLongitude
      ? clamp(viewport.centerLongitude, minLongitude, maxLongitude)
      : DEFAULT_WORLD_MAP_VIEWPORT.centerLongitude,
    centerLatitude: halfLatitude < latitudeSpan / 2
      ? clamp(viewport.centerLatitude, minLatitude, maxLatitude)
      : DEFAULT_WORLD_MAP_VIEWPORT.centerLatitude,
  };
}

export function zoomWorldMapViewport(
  viewport: WorldMapViewport,
  width: number,
  height: number,
  point: WorldMapPoint,
  zoomFactor: number,
  yUnitAspect = 1,
): WorldMapViewport {
  const nextZoom = clamp(viewport.zoom * zoomFactor, 1, MAX_WORLD_MAP_ZOOM);
  if (nextZoom <= 1) return DEFAULT_WORLD_MAP_VIEWPORT;

  const geographic = unprojectWorldPoint(point.x, point.y, width, height, yUnitAspect, viewport);
  const { availableWidth, unitAspect, effectiveHeight } = mapExtent(width, height, yUnitAspect);
  const scale = fittedWorldMapScale(width, height, yUnitAspect) * nextZoom;
  return clampWorldMapViewport({
    zoom: nextZoom,
    centerLongitude: geographic.longitude - (point.x - availableWidth / 2) / scale,
    centerLatitude: geographic.latitude + (point.y * unitAspect - effectiveHeight / 2) / scale,
  }, width, height, yUnitAspect);
}

export function panWorldMapViewport(
  viewport: WorldMapViewport,
  width: number,
  height: number,
  deltaX: number,
  deltaY: number,
  yUnitAspect = 1,
): WorldMapViewport {
  if (viewport.zoom <= 1) return DEFAULT_WORLD_MAP_VIEWPORT;
  const scale = worldMapScale(width, height, yUnitAspect, viewport);
  const unitAspect = Math.max(yUnitAspect, Number.EPSILON);
  return clampWorldMapViewport({
    zoom: viewport.zoom,
    centerLongitude: viewport.centerLongitude - deltaX / scale,
    centerLatitude: viewport.centerLatitude + (deltaY * unitAspect) / scale,
  }, width, height, yUnitAspect);
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
