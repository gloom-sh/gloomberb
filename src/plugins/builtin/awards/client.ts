import { apiClient } from "../../../api-client";
import type { AwardDetailPayload, AwardFilter, AwardInput, AwardRow, AwardsPayload } from "../../../api-client/awards";
import { createPluginCache } from "../../../data/plugin-cache";
import { loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";

export const AWARDS_UNAVAILABLE = "Government awards are not available yet.";
export const awardsCache = createPluginCache<AwardsPayload>({ kind: "government-awards", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 5 * 60_000, expireMs: 7 * 86_400_000 } });
export const awardDetailCache = createPluginCache<AwardDetailPayload>({ kind: "government-award-detail", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 5 * 60_000, expireMs: 7 * 86_400_000 } });

const text = (value: unknown): value is string => typeof value === "string";
const optionalText = (value: unknown) => value == null || text(value);
const amount = (value: unknown) => value == null || text(value) && /^-?\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value));
const date = (value: unknown) => text(value) && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const instant = (value: unknown) => text(value) && Number.isFinite(Date.parse(value));
const url = (value: unknown) => { try { return text(value) && ["https:", "http:"].includes(new URL(value).protocol); } catch { return false; } };
const confidence = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const currency = (value: unknown) => text(value) && /^[A-Z]{3}$/.test(value);
const type = (value: unknown) => ["prime", "subaward", "modification", "notice"].includes(String(value));
function validInput(row: AwardInput): boolean {
  return !!row && text(row.source) && text(row.sourceAwardId) && text(row.title) && text(row.jurisdiction) && type(row.awardType)
    && date(row.awardDate) && (row.periodStart == null || date(row.periodStart)) && (row.periodEnd == null || date(row.periodEnd))
    && currency(row.currency) && amount(row.awardAmount) && amount(row.obligatedAmount) && amount(row.ceilingAmount)
    && !!row.recipient && text(row.recipient.name) && !!row.agency && text(row.agency.name) && url(row.sourceUrl)
    && (row.fieldSourceUrls == null || typeof row.fieldSourceUrls === "object" && Object.values(row.fieldSourceUrls).every(url))
    && (row.fieldAsOf == null || typeof row.fieldAsOf === "object" && Object.values(row.fieldAsOf).every(instant))
    && optionalText(row.description) && optionalText(row.evidenceQuote) && (row.confidence == null || confidence(row.confidence));
}
function validRow(row: AwardRow): boolean {
  const match = row?.entity, revenue = row?.revenueComparison;
  return validInput(row) && text(row.id) && text(row.revisionId) && instant(row.observedAt)
    && (match === null || !!match && text(match.ticker) && text(match.legalName) && optionalText(match.exchange)
      && ["identifier", "legal-name", "verified-alias"].includes(match.method) && url(match.evidenceUrl) && confidence(match.confidence))
    && (revenue === null || !!revenue && amount(revenue.awardAmount) && amount(revenue.annualRevenue) && Number(revenue.annualRevenue) > 0
      && currency(revenue.currency) && revenue.currency === row.currency && date(revenue.periodStart) && date(revenue.periodEnd)
      && instant(revenue.filedAt) && url(revenue.sourceUrl) && Number.isFinite(revenue.percent) && revenue.percent >= 0
      && ["award-value", "obligated"].includes(revenue.basis));
}
export function validateAwards(data: AwardsPayload): AwardsPayload {
  if (!data || !instant(data.generatedAt) || !(data.asOf === null || instant(data.asOf))
    || !["available", "partial", "unavailable"].includes(data.status) || !["full", "preview"].includes(data.access)
    || typeof data.locked !== "boolean" || !(data.nextCursor === null || text(data.nextCursor))
    || !Array.isArray(data.rows) || !data.rows.every(validRow) || new Set(data.rows.map((row) => row.id)).size !== data.rows.length
    || !Array.isArray(data.alerts) || !data.alerts.every(validRow)
    || ![data.agencies, data.sectors].every((rows) => Array.isArray(rows) && rows.every((row) => text(row.key) && text(row.label) && text(row.source)
      && currency(row.currency) && type(row.awardType) && count(row.count) && [row.awardAmount, row.obligatedAmount, row.ceilingAmount].every(amount)
      && (row.sharePercent === null || Number.isFinite(row.sharePercent))))
    || !(data.leaders === undefined || Array.isArray(data.leaders) && data.leaders.every((row) => text(row.label) && text(row.key) && text(row.source)
      && text(row.sector) && optionalText(row.ticker) && optionalText(row.exchange) && currency(row.currency) && type(row.awardType) && count(row.count)
      && [row.awardAmount, row.obligatedAmount, row.ceilingAmount].every(amount) && (row.sharePercent === null || Number.isFinite(row.sharePercent))))
    || !Array.isArray(data.history) || !data.history.every((row) => text(row.source) && text(row.month) && date(`${row.month.slice(0, 7)}-01`)
      && currency(row.currency) && type(row.awardType) && count(row.count)
      && [row.awardAmount, row.obligatedAmount, row.ceilingAmount, row.cumulativeObligatedAmount].every(amount))
    || !Array.isArray(data.gaps) || !data.gaps.every(text) || !Array.isArray(data.sources) || !Array.isArray(data.coverage)) {
    throw new Error("The server returned unreadable government awards");
  }
  return data;
}
export function validateAwardDetail(data: AwardDetailPayload): AwardDetailPayload {
  if (!data || !(data.row === null || validRow(data.row)) || !["full", "preview"].includes(data.access) || typeof data.locked !== "boolean"
    || ![data.subawards, data.modifications].every((rows) => Array.isArray(rows) && rows.every(validRow))
    || !Array.isArray(data.revisions) || !data.revisions.every((row) => text(row.id) && instant(row.observedAt) && optionalText(row.supersedes) && validInput(row.award))
    || !Array.isArray(data.edges) || !data.edges.every((edge) => ["government-customer", "subcontractor"].includes(edge.kind)
      && text(edge.from?.name) && text(edge.to?.name) && amount(edge.amount) && currency(edge.currency) && url(edge.sourceUrl))) {
    throw new Error("The server returned unreadable award evidence");
  }
  return data;
}
export async function fetchAwards(query: AwardFilter = {}, client: Pick<typeof apiClient, "getCloudAwards"> = apiClient, signal?: AbortSignal) {
  try { return validateAwards(await client.getCloudAwards(query, signal)); }
  catch (error) { throw unavailableOnServer(error, AWARDS_UNAVAILABLE, [404, 503]); }
}
export async function fetchAward(id: string, client: Pick<typeof apiClient, "getCloudAward"> = apiClient, signal?: AbortSignal, revisionsCursor?: string) {
  return validateAwardDetail(await client.getCloudAward(id, signal, revisionsCursor));
}
// Account and plan are part of every key so a different session cannot read a paid cache.
export const loadAwards = (query: AwardFilter, access: string, force = false) => loadCloudResource(awardsCache,
  JSON.stringify([access, query]), () => fetchAwards(query), { force, validate: validateAwards });
export const loadAward = (id: string, access: string, force = false) => loadCloudResource(awardDetailCache,
  JSON.stringify([access, id]), () => fetchAward(id), { force, validate: validateAwardDetail });
