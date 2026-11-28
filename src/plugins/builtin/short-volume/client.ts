import { apiClient } from "../../../api-client";
import type { ShortVolumeObservation, ShortVolumePayload, ShortVolumeScope } from "../../../api-client/short-volume";
import { isCalendarDay, isIsoInstant, isNonNegativeInt, isNullableCalendarDay, isNullableFinite, isStringArray } from "../../../utils/guards";
import { createCloudEndpoint } from "../shared/cloud-resource";

const quantity = (value: unknown): value is string => typeof value === "string" && /^\d{1,18}(?:\.\d{1,6})?$/.test(value);
function micros(value: string): bigint {
  const [integer, fraction = ""] = value.split(".");
  return BigInt(integer!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}
function validObservation(point: ShortVolumeObservation): boolean {
  if (!point || !isCalendarDay(point.date) || !isNullableFinite(point.ratioPercent)
    || point.ratioPercent != null && (point.ratioPercent < 0 || point.ratioPercent > 100)
    || !isStringArray(point.markets) || typeof point.sourceUrl !== "string" || typeof point.refreshFailed !== "boolean"
    || ![null, "missing_file", "not_reported", "zero_volume"].includes(point.unavailableReason)) return false;
  const values = [point.shortVolume, point.shortExemptVolume, point.totalVolume];
  if (values.every((value) => value === null)) return point.ratioPercent === null && point.fetchedAt === null
    && ["missing_file", "not_reported"].includes(point.unavailableReason ?? "");
  if (!values.every(quantity) || !isIsoInstant(point.fetchedAt)) return false;
  const short = micros(point.shortVolume!), exempt = micros(point.shortExemptVolume!), total = micros(point.totalVolume!);
  if (exempt > short || short > total) return false;
  if (total === 0n) return point.ratioPercent === null && point.unavailableReason === "zero_volume";
  return point.unavailableReason === null && point.ratioPercent !== null
    && Math.abs(point.ratioPercent - Number(short * 10_000_000_000n / total) / 100_000_000) < 1e-7;
}

/** Keep exact source quantities and missing observations across the Cloud boundary. */
function validateShortVolume(payload: ShortVolumePayload, symbol: string, scope: ShortVolumeScope): ShortVolumePayload {
  const invalid = () => { throw new Error("The server returned invalid daily short-volume history"); };
  if (!payload || payload.version !== 1 || payload.symbol !== symbol || payload.scope !== scope
    || typeof payload.finraSymbol !== "string" || !["available", "partial", "unavailable"].includes(payload.status)
    || !isIsoInstant(payload.fetchedAt) || !isNullableCalendarDay(payload.asOf) || !isNullableCalendarDay(payload.sourceAsOf)
    || !payload.source || typeof payload.source.name !== "string" || typeof payload.source.url !== "string"
    || typeof payload.source.cadence !== "string" || !Array.isArray(payload.history)
    || payload.history.some((point, i) => !validObservation(point) || i > 0 && point.date <= payload.history[i - 1]!.date)
    || !isStringArray(payload.warnings)) return invalid();
  const coverage = payload.coverage;
  if (!coverage || !isCalendarDay(coverage.windowStart) || !isCalendarDay(coverage.windowEnd) || coverage.windowStart > coverage.windowEnd
    || typeof coverage.completeWindow !== "boolean"
    || ![coverage.expectedFiles, coverage.ingestedFiles, coverage.missingFiles, coverage.expectedMonths, coverage.discoveredMonths].every(isNonNegativeInt)
    || coverage.expectedFiles !== payload.history.length || coverage.ingestedFiles + coverage.missingFiles !== coverage.expectedFiles
    || coverage.discoveredMonths > coverage.expectedMonths) return invalid();
  const latest = payload.latest;
  if (!latest) {
    if (payload.asOf !== null || payload.status !== "unavailable" || payload.history.some((point) => point.shortVolume !== null)) return invalid();
    return payload;
  }
  const stats = latest.percentile;
  const row = payload.history.findLast((point) => point.shortVolume !== null);
  if (!validObservation(latest) || !row || row.date !== latest.date || payload.asOf !== latest.date
    || row.ratioPercent !== latest.ratioPercent || row.shortVolume !== latest.shortVolume || row.totalVolume !== latest.totalVolume
    || payload.status === "unavailable" || !isNullableFinite(latest.changePp) || !isNullableCalendarDay(latest.previousDate)
    || latest.changePp !== null && (!latest.previousDate || latest.ratioPercent === null)
    || !stats || !isNullableFinite(stats.value) || stats.value != null && (stats.value < 0 || stats.value > 100)
    || !isNonNegativeInt(stats.sampleCount) || stats.sampleCount > payload.history.length
    || stats.value != null && stats.sampleCount < 20 || !isNullableFinite(stats.rank)
    || ![stats.min, stats.max, stats.mean].every(isNullableFinite)
    || !isCalendarDay(stats.windowStart) || !isCalendarDay(stats.windowEnd) || !isNullableCalendarDay(stats.historyStart) || !isNullableCalendarDay(stats.historyEnd)
    || typeof stats.completeWindow !== "boolean") return invalid();
  return payload;
}

const shortVolumeEndpoint = createCloudEndpoint<{ symbol: string; scope: ShortVolumeScope }, ShortVolumePayload, Pick<typeof apiClient, "getCloudShortVolume">>({
  kind: "short-volume", schemaVersion: 1, policy: { staleMs: 5 * 60_000, expireMs: 7 * 24 * 60 * 60_000 },
  key: ({ symbol, scope }) => `${scope}:${symbol}`, defaultClient: apiClient,
  fetch: ({ symbol, scope }, client) => client.getCloudShortVolume(symbol, scope),
  validate: (payload, { symbol, scope }) => validateShortVolume(payload, symbol, scope),
  unavailableMessage: "Daily short volume is not available yet.",
});

export const shortVolumeCache = shortVolumeEndpoint.cache;
export const fetchShortVolume = (symbol: string, scope: ShortVolumeScope = "nms", client: Pick<typeof apiClient, "getCloudShortVolume"> = apiClient) =>
  shortVolumeEndpoint.fetch({ symbol, scope }, { client });
export const cachedShortVolume = (symbol: string, scope: ShortVolumeScope) => shortVolumeEndpoint.cached({ symbol, scope });
export const loadShortVolume = (symbol: string, scope: ShortVolumeScope, force = false) => shortVolumeEndpoint.load({ symbol, scope }, { force });
