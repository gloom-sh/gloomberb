import { getListingSymbolsToTry } from "../../../sources/listing-symbols";
import { canonicalExchange, parsePublicTickerKey } from "../../../utils/exchanges";
import { apiClient } from "../../../api-client";
import type { AttentionPayload, AttentionRow, AttentionWindow } from "../../../api-client/attention";
import { createPluginCache } from "../../../data/plugin-cache";
import { cachedCloudResource, loadCloudResource } from "../shared/cloud-resource";

export const attentionCache = createPluginCache<AttentionPayload>({ kind: "attention", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 5 * 60_000, expireMs: 24 * 60 * 60_000 } });
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const count = (value: unknown): value is number => finite(value) && Number.isInteger(value) && value >= 0;
const instant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const nullableNumber = (value: unknown) => value === null || finite(value);
const nullableText = (value: unknown) => value === null || typeof value === "string";
const safeUrl = (value: unknown): value is string => typeof value === "string" && /^https?:\/\//.test(value);
function listingMatches(input: string, row: Pick<AttentionRow, "symbol" | "ticker" | "exchange">) {
  const target = parsePublicTickerKey(input);
  return (!target.exchange || canonicalExchange(row.exchange) === target.exchange) && getListingSymbolsToTry(row.ticker, row.exchange, { exactExchange: true }).includes(target.symbol)
    || row.symbol.toUpperCase() === input.trim().toUpperCase()
    || row.ticker.toUpperCase() === target.symbol && (!target.exchange || canonicalExchange(row.exchange) === target.exchange);
}
const releasedCount = (value: unknown) => count(value) && value >= 20 && value % 5 === 0;
const validPoint = (point: unknown) => record(point) && instant(point.bucketStart) && Date.parse(point.bucketStart) % 3_600_000 === 0 && releasedCount(point.researchUnits)
  && (point.publishedAt === undefined || instant(point.publishedAt)) && (point.minimumContributors === undefined || count(point.minimumContributors) && point.minimumContributors >= 20)
  && (point.rounding === undefined || point.rounding === 5) && (point.lagHours === undefined || count(point.lagHours) && point.lagHours >= 1)
  && (point.methodologyVersion === undefined || point.methodologyVersion === 1);
const validListing = (listing: unknown) => record(listing) && [listing.symbol, listing.ticker, listing.exchange].every((value) => typeof value === "string" && value.length > 0)
  && [listing.name, listing.country, listing.sector].every(nullableText);
const validEvidence = (evidence: unknown) => record(evidence) && [evidence.asOf, evidence.periodStart, evidence.periodEnd].every(instant)
  && Date.parse(evidence.periodEnd) > Date.parse(evidence.periodStart) && evidence.unit === "rounded researcher-hours" && evidence.confidence === "privacy-thresholded"
  && typeof evidence.source === "string" && evidence.methodologyVersion === 1;
function validRow(row: unknown): row is AttentionRow {
  if (!record(row) || !validEvidence(row.evidence)) return false;
  return [row.symbol, row.ticker, row.exchange].every((value) => typeof value === "string" && value.length > 0)
    && [row.name, row.country, row.sector].every(nullableText) && count(row.rank) && row.rank > 0
    && releasedCount(row.researchUnits) && finite(row.sharePct) && row.sharePct >= 0 && row.sharePct <= 100
    && nullableNumber(row.zScore) && count(row.baselinePeriods) && nullableNumber(row.priceChangePct) && nullableNumber(row.relativeVolume)
    && (row.relativeVolumeAsOf == null || instant(row.relativeVolumeAsOf)) && (row.marketAsOf === null || instant(row.marketAsOf)) && Array.isArray(row.history)
    && row.history.every(validPoint)
    && new Set(row.history.map((point: { bucketStart: string }) => point.bucketStart)).size === row.history.length
    && Array.isArray(row.news) && row.news.every((article: unknown) => record(article) && typeof article.title === "string" && safeUrl(article.url) && instant(article.publishedAt))
;
}
export function validateAttention(payload: AttentionPayload): AttentionPayload {
  if (!record(payload) || !instant(payload.generatedAt) || !(payload.asOf === null || instant(payload.asOf))
    || !["now", "today", "week"].includes(payload.window) || ![payload.periodStart, payload.periodEnd].every(instant)
    || !["disabled", "collecting", "ready"].includes(payload.status) || typeof payload.stale !== "boolean"
    || !Array.isArray(payload.rows) || !payload.rows.every(validRow) || new Set(payload.rows.map((row) => row.symbol)).size !== payload.rows.length
    || ![payload.sectors, payload.countries].every((groups) => Array.isArray(groups) && groups.every((group) => record(group)
      && typeof group.name === "string" && releasedCount(group.researchUnits) && count(group.tickers) && finite(group.sharePct) && group.sharePct >= 0 && group.sharePct <= 100))
    || !record(payload.privacy) || !count(payload.privacy.minimumContributors) || payload.privacy.minimumContributors < 20
    || !count(payload.privacy.rounding) || payload.privacy.rounding !== 5 || !count(payload.privacy.lagHours) || payload.privacy.lagHours < 1
    || !count(payload.privacy.methodologyVersion) || !record(payload.coverage) || !Object.values(payload.coverage).every(count)
    || !record(payload.counts) || ![payload.counts.rows, payload.counts.sectors, payload.counts.countries].every(count)
    || !["pro", "preview"].includes(payload.entitlement) || typeof payload.truncated !== "boolean" || !safeUrl(payload.methodologyUrl)
    || payload.history !== undefined && (!Array.isArray(payload.history) || !payload.history.every(validPoint))
    || payload.selectedListing != null && !validListing(payload.selectedListing)
    || payload.historyEvidence != null && !validEvidence(payload.historyEvidence)
    || (payload.history?.length ?? 0) > 0 && (!payload.selectedListing || !payload.historyEvidence)
    || payload.entitlement === "preview" && ((payload.history?.length ?? 0) > 1 || payload.rows.length > 3 || payload.sectors.length > 3 || payload.countries.length > 3 || payload.rows.some((row) => row.history.length > 1)))
    throw new Error("The server returned invalid attention data.");
  return payload;
}
type AttentionApi = Pick<typeof apiClient, "getCloudAttention">;
export async function fetchAttention(window: AttentionWindow, symbol?: string, client: AttentionApi = apiClient) {
  const payload = validateAttention(await client.getCloudAttention(window, symbol));
  if (payload.window !== window || symbol && (payload.rows.some((row) => !listingMatches(symbol, row)) || payload.selectedListing && !listingMatches(symbol, payload.selectedListing)))
    throw new Error("The server returned attention for a different selection.");
  return payload;
}
const key = (window: AttentionWindow, accessKey: string, symbol?: string) => JSON.stringify([accessKey, window, symbol ?? null]);
function validateForAccess(payload: AttentionPayload, accessKey: string) {
  const valid = validateAttention(payload);
  if (accessKey.endsWith(":preview") && valid.entitlement !== "preview") throw new Error("Attention access changed. Refresh your account and try again.");
  return valid;
}
export const cachedAttention = (window: AttentionWindow, accessKey: string, symbol?: string) => cachedCloudResource(attentionCache, key(window, accessKey, symbol), (payload) => validateForAccess(payload, accessKey));
export const loadAttention = (window: AttentionWindow, accessKey: string, symbol?: string, force = false) =>
  loadCloudResource(attentionCache, key(window, accessKey, symbol), async () => validateForAccess(await fetchAttention(window, symbol), accessKey), { force, validate: (payload) => validateForAccess(payload, accessKey) });
