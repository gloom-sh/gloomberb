import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { ShortVolumeObservation, ShortVolumePayload, ShortVolumeScope } from "../../../api-client/short-volume";
import { createPluginCache } from "../../../data/plugin-cache";

export const shortVolumeCache = createPluginCache<ShortVolumePayload>({
  kind: "short-volume", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 5 * 60_000, expireMs: 7 * 24 * 60 * 60_000 },
});
const finiteOrNull = (value: unknown) => value === null || typeof value === "number" && Number.isFinite(value);
const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const dateOrNull = (value: unknown) => value === null || date(value);
const instant = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const quantity = (value: unknown): value is string => typeof value === "string" && /^\d{1,18}(?:\.\d{1,6})?$/.test(value);
function micros(value: string): bigint {
  const [integer, fraction = ""] = value.split(".");
  return BigInt(integer!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}
function validObservation(point: ShortVolumeObservation): boolean {
  if (!point || !date(point.date) || !finiteOrNull(point.ratioPercent)
    || point.ratioPercent != null && (point.ratioPercent < 0 || point.ratioPercent > 100)
    || !Array.isArray(point.markets) || point.markets.some((value) => typeof value !== "string")
    || typeof point.sourceUrl !== "string" || typeof point.refreshFailed !== "boolean"
    || ![null, "missing_file", "not_reported", "zero_volume"].includes(point.unavailableReason)) return false;
  const values = [point.shortVolume, point.shortExemptVolume, point.totalVolume];
  if (values.every((value) => value === null)) return point.ratioPercent === null && point.fetchedAt === null
    && ["missing_file", "not_reported"].includes(point.unavailableReason ?? "");
  if (!values.every(quantity) || !instant(point.fetchedAt)) return false;
  const short = micros(point.shortVolume!), exempt = micros(point.shortExemptVolume!), total = micros(point.totalVolume!);
  if (exempt > short || short > total) return false;
  if (total === 0n) return point.ratioPercent === null && point.unavailableReason === "zero_volume";
  return point.unavailableReason === null && point.ratioPercent !== null
    && Math.abs(point.ratioPercent - Number(short * 10_000_000_000n / total) / 100_000_000) < 1e-7;
}

/** Keep exact source quantities and missing observations across the Cloud boundary. */
export function validateShortVolume(payload: ShortVolumePayload, symbol: string, scope: ShortVolumeScope): ShortVolumePayload {
  const invalid = () => { throw new Error("Gloom Cloud returned invalid daily short-volume history"); };
  if (!payload || payload.version !== 1 || payload.symbol !== symbol || payload.scope !== scope
    || typeof payload.finraSymbol !== "string" || !["available", "partial", "unavailable"].includes(payload.status)
    || !instant(payload.fetchedAt) || !dateOrNull(payload.asOf) || !dateOrNull(payload.sourceAsOf)
    || !payload.source || typeof payload.source.name !== "string" || typeof payload.source.url !== "string"
    || typeof payload.source.cadence !== "string" || !Array.isArray(payload.history)
    || payload.history.some((point, i) => !validObservation(point) || i > 0 && point.date <= payload.history[i - 1]!.date)
    || !Array.isArray(payload.warnings) || payload.warnings.some((warning) => typeof warning !== "string")) return invalid();
  const coverage = payload.coverage;
  if (!coverage || !date(coverage.windowStart) || !date(coverage.windowEnd) || coverage.windowStart > coverage.windowEnd
    || typeof coverage.completeWindow !== "boolean"
    || [coverage.expectedFiles, coverage.ingestedFiles, coverage.missingFiles, coverage.expectedMonths, coverage.discoveredMonths]
      .some((value) => !Number.isInteger(value) || value < 0)
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
    || payload.status === "unavailable" || !finiteOrNull(latest.changePp) || !dateOrNull(latest.previousDate)
    || latest.changePp !== null && (!latest.previousDate || latest.ratioPercent === null)
    || !stats || !finiteOrNull(stats.value) || stats.value != null && (stats.value < 0 || stats.value > 100)
    || !Number.isInteger(stats.sampleCount) || stats.sampleCount < 0 || stats.sampleCount > payload.history.length
    || stats.value != null && stats.sampleCount < 20 || !finiteOrNull(stats.rank)
    || ![stats.min, stats.max, stats.mean].every(finiteOrNull)
    || !date(stats.windowStart) || !date(stats.windowEnd) || !dateOrNull(stats.historyStart) || !dateOrNull(stats.historyEnd)
    || typeof stats.completeWindow !== "boolean") return invalid();
  return payload;
}

export async function fetchShortVolume(symbol: string, scope: ShortVolumeScope = "nms",
  client: Pick<typeof apiClient, "getCloudShortVolume"> = apiClient): Promise<ShortVolumePayload> {
  try { return validateShortVolume(await client.getCloudShortVolume(symbol, scope), symbol, scope); }
  catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) throw new Error("Daily short volume is not available on this Gloom Cloud server yet");
    throw error;
  }
}
export interface ShortVolumeResource { payload: ShortVolumePayload; stale: boolean; refreshError: string | null }
const cacheKey = (symbol: string, scope: ShortVolumeScope) => `${scope}:${symbol}`;
export function cachedShortVolume(symbol: string, scope: ShortVolumeScope): ShortVolumeResource | null {
  const cached = shortVolumeCache.get(cacheKey(symbol, scope), { allowExpired: true });
  if (!cached) return null;
  try { return { payload: validateShortVolume(cached.data, symbol, scope), stale: cached.stale, refreshError: null }; }
  catch { return null; }
}
export async function loadShortVolume(symbol: string, scope: ShortVolumeScope, force = false): Promise<ShortVolumeResource> {
  const result = await shortVolumeCache.load(cacheKey(symbol, scope), () => fetchShortVolume(symbol, scope), { force });
  if (result.error instanceof ApiRequestError && [401, 403].includes(result.error.status ?? 0)) throw result.error;
  return { payload: validateShortVolume(result.data, symbol, scope), stale: result.stale, refreshError: result.refreshError ?? null };
}
