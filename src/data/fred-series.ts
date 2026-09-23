import { createPluginCache } from "./plugin-cache";
import { getPublishedUsEquityCalendarDay } from "../market-data/published-us-sessions";
import type {
  CloudFredObservationPayload,
  CloudFredSeriesInfoPayload,
} from "../api-client";

const CACHE_KIND = "fred-series";
const CACHE_SOURCE = "gloomberb-cloud";
// Refresh persisted metadata that predates FRED's source coverage dates.
const CACHE_SCHEMA_VERSION = 2;
const CACHE_POLICY = {
  staleMs: 24 * 60 * 60 * 1000,
  expireMs: 30 * 24 * 60 * 60 * 1000,
} as const;
// Cloud re-reads a daily series this often until the last business day is published.
const PUBLICATION_PENDING_REFRESH_MS = 30 * 60 * 1000;
const DAY_MS = 86_400_000;
const newYorkDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});

export interface FredSeriesData {
  observations: CloudFredObservationPayload[];
  info: CloudFredSeriesInfoPayload | null;
  fetchedAt?: string;
  stale?: boolean;
  coverage?: { observations: "available"; info: "available" | "unavailable" };
}

export interface FredSeriesRequest {
  seriesId: string;
  startDate?: string;
  limit?: number;
  sortOrder: "asc" | "desc";
}

export interface FredSeriesCacheEntry {
  data: FredSeriesData;
  fetchedAt: number;
  stale: boolean;
}

export interface FredSeriesLoadResult extends FredSeriesCacheEntry {
  source: "cache" | "network" | "stale-fallback";
  refreshError?: string;
}

const cache = createPluginCache<FredSeriesData>({
  kind: CACHE_KIND, source: CACHE_SOURCE, schemaVersion: CACHE_SCHEMA_VERSION, policy: CACHE_POLICY,
});
const hydratedSeries = new Map<string, FredSeriesCacheEntry>();
export const attachFredSeriesPersistence = cache.attach;

function seriesKey(seriesId: string): string {
  return seriesId.trim().toUpperCase();
}

/** Hydrates server-fetched data for renderers that cannot call the cloud API directly. */
export function hydrateFredSeries(entries: readonly (readonly [string, FredSeriesCacheEntry])[]): void {
  hydratedSeries.clear();
  for (const [seriesId, entry] of entries) hydratedSeries.set(seriesKey(seriesId), entry);
}

export function resetFredSeriesPersistence(): void {
  cache.reset();
  hydratedSeries.clear();
}

function cacheKey(request: FredSeriesRequest): string {
  const range = [
    request.startDate ? `start=${request.startDate}` : "",
    request.limit ? `limit=${request.limit}` : "",
    `sort=${request.sortOrder}`,
  ].filter(Boolean).join(":");
  return `${request.seriesId.trim().toUpperCase()}:${range}`;
}

export function getCachedFredSeries(
  request: FredSeriesRequest,
  options?: { allowExpired?: boolean },
): FredSeriesCacheEntry | null {
  const entry = cache.get(cacheKey(request), options);
  return entry ? withFredSourceFreshness(entry) : null;
}

export function withFredSourceFreshness<T extends FredSeriesCacheEntry>(entry: T): T {
  const sourceTime = entry.data.fetchedAt ? Date.parse(entry.data.fetchedAt) : NaN;
  return {
    ...entry,
    fetchedAt: Number.isFinite(sourceTime) ? Math.min(sourceTime, entry.fetchedAt) : entry.fetchedAt,
    stale: entry.stale || entry.data.stale === true,
  };
}

function isUsBusinessDay(time: number): boolean {
  const date = new Date(time).toISOString().slice(0, 10);
  const day = getPublishedUsEquityCalendarDay("NYSE", date);
  const weekday = new Date(time).getUTCDay();
  return day === "session" || (day == null && weekday !== 0 && weekday !== 6);
}

/**
 * Whether a daily series fetched at `fetchedAt` should be re-read before its
 * nominal staleness: it still ends before the previous US business day, so the
 * morning publication may have landed since. Weekends and holidays publish
 * nothing, so the nominal policy applies on those days.
 */
export function isFredPublicationPending(
  observations: readonly CloudFredObservationPayload[],
  fetchedAt: number,
  now = Date.now(),
): boolean {
  if (!(now - fetchedAt >= PUBLICATION_PENDING_REFRESH_MS)) return false;
  const recent = observations.map((point) => point.date.slice(0, 10)).sort().slice(-6);
  const daily = recent.length >= 3 && recent.every((date, index) =>
    index === 0 || Date.parse(date) - Date.parse(recent[index - 1]!) <= 4 * DAY_MS);
  if (!daily) return false;
  const today = Date.parse(`${newYorkDate.format(now)}T00:00:00Z`);
  if (!isUsBusinessDay(today)) return false;
  for (let offset = 1; offset <= 10; offset++) {
    const day = today - offset * DAY_MS;
    if (isUsBusinessDay(day)) return recent.at(-1)! < new Date(day).toISOString().slice(0, 10);
  }
  return false;
}

export async function loadCachedFredSeries(
  request: FredSeriesRequest,
  loader: () => Promise<FredSeriesData>,
  options?: { force?: boolean },
): Promise<FredSeriesLoadResult> {
  const stored = cache.get(cacheKey(request));
  const pending = !!stored && !stored.stale && isFredPublicationPending(stored.data.observations ?? [], stored.fetchedAt);
  const cached = stored ? withFredSourceFreshness(stored) : null;
  if (!options?.force && !pending && cached && !cached.stale) return { ...cached, source: "cache" };
  const hydrated = hydratedSeries.get(seriesKey(request.seriesId));
  if (!options?.force && hydrated) return { ...withFredSourceFreshness(hydrated), source: "cache" };
  const result = await cache.load(cacheKey(request), loader, pending ? { ...options, force: true } : options);
  // An early re-read is opportunistic: a failure keeps the still-fresh copy as it was.
  if (pending && result.refreshError && cached && !cached.stale && !options?.force) return { ...cached, source: "cache" };
  return withFredSourceFreshness(result);
}
