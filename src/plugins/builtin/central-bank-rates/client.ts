import { apiClient } from "../../../api-client";
import type { CentralBankRatesPayload } from "../../../api-client/central-bank-rates";
import { isNonNegativeInt, isNullableCalendarDay, isNullableFinite, isStringArray } from "../../../utils/guards";
import { createCloudEndpoint } from "../shared/cloud-resource";

const urlOrNull = (value: unknown) => value === null || typeof value === "string" && /^https:\/\//.test(value);

/** An incompatible deployment cannot turn missing dates or units into current policy rates. */
export function validateCentralBankRates(payload: CentralBankRatesPayload): CentralBankRatesPayload {
  const invalid = () => { throw new Error("The server returned invalid central-bank observations"); };
  if (!payload || !Number.isFinite(Date.parse(payload.generatedAt)) || !["available", "partial", "unavailable"].includes(payload.status)
    || !Array.isArray(payload.rows) || !isStringArray(payload.gaps)) return invalid();
  const ids = new Set<string>();
  for (const row of payload.rows) {
    if (!row || typeof row.id !== "string" || !row.id || ids.has(row.id) || typeof row.label !== "string"
      || typeof row.instrument !== "string" || !isStringArray(row.countryCodes) || !isStringArray(row.sourceSeriesIds) || !isStringArray(row.notes)
      || !["fred", "bis", null].includes(row.source) || !urlOrNull(row.sourceUrl) || row.unit !== "percent"
      || !["daily", "weekly", null].includes(row.publicationFrequency) || !["available", "stale", "unavailable"].includes(row.status)
      || !["hike", "cut", "unchanged", "unavailable"].includes(row.direction)
      || !isNullableFinite(row.value) || !isNullableFinite(row.changeBps) || !isNullableFinite(row.previousValue)
      || !isNullableCalendarDay(row.asOf) || !isNullableCalendarDay(row.lastChangeDate) || !isNullableCalendarDay(row.previousAsOf)
      || row.value != null && row.asOf == null || row.status === "unavailable" && row.value != null
      || row.lagDays !== null && !isNonNegativeInt(row.lagDays)
      || !Array.isArray(row.history) || row.history.some((point) => !point || point.date == null || !isNullableCalendarDay(point.date) || !isNullableFinite(point.value))) return invalid();
    ids.add(row.id);
    if (row.range !== null && (!row.range || !Number.isFinite(row.range.lower) || !Number.isFinite(row.range.upper)
      || row.range.lower > row.range.upper || row.value == null || Math.abs((row.range.lower + row.range.upper) / 2 - row.value) > 1e-8)) return invalid();
    if (row.changeBps !== null && (row.lastChangeDate == null || row.previousAsOf == null || row.previousValue == null || row.value == null
      || row.previousAsOf >= row.lastChangeDate || row.lastChangeDate > row.asOf!
      || Math.abs((row.value - row.previousValue) * 100 - row.changeBps) > 1e-6
      || row.direction !== (row.changeBps > 0 ? "hike" : row.changeBps < 0 ? "cut" : "unchanged"))) return invalid();
    const stats = row.percentile;
    if (!stats || !isNullableFinite(stats.value) || stats.value != null && (stats.value < 0 || stats.value > 100)
      || !isNonNegativeInt(stats.sampleCount) || !isNullableFinite(stats.rank)
      || !isNullableFinite(stats.min) || !isNullableFinite(stats.max) || !isNullableFinite(stats.mean)
      || !isNullableCalendarDay(stats.windowStart) || !isNullableCalendarDay(stats.windowEnd)) return invalid();
    if (row.nextMeeting !== null && (!row.nextMeeting || row.nextMeeting.date == null || !isNullableCalendarDay(row.nextMeeting.date)
      || !urlOrNull(row.nextMeeting.sourceUrl) || row.nextMeeting.sourceUrl == null
      || !Number.isFinite(Date.parse(row.nextMeeting.verifiedAt)))) return invalid();
    // Fields a newer server adds are read only when they hold what this app expects.
    if (row.nextMeeting && row.nextMeeting.kind !== undefined && row.nextMeeting.kind !== "decision" && row.nextMeeting.kind !== "fixing") delete row.nextMeeting.kind;
    if (row.nextMeetingStatus !== undefined && !["scheduled", "not-published", "not-verified", "no-policy-rate"].includes(row.nextMeetingStatus)) delete row.nextMeetingStatus;
    if (row.seriesNotes !== undefined && !isStringArray(row.seriesNotes)) delete row.seriesNotes;
    // A decision date is a citation: one that is not a real day on or before the change it is for, from an https page, is left out.
    const validDecision = (value: typeof row.lastDecision, maxDate?: string | null) =>
      typeof value === "object" && value !== null && value.date != null && isNullableCalendarDay(value.date)
      && (maxDate === undefined || (maxDate !== null && value.date <= maxDate))
      && value.sourceUrl != null && urlOrNull(value.sourceUrl)
      && Number.isFinite(Date.parse(value.verifiedAt))
      && (value.kind === undefined || value.kind === "decision" || value.kind === "fixing");
    if (row.lastDecision != null && !validDecision(row.lastDecision, row.lastChangeDate)) delete row.lastDecision;
    if (row.latestDecision != null && !validDecision(row.latestDecision)) delete row.latestDecision;
  }
  return payload;
}

const centralBankRatesEndpoint = createCloudEndpoint<void, CentralBankRatesPayload, Pick<typeof apiClient, "getCloudCentralBankRates">>({
  kind: "central-bank-rates", schemaVersion: 1, policy: { staleMs: 60 * 60_000, expireMs: 14 * 24 * 60 * 60_000 },
  key: "g20", defaultClient: apiClient,
  fetch: (_args, client) => client.getCloudCentralBankRates(), validate: validateCentralBankRates,
  unavailableMessage: "Central bank rates are not available yet.",
});

export const centralBankRatesCache = centralBankRatesEndpoint.cache;
export const fetchCentralBankRates = (client: Pick<typeof apiClient, "getCloudCentralBankRates"> = apiClient) =>
  centralBankRatesEndpoint.fetch(undefined, { client });
export const getCachedCentralBankRates = () => centralBankRatesEndpoint.cached();
export const loadCentralBankRates = (force = false, client: Pick<typeof apiClient, "getCloudCentralBankRates"> = apiClient) =>
  centralBankRatesEndpoint.load(undefined, { force, client });
