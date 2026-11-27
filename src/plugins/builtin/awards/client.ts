import { apiClient } from "../../../api-client";
import type { AwardDetailPayload, AwardFilter, AwardInput, AwardRow, AwardsPayload } from "../../../api-client/awards";
import { hasUniqueIds, isCalendarDay, isCurrencyCode, isFraction, isHttpUrl, isIsoInstant, isNullableIsoInstant, isNullableString, isStringArray } from "../../../utils/guards";
import { createCloudEndpoint } from "../shared/cloud-resource";

export const AWARDS_UNAVAILABLE = "Government awards are not available yet.";
const policy = { staleMs: 5 * 60_000, expireMs: 7 * 86_400_000 };

const text = (value: unknown): value is string => typeof value === "string";
const optionalText = (value: unknown) => value == null || text(value);
const amount = (value: unknown) => value == null || text(value) && /^-?\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value));
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const type = (value: unknown) => ["prime", "subaward", "modification", "notice"].includes(String(value));
function validInput(row: AwardInput): boolean {
  return !!row && text(row.source) && text(row.sourceAwardId) && text(row.title) && text(row.jurisdiction) && type(row.awardType)
    && isCalendarDay(row.awardDate) && (row.periodStart == null || isCalendarDay(row.periodStart)) && (row.periodEnd == null || isCalendarDay(row.periodEnd))
    && isCurrencyCode(row.currency) && amount(row.awardAmount) && amount(row.obligatedAmount) && amount(row.ceilingAmount)
    && !!row.recipient && text(row.recipient.name) && !!row.agency && text(row.agency.name) && isHttpUrl(row.sourceUrl)
    && (row.fieldSourceUrls == null || typeof row.fieldSourceUrls === "object" && Object.values(row.fieldSourceUrls).every(isHttpUrl))
    && (row.fieldAsOf == null || typeof row.fieldAsOf === "object" && Object.values(row.fieldAsOf).every(isIsoInstant))
    && optionalText(row.description) && optionalText(row.evidenceQuote) && (row.confidence == null || isFraction(row.confidence));
}
function validRow(row: AwardRow): boolean {
  const match = row?.entity, revenue = row?.revenueComparison;
  return validInput(row) && text(row.id) && text(row.revisionId) && isIsoInstant(row.observedAt)
    && (match === null || !!match && text(match.ticker) && text(match.legalName) && optionalText(match.exchange)
      && ["identifier", "legal-name", "verified-alias"].includes(match.method) && isHttpUrl(match.evidenceUrl) && isFraction(match.confidence))
    && (revenue === null || !!revenue && amount(revenue.awardAmount) && amount(revenue.annualRevenue) && Number(revenue.annualRevenue) > 0
      && isCurrencyCode(revenue.currency) && revenue.currency === row.currency && isCalendarDay(revenue.periodStart) && isCalendarDay(revenue.periodEnd)
      && isIsoInstant(revenue.filedAt) && isHttpUrl(revenue.sourceUrl) && Number.isFinite(revenue.percent) && revenue.percent >= 0
      && ["award-value", "obligated"].includes(revenue.basis));
}
export function validateAwards(data: AwardsPayload): AwardsPayload {
  if (!data || !isIsoInstant(data.generatedAt) || !isNullableIsoInstant(data.asOf)
    || !["available", "partial", "unavailable"].includes(data.status) || !["full", "preview"].includes(data.access)
    || typeof data.locked !== "boolean" || !isNullableString(data.nextCursor)
    || !Array.isArray(data.rows) || !data.rows.every(validRow) || !hasUniqueIds(data.rows)
    || !Array.isArray(data.alerts) || !data.alerts.every(validRow)
    || ![data.agencies, data.sectors].every((rows) => Array.isArray(rows) && rows.every((row) => text(row.key) && text(row.label) && text(row.source)
      && isCurrencyCode(row.currency) && type(row.awardType) && count(row.count) && [row.awardAmount, row.obligatedAmount, row.ceilingAmount].every(amount)
      && (row.sharePercent === null || Number.isFinite(row.sharePercent))))
    || !(data.leaders === undefined || Array.isArray(data.leaders) && data.leaders.every((row) => text(row.label) && text(row.key) && text(row.source)
      && text(row.sector) && optionalText(row.ticker) && optionalText(row.exchange) && isCurrencyCode(row.currency) && type(row.awardType) && count(row.count)
      && [row.awardAmount, row.obligatedAmount, row.ceilingAmount].every(amount) && (row.sharePercent === null || Number.isFinite(row.sharePercent))))
    || !Array.isArray(data.history) || !data.history.every((row) => text(row.source) && text(row.month) && isCalendarDay(`${row.month.slice(0, 7)}-01`)
      && isCurrencyCode(row.currency) && type(row.awardType) && count(row.count)
      && [row.awardAmount, row.obligatedAmount, row.ceilingAmount, row.cumulativeObligatedAmount].every(amount))
    || !isStringArray(data.gaps) || !Array.isArray(data.sources) || !Array.isArray(data.coverage)) {
    throw new Error("The server returned unreadable government awards");
  }
  return data;
}
export function validateAwardDetail(data: AwardDetailPayload): AwardDetailPayload {
  if (!data || !(data.row === null || validRow(data.row)) || !["full", "preview"].includes(data.access) || typeof data.locked !== "boolean"
    || ![data.subawards, data.modifications].every((rows) => Array.isArray(rows) && rows.every(validRow))
    || !Array.isArray(data.revisions) || !data.revisions.every((row) => text(row.id) && isIsoInstant(row.observedAt) && optionalText(row.supersedes) && validInput(row.award))
    || !Array.isArray(data.edges) || !data.edges.every((edge) => ["government-customer", "subcontractor"].includes(edge.kind)
      && text(edge.from?.name) && text(edge.to?.name) && amount(edge.amount) && isCurrencyCode(edge.currency) && isHttpUrl(edge.sourceUrl))) {
    throw new Error("The server returned unreadable award evidence");
  }
  return data;
}
// Account and plan are part of every key so a different session cannot read a paid cache.
const awardsEndpoint = createCloudEndpoint<{ query: AwardFilter; access?: string }, AwardsPayload, Pick<typeof apiClient, "getCloudAwards">>({
  kind: "government-awards", schemaVersion: 1, policy, key: ({ access, query }) => JSON.stringify([access, query]),
  defaultClient: apiClient, fetch: ({ query }, client, signal) => client.getCloudAwards(query, signal),
  validate: validateAwards, unavailableMessage: AWARDS_UNAVAILABLE, unavailableStatuses: [404, 503],
});
const awardDetailEndpoint = createCloudEndpoint<{ id: string; access?: string; revisionsCursor?: string }, AwardDetailPayload, Pick<typeof apiClient, "getCloudAward">>({
  kind: "government-award-detail", schemaVersion: 1, policy, key: ({ access, id }) => JSON.stringify([access, id]),
  defaultClient: apiClient, fetch: ({ id, revisionsCursor }, client, signal) => client.getCloudAward(id, signal, revisionsCursor),
  validate: validateAwardDetail,
});
export const awardsCache = awardsEndpoint.cache;
export const awardDetailCache = awardDetailEndpoint.cache;
export const fetchAwards = (query: AwardFilter = {}, client: Pick<typeof apiClient, "getCloudAwards"> = apiClient, signal?: AbortSignal) =>
  awardsEndpoint.fetch({ query }, { client, signal });
export const fetchAward = (id: string, client: Pick<typeof apiClient, "getCloudAward"> = apiClient, signal?: AbortSignal, revisionsCursor?: string) =>
  awardDetailEndpoint.fetch({ id, revisionsCursor }, { client, signal });
export const loadAwards = (query: AwardFilter, access: string, force = false) => awardsEndpoint.load({ query, access }, { force });
export const loadAward = (id: string, access: string, force = false) => awardDetailEndpoint.load({ id, access }, { force });
