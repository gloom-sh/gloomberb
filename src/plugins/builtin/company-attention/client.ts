import { apiClient } from "../../../api-client";
import type { AppAttentionFilter, AppAttentionPayload, AppRankPayload } from "../../../api-client/app-attention";
import type { HiringBoard, HiringPayload, HiringSummary } from "../../../api-client/hiring";
import { createPluginCache } from "../../../data/plugin-cache";
import { cachedCloudResource, loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";
import type { AppFocus, AttentionKind } from "./model";

export type AttentionPayload = HiringBoard | HiringPayload | AppAttentionPayload;
export const attentionCache = createPluginCache<AttentionPayload>({ kind: "company-attention", source: "gloom-cloud", schemaVersion: 1, policy: { staleMs: 30 * 60_000, expireMs: 7 * 86_400_000 } });
export const appRankCache = createPluginCache<AppRankPayload>({ kind: "app-rank-history", source: "gloom-cloud", schemaVersion: 1, policy: { staleMs: 30 * 60_000, expireMs: 7 * 86_400_000 } });
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const positive = (value: unknown) => finite(value) && (value as number) >= 0;
const fraction = (value: unknown) => positive(value) && (value as number) <= 1;
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const url = (value: unknown) => { try { return typeof value === "string" && ["https:", "http:"].includes(new URL(value).protocol); } catch { return false; } };
function numericTree(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(numericTree);
  if (value && typeof value === "object") return Object.values(value).every(numericTree);
  return true;
}
function hiringCompany(row: HiringSummary): boolean {
  return !!row && typeof row.symbol === "string" && typeof row.name === "string" && fraction(row.mappingConfidence)
    && ["ok", "collecting", "stale", "uncovered"].includes(row.status) && positive(row.historyWeeks)
    && (row.latest === null || (!!row.latest && date(row.latest.week) && date(row.latest.observedAt) && positive(row.latest.openCount)
      && (row.latest.remoteShare === null || fraction(row.latest.remoteShare)) && fraction(row.latest.confidence)));
}
export function validateAttention(kind: AttentionKind, payload: AttentionPayload): AttentionPayload {
  let valid = !!payload && date(payload.generatedAt) && numericTree(payload);
  if (valid && kind === "hiring") {
    const data = payload as HiringBoard | HiringPayload;
    valid = typeof data.preview === "boolean" && ("companies" in data
      ? Array.isArray(data.companies) && data.companies.every(hiringCompany) && positive(data.locked)
      : hiringCompany(data) && Array.isArray(data.series) && data.series.every((row) => date(row.week) && positive(row.openCount))
        && [data.functions, data.seniority, data.countries, data.locations].every((rows) => Array.isArray(rows) && rows.every((row) => typeof row.label === "string" && positive(row.count) && fraction(row.share)))
        && Array.isArray(data.peers) && data.peers.every(hiringCompany) && Array.isArray(data.signals)
        && Array.isArray(data.evidence) && data.evidence.every((row) => typeof row.title === "string" && date(row.observedAt) && fraction(row.confidence) && (row.url === null || url(row.url)))
        && !!data.coverage && typeof data.coverage.comparability === "string" && !!data.locked);
  } else if (valid) {
    const data = payload as AppAttentionPayload;
    valid = ["pro", "preview"].includes(data.access) && ["ready", "collecting", "unavailable"].includes(data.status)
      && !!data.summary && positive(data.summary.appCount) && !!data.coverage && Array.isArray(data.coverage.limitations)
      && Array.isArray(data.apps) && data.apps.every((row) => typeof row.appId === "string" && typeof row.name === "string" && typeof row.country === "string" && date(row.observedAt) && url(row.appUrl) && fraction(row.confidence) && (row.rank === null || positive(row.rank)) && (row.rating === null || (positive(row.rating) && row.rating <= 5)))
      && Array.isArray(data.history) && data.history.every((row) => date(row.date))
      && [data.companies, data.peers, data.countries, data.spreads, data.evidence].every(Array.isArray)
      && data.evidence.every((row) => url(row.sourceUrl) && date(row.observedAt) && fraction(row.confidence)) && !!data.locked;
  }
  if (!valid) throw new Error(`The server returned unreadable ${kind === "hiring" ? "hiring observations" : "app attention"}.`);
  return payload;
}
export async function fetchAttention(kind: AttentionKind, symbol?: string, filters: AppAttentionFilter = {}, client: Pick<typeof apiClient, "getCloudHiring" | "getCloudAppAttention"> = apiClient, signal?: AbortSignal) {
  try {
    const data = validateAttention(kind, kind === "hiring" ? await client.getCloudHiring(symbol, filters, signal) : await client.getCloudAppAttention({ ...filters, symbol }, signal));
    if (symbol && (!("symbol" in data) || data.symbol?.toUpperCase() !== symbol.toUpperCase() && data.requestedSymbol?.toUpperCase() !== symbol.toUpperCase())) throw new Error("The server returned observations for a different company.");
    return data;
  } catch (error) { throw unavailableOnServer(error, `${kind === "hiring" ? "Hiring observations" : "App attention"} are not available yet.`, [404, 503]); }
}
// Both identity and entitlement partition the persistent cache.
const cacheKey = (kind: AttentionKind, symbol: string | undefined, access: string, filters: AppAttentionFilter) => `${kind}:${symbol ?? "board"}:${access}:${JSON.stringify(filters)}`;
export const cachedAttention = (kind: AttentionKind, symbol: string | undefined, access: string, filters: AppAttentionFilter) => cachedCloudResource(attentionCache, cacheKey(kind, symbol, access, filters), (data) => validateAttention(kind, data));
export const loadAttention = (kind: AttentionKind, symbol: string | undefined, access: string, filters: AppAttentionFilter, force = false) => loadCloudResource(attentionCache, cacheKey(kind, symbol, access, filters), () => fetchAttention(kind, symbol, filters), { force, validate: (data) => validateAttention(kind, data) });

export async function fetchAppRank(focus: AppFocus, days: number, offset = 0, signal?: AbortSignal, client: Pick<typeof apiClient, "getCloudAppRankHistory"> = apiClient, limit = 500) {
  const data = await client.getCloudAppRankHistory(focus.store, focus.appId, { country: focus.country, chart: focus.chart, days, offset, limit }, signal);
  if (!data || data.appId !== focus.appId || data.store !== focus.store || !["pro", "preview"].includes(data.access)
    || !Array.isArray(data.rankHistory) || !data.rankHistory.every((row) => row.appId === focus.appId && row.store === focus.store && row.country === focus.country && row.chart === focus.chart && date(row.date) && date(row.observedAt) && url(row.sourceUrl) && (row.rank === null || positive(row.rank))) || !data.page || !numericTree(data)) throw new Error("The server returned unreadable app rank history.");
  return data;
}
export const loadAppRank = (focus: AppFocus, access: string, days: number, force = false) => loadCloudResource(appRankCache, `${access}:${focus.store}:${focus.appId}:${focus.country}:${focus.chart}:${days}`, () => fetchAppRank(focus, days), { force });
