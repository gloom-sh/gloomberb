import { apiClient } from "../../../api-client";
import type {
  EarningsCalendarPayload,
  EarningsCalendarQuery,
  EarningsHistoryPayload,
  EarningsReport,
} from "../../../api-client/earnings";
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

function validateEarningsHistory(payload: EarningsHistoryPayload, symbol: string): EarningsHistoryPayload {
  if (!payload || payload.symbol !== symbol || !Array.isArray(payload.reports)
    || payload.reports.some((report) => !validReport(report) || !numberOrNull(report.revenueActual))) {
    throw new Error("The server returned an invalid earnings history");
  }
  return payload;
}

type CalendarClient = Pick<typeof apiClient, "getCloudEarningsCalendar">;
type HistoryClient = Pick<typeof apiClient, "getCloudEarningsHistory">;

const calendarKey = (query: EarningsCalendarQuery) =>
  `${query.from}:${query.to}:${query.perDay ?? ""}:${[...(query.symbols ?? [])].sort().join(",")}`;

export async function fetchEarningsCalendar(query: EarningsCalendarQuery, client: CalendarClient = apiClient) {
  try {
    return validateEarningsCalendar(await client.getCloudEarningsCalendar(query));
  } catch (error) {
    throw unavailableOnServer(error, "The earnings calendar is not available yet.", [404, 503]);
  }
}

export async function fetchEarningsHistory(symbol: string, client: HistoryClient = apiClient) {
  try {
    return validateEarningsHistory(await client.getCloudEarningsHistory(symbol), symbol);
  } catch (error) {
    throw unavailableOnServer(error, "Earnings history is not available yet.", [404, 503]);
  }
}

export function cachedEarningsCalendar(query: EarningsCalendarQuery) {
  return cachedCloudResource(calendarCache, calendarKey(query), validateEarningsCalendar);
}

export function loadEarningsBoard(query: EarningsCalendarQuery, force = false) {
  return loadCloudResource(calendarCache, calendarKey(query), () => fetchEarningsCalendar(query),
    { force, validate: validateEarningsCalendar });
}

export function cachedEarningsHistory(symbol: string) {
  return cachedCloudResource(historyCache, symbol, (payload) => validateEarningsHistory(payload, symbol));
}

export function loadEarningsHistory(symbol: string, force = false) {
  return loadCloudResource(historyCache, symbol, () => fetchEarningsHistory(symbol),
    { force, validate: (payload) => validateEarningsHistory(payload, symbol) });
}
