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

const MAX_LATITUDE = 85;
const MIN_LATITUDE = -60;

export function projectWorldPoint(
  longitude: number,
  latitude: number,
  width: number,
  height: number,
): WorldMapPoint {
  return {
    x: ((longitude + 180) / 360) * Math.max(width - 1, 0),
    y: ((MAX_LATITUDE - Math.max(MIN_LATITUDE, Math.min(MAX_LATITUDE, latitude)))
      / (MAX_LATITUDE - MIN_LATITUDE)) * Math.max(height - 1, 0),
  };
}

export function clusterWorldVenues(
  venues: readonly CloudWorldVenuePayload[],
  width: number,
  height: number,
): WorldVenueCluster[] {
  const buckets = new Map<string, CloudWorldVenuePayload[]>();
  const cellWidth = Math.max(4, Math.round(width / 18));
  const cellHeight = Math.max(2, Math.round(height / 12));

  for (const venue of venues) {
    const point = projectWorldPoint(venue.longitude, venue.latitude, width, height);
    const key = `${Math.floor(point.x / cellWidth)}:${Math.floor(point.y / cellHeight)}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(venue);
    buckets.set(key, bucket);
  }

  return [...buckets.entries()].map(([id, grouped]) => {
    const point = grouped.reduce(
      (sum, venue) => {
        const projected = projectWorldPoint(venue.longitude, venue.latitude, width, height);
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
