import { apiClient } from "../../../api-client";
import type {
  EarningsCalendarPayload,
  EarningsCalendarQuery,
  EarningsHistoryPayload,
  EarningsReport,
} from "../../../api-client/earnings";
import { ApiRequestError } from "../../../api-client/errors";
import { createPluginCache } from "../../../data/plugin-cache";
import type { PluginPersistence } from "../../../types/plugin";
import { cachedCloudResource, loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";

// Implied moves are captured through the session, so the board goes stale in minutes; history in hours.
const calendarCache = createPluginCache<EarningsCalendarPayload>({
  kind: "earnings-board", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 5 * 60_000, expireMs: 7 * 24 * 60 * 60_000 },
});
const historyCache = createPluginCache<EarningsHistoryPayload>({
  kind: "earnings-history", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 30 * 60_000, expireMs: 7 * 24 * 60 * 60_000 },
});

export function attachEarningsCloudCaches(persistence: PluginPersistence) {
  calendarCache.attach(persistence);
  historyCache.attach(persistence);
}

export function resetEarningsCloudCaches() {
  calendarCache.reset();
  historyCache.reset();
}

const isDate = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
const numberOrNull = (value: unknown) => value === null || (typeof value === "number" && Number.isFinite(value));

function validReport(report: EarningsReport): boolean {
  return !!report && typeof report.symbol === "string" && isDate(report.date)
    && [null, "bmo", "dmh", "amc"].includes(report.timing)
    && [report.marketCap, report.epsEstimate, report.epsActual, report.revenueEstimate].every(numberOrNull)
    && (report.implied === null || (typeof report.implied === "object" && Number.isFinite(report.implied.move) && isDate(report.implied.expiry)))
    && (report.realized === null || (typeof report.realized === "object" && Number.isFinite(report.realized.move)));
}

function validateEarningsCalendar(payload: EarningsCalendarPayload): EarningsCalendarPayload {
  if (!payload || !isDate(payload.from) || !isDate(payload.to) || !Array.isArray(payload.reports)
    || payload.reports.some((report) => !validReport(report) || !numberOrNull(report.averageMove))) {
    throw new Error("The server returned an invalid earnings calendar");
  }
  return payload;
}

/** The listing asked for: a Hong Kong code reads the same with or without its leading zeros (700:HKEX is 0700:HKEX). */
export function sameHistoryListing(served: unknown, asked: string): boolean {
  if (served === asked) return true;
  const code = (value: string) => /^(\d+):HKEX$/i.exec(value)?.[1]?.replace(/^0+(?=\d)/, "") ?? null;
  return typeof served === "string" && code(asked) != null && code(served) === code(asked);
}

function validateEarningsHistory(payload: EarningsHistoryPayload, symbol: string): EarningsHistoryPayload {
  if (!payload || !sameHistoryListing(payload.symbol, symbol) || !Array.isArray(payload.reports)
    || payload.reports.some((report) => !validReport(report) || !numberOrNull(report.revenueActual))) {
    throw new Error("The server returned an invalid earnings history");
  }
  return payload;
}

type CalendarClient = Pick<typeof apiClient, "getCloudEarningsCalendar">;
type HistoryClient = Pick<typeof apiClient, "getCloudEarningsHistory">;

/** Names a calendar query: the cache's key, and how the board tells one week's reports from another's. */
export const earningsCalendarKey = (query: EarningsCalendarQuery) =>
  `${query.from}:${query.to}:${query.perDay ?? ""}:${[...(query.symbols ?? [])].sort().join(",")}`;

export async function fetchEarningsCalendar(query: EarningsCalendarQuery, client: CalendarClient = apiClient) {
  try {
    return validateEarningsCalendar(await client.getCloudEarningsCalendar(query));
  } catch (error) {
    throw unavailableOnServer(error, "The earnings calendar is not available yet.", [404, 503]);
  }
}

export async function fetchEarningsHistory(symbol: string, client: HistoryClient = apiClient, limit?: number) {
  try {
    return validateEarningsHistory(await client.getCloudEarningsHistory(symbol, limit), symbol);
  } catch (error) {
    throw unavailableOnServer(error, "Earnings history is not available yet.", [404, 503]);
  }
}

export function cachedEarningsCalendar(query: EarningsCalendarQuery) {
  return cachedCloudResource(calendarCache, earningsCalendarKey(query), validateEarningsCalendar);
}

export function loadEarningsBoard(query: EarningsCalendarQuery, force = false) {
  return loadCloudResource(calendarCache, earningsCalendarKey(query), () => fetchEarningsCalendar(query),
    { force, validate: validateEarningsCalendar });
}

/**
 * A history's cache key. A listing abroad's history is the account's (Gloom
 * Cloud reads it for Pro), so `accessKey` (the session and plan) keeps one
 * account's apart from another's, and from the next sign-in's.
 */
const historyKey = (symbol: string, limit?: number, accessKey?: string) => {
  const key = limit == null ? symbol : `${symbol}:${limit}`;
  return accessKey ? `${key}|${accessKey}` : key;
};

export function cachedEarningsHistory(symbol: string, accessKey?: string) {
  return cachedCloudResource(historyCache, historyKey(symbol, undefined, accessKey), (payload) => validateEarningsHistory(payload, symbol));
}

/**
 * Whether ERN reads a listing's own past reports: every US listing, and of
 * the listings abroad Hong Kong's, which Gloom Cloud reads from their
 * results announcements. Any other listing abroad shows its next report.
 */
export function hasEarningsHistory(venueAbroad: string | null): boolean {
  return venueAbroad == null || venueAbroad === "HKEX";
}

/** A server that does not read a listing abroad's history yet refuses it (400): the next report stands alone, as before. */
export function noHistoryAbroad(error: unknown): null {
  if (error instanceof ApiRequestError && error.status === 400) return null;
  throw error;
}

/** `limit` asks for more reports than the pane's default and is cached apart from it; `accessKey` as `cachedEarningsHistory`. */
export function loadEarningsHistory(symbol: string, force = false, limit?: number, accessKey?: string) {
  return loadCloudResource(historyCache, historyKey(symbol, limit, accessKey), () => fetchEarningsHistory(symbol, apiClient, limit),
    { force, validate: (payload) => validateEarningsHistory(payload, symbol) });
}

/** A listing abroad's history Gloom Cloud did not read for this account: its past reports are Pro's. */
export const historyNeedsPro = (payload: EarningsHistoryPayload | null | undefined) => payload?.access?.pro === false;
