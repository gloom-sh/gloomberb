import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { CentralBankRatesPayload } from "../../../api-client/central-bank-rates";
import { createPluginCache } from "../../../data/plugin-cache";

export const centralBankRatesCache = createPluginCache<CentralBankRatesPayload>({
  kind: "central-bank-rates", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 60 * 60_000, expireMs: 14 * 24 * 60 * 60_000 },
});
const finiteOrNull = (value: unknown) => value === null || typeof value === "number" && Number.isFinite(value);
const dateOrNull = (value: unknown) => value === null || typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const urlOrNull = (value: unknown) => value === null || typeof value === "string" && /^https:\/\//.test(value);

/** An incompatible deployment cannot turn missing dates or units into current policy rates. */
export function validateCentralBankRates(payload: CentralBankRatesPayload): CentralBankRatesPayload {
  const invalid = () => { throw new Error("Gloom Cloud returned invalid central-bank observations"); };
  if (!payload || !Number.isFinite(Date.parse(payload.generatedAt)) || !["available", "partial", "unavailable"].includes(payload.status)
    || !Array.isArray(payload.rows) || !strings(payload.gaps)) return invalid();
  const ids = new Set<string>();
  for (const row of payload.rows) {
    if (!row || typeof row.id !== "string" || !row.id || ids.has(row.id) || typeof row.label !== "string"
      || typeof row.instrument !== "string" || !strings(row.countryCodes) || !strings(row.sourceSeriesIds) || !strings(row.notes)
      || !["fred", "bis", null].includes(row.source) || !urlOrNull(row.sourceUrl) || row.unit !== "percent"
      || !["daily", "weekly", null].includes(row.publicationFrequency) || !["available", "stale", "unavailable"].includes(row.status)
      || !["hike", "cut", "unchanged", "unavailable"].includes(row.direction)
      || !finiteOrNull(row.value) || !finiteOrNull(row.changeBps) || !finiteOrNull(row.previousValue)
      || !dateOrNull(row.asOf) || !dateOrNull(row.lastChangeDate) || !dateOrNull(row.previousAsOf)
      || row.value != null && row.asOf == null || row.status === "unavailable" && row.value != null
      || row.lagDays !== null && (!Number.isInteger(row.lagDays) || row.lagDays < 0)
      || !Array.isArray(row.history) || row.history.some((point) => !point || point.date == null || !dateOrNull(point.date) || !finiteOrNull(point.value))) return invalid();
    ids.add(row.id);
    if (row.range !== null && (!row.range || !Number.isFinite(row.range.lower) || !Number.isFinite(row.range.upper)
      || row.range.lower > row.range.upper || row.value == null || Math.abs((row.range.lower + row.range.upper) / 2 - row.value) > 1e-8)) return invalid();
    if (row.changeBps !== null && (row.lastChangeDate == null || row.previousAsOf == null || row.previousValue == null || row.value == null
      || row.previousAsOf >= row.lastChangeDate || row.lastChangeDate > row.asOf!
      || Math.abs((row.value - row.previousValue) * 100 - row.changeBps) > 1e-6
      || row.direction !== (row.changeBps > 0 ? "hike" : row.changeBps < 0 ? "cut" : "unchanged"))) return invalid();
    const stats = row.percentile;
    if (!stats || !finiteOrNull(stats.value) || stats.value != null && (stats.value < 0 || stats.value > 100)
      || !Number.isInteger(stats.sampleCount) || stats.sampleCount < 0 || !finiteOrNull(stats.rank)
      || !finiteOrNull(stats.min) || !finiteOrNull(stats.max) || !finiteOrNull(stats.mean)
      || !dateOrNull(stats.windowStart) || !dateOrNull(stats.windowEnd)) return invalid();
    if (row.nextMeeting !== null && (!row.nextMeeting || row.nextMeeting.date == null || !dateOrNull(row.nextMeeting.date)
      || !urlOrNull(row.nextMeeting.sourceUrl) || row.nextMeeting.sourceUrl == null
      || !Number.isFinite(Date.parse(row.nextMeeting.verifiedAt)))) return invalid();
  }
  return payload;
}

export async function fetchCentralBankRates(client: Pick<typeof apiClient, "getCloudCentralBankRates"> = apiClient) {
  try { return validateCentralBankRates(await client.getCloudCentralBankRates()); }
  catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) throw new Error("Central bank rates are not available on this Gloom Cloud server yet");
    throw error;
  }
}
export interface CentralBankRatesResource { payload: CentralBankRatesPayload; stale: boolean; refreshError: string | null }
export function getCachedCentralBankRates(): CentralBankRatesResource | null {
  const cached = centralBankRatesCache.get("g20", { allowExpired: true });
  // The pane revalidates this copy on mount; only a failed refresh makes it stale.
  return cached ? { payload: cached.data, stale: false, refreshError: null } : null;
}
export async function loadCentralBankRates(force = false): Promise<CentralBankRatesResource> {
  const result = await centralBankRatesCache.load("g20", () => fetchCentralBankRates(), { force });
  if (result.error instanceof ApiRequestError && [401, 403].includes(result.error.status ?? 0)) throw result.error;
  return { payload: result.data, stale: result.stale, refreshError: result.refreshError ?? null };
}
