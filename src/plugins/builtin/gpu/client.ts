import { resolvePlanAccess } from "../../../api-client/plan-rules";
import { apiClient } from "../../../api-client";
import type { GpuBoardPayload, GpuEventsPayload, GpuHistoryPayload, GpuHistoryQuery, GpuObservation } from "../../../api-client/gpu";
import { createPluginCache } from "../../../data/plugin-cache";
import type { DataProvider } from "../../../types/data-provider";
import { cachedCloudResource, loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";
import { equityFiveDayReturn, GPU_EQUITIES } from "./model";

export const GPU_NOT_AVAILABLE = "GPU rental prices are not available yet.";
const cacheOptions = { source: "gloom-cloud", schemaVersion: 2, policy: { staleMs: 5 * 60_000, expireMs: 7 * 86_400_000 } };
export const gpuBoardCache = createPluginCache<GpuBoardPayload>({ ...cacheOptions, kind: "gpu-board" });
export const gpuHistoryCache = createPluginCache<GpuHistoryPayload>({ ...cacheOptions, kind: "gpu-history" });
export const gpuEventsCache = createPluginCache<GpuEventsPayload>({ ...cacheOptions, kind: "gpu-events" });

const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nullableNumber = (value: unknown) => value === null || finite(value);
const instant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const nullableInstant = (value: unknown) => value === null || instant(value);
const nullableText = (value: unknown) => value === null || typeof value === "string";
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const basis = (value: unknown) => ["list", "spot", "ask", "reserved", "index"].includes(String(value));

const provenance = (value: unknown) => value === undefined || ["archive", "official-history", "live"].includes(String(value));
const optionalText = (value: unknown) => value === undefined || nullableText(value);
const validAccess = (value: unknown) => value === undefined || record(value) && ["pro", "preview"].includes(value.tier)
  && typeof value.preview === "boolean" && typeof value.locked === "boolean";
const validEvidence = (row: Record<string, any>) => provenance(row.provenance) && optionalText(row.provenanceLabel)
  && [row.evidenceUrl, row.sourceUrl].every((value) => value === undefined || value === null || typeof value === "string" && /^https?:\/\//.test(value));

/** Account and plan transitions must never reuse a full-history cache as a free preview. */
export function gpuCacheScope(): string {
  const user = apiClient.getCurrentUser();
  const access = resolvePlanAccess(user);
  return JSON.stringify([user?.id ?? null, access.emailVerified, access.hasProAccess]);
}
const scopedKey = (key: string) => `${gpuCacheScope()}:${key}`;

function validObservation(row: unknown): row is GpuObservation {
  if (!record(row)) return false;
  const stats = row.stats;
  return validEvidence(row) && [row.source, row.skuKey, row.provider, row.region, row.gpuModel].every((value) => typeof value === "string" && value.length > 0)
    && ["hyperscaler", "neocloud", "marketplace", "aggregate"].includes(row.providerClass)
    && Number.isInteger(row.gpuCount) && row.gpuCount > 0 && nullableText(row.formFactor)
    && (row.memoryGb === null || finite(row.memoryGb) && row.memoryGb > 0)
    && basis(row.basis) && finite(row.pricePerGpuHr) && row.pricePerGpuHr > 0
    && (row.priceNodeHr === null || finite(row.priceNodeHr) && row.priceNodeHr > 0)
    && row.currency === "USD" && nullableText(row.availability) && instant(row.observedAt) && nullableInstant(row.effectiveAt)
    && (stats === undefined || record(stats) && Number.isInteger(stats.n) && stats.n >= 0
      && finite(stats.min) && finite(stats.max) && stats.min > 0 && stats.min <= stats.max
      && [stats.p25, stats.p75, stats.rawMedian, stats.chainFactor].every((value) => value === undefined || finite(value) && value > 0)
      && (stats.p25 === undefined || stats.p75 === undefined || stats.p25 <= stats.p75)
      && (stats.constituents === undefined || strings(stats.constituents))
      && (stats.constituentPrices === undefined || record(stats.constituentPrices) && Object.values(stats.constituentPrices).every((value) => finite(value) && value > 0)));
}

function validateBoard(payload: GpuBoardPayload): GpuBoardPayload {
  if (!record(payload) || !validAccess(payload.access) || !instant(payload.generatedAt) || !nullableInstant(payload.asOf) || typeof payload.stale !== "boolean"
    || !["available", "partial", "unavailable"].includes(payload.status) || !strings(payload.gaps)
    || !Array.isArray(payload.rows) || !payload.rows.every((row) => validObservation(row)
      && typeof row.id === "string" && row.id === `${row.source}:${row.skuKey}` && typeof row.label === "string" && typeof row.sourceLabel === "string"
      && [row.change1d, row.change7d, row.change30d].every(nullableNumber) && typeof row.stale === "boolean" && nullableText(row.lastError))
    || new Set(payload.rows.map((row) => row.id)).size !== payload.rows.length) throw new Error("The server returned invalid GPU rental prices.");
  return payload;
}

function validateHistory(payload: GpuHistoryPayload): GpuHistoryPayload {
  if (!record(payload) || !validAccess(payload.access) || !instant(payload.generatedAt) || !Array.isArray(payload.points) || !payload.points.every(validObservation)
    || !Array.isArray(payload.effectivePoints) || !payload.effectivePoints.every(validObservation)) throw new Error("The server returned invalid GPU price history.");
  return payload;
}

function validateEvents(payload: GpuEventsPayload): GpuEventsPayload {
  if (!record(payload) || !validAccess(payload.access) || !instant(payload.generatedAt) || !Array.isArray(payload.events) || !payload.events.every((event) => record(event)
    && [event.id, event.source, event.skuKey, event.provider, event.gpuModel].every((value) => typeof value === "string")
    && ["price", "membership", "availability"].includes(event.kind) && validEvidence(event)
    && optionalText(event.oldAvailability) && optionalText(event.newAvailability) && (event.origin === undefined || ["published", "observed"].includes(event.origin))
    && basis(event.basis) && nullableText(event.formFactor) && nullableNumber(event.memoryGb)
    && instant(event.observedAt) && nullableInstant(event.effectiveAt) && finite(event.oldPrice) && event.oldPrice > 0
    && finite(event.newPrice) && event.newPrice > 0 && finite(event.changePct)
    && (event.oldMembers === null || strings(event.oldMembers)) && (event.newMembers === null || strings(event.newMembers))))
    throw new Error("The server returned invalid GPU price changes.");
  return payload;
}

type GpuApi = Pick<typeof apiClient, "getCloudGpuBoard" | "getCloudGpuHistory" | "getCloudGpuEvents">;

export async function fetchGpuBoard(client: Pick<GpuApi, "getCloudGpuBoard"> = apiClient): Promise<GpuBoardPayload> {
  let payload: GpuBoardPayload;
  try { payload = await client.getCloudGpuBoard(); }
  catch (error) { throw unavailableOnServer(error, GPU_NOT_AVAILABLE, [404, 503]); }
  const board = validateBoard(payload);
  if (board.status === "unavailable" || !board.rows.length) throw new Error(GPU_NOT_AVAILABLE);
  return board;
}

export async function fetchGpuHistory(query: GpuHistoryQuery, client: Pick<GpuApi, "getCloudGpuHistory"> = apiClient) {
  const payload = validateHistory(await client.getCloudGpuHistory(query));
  if ([...payload.points, ...payload.effectivePoints].some((row) => query.seriesId && `${row.source}:${row.skuKey}` !== query.seriesId
    || query.gpuModel && row.gpuModel !== query.gpuModel || query.basis && row.basis !== query.basis))
    throw new Error("The server returned history for a different GPU series.");
  return payload;
}

export async function fetchGpuEvents(gpuModel?: string, client: Pick<GpuApi, "getCloudGpuEvents"> = apiClient) {
  return validateEvents(await client.getCloudGpuEvents(gpuModel));
}

export const getCachedGpuBoard = () => cachedCloudResource(gpuBoardCache, scopedKey("board"), validateBoard);
export const loadGpuBoard = (force = false) => loadCloudResource(gpuBoardCache, scopedKey("board"), () => fetchGpuBoard(), { force, validate: validateBoard });
export const loadGpuHistory = (seriesId: string, force = false) => loadCloudResource(gpuHistoryCache, scopedKey(seriesId),
  () => fetchGpuHistory({ seriesId, limit: 10_000 }), { force, validate: validateHistory });
export const loadGpuEvents = (gpuModel?: string, force = false) => loadCloudResource(gpuEventsCache, scopedKey(gpuModel ?? "all"),
  () => fetchGpuEvents(gpuModel), { force, validate: validateEvents });

/** Six daily closes, independently dated from the current quote, and the month they come from. Missing data stays unavailable. */
export async function loadGpuEquityHistory(provider: Pick<DataProvider, "getPriceHistory">) {
  return Promise.all(GPU_EQUITIES.map(async ({ symbol }) => {
    try {
      const history = await provider.getPriceHistory(symbol, "", "1M");
      return { symbol, ...equityFiveDayReturn(history), history, error: null };
    } catch { return { symbol, value: null, asOf: null, history: [], error: `${symbol}: daily closes unavailable` }; }
  }));
}
