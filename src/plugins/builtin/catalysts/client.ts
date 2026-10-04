import { apiClient } from "../../../api-client";
import type { CatalystDetail, CatalystEvent, CatalystFilters, CatalystResponse } from "../../../api-client/catalysts";
import { createPluginCache } from "../../../data/plugin-cache";
import { loadCloudResource } from "../shared/cloud-resource";

export const catalystCache = createPluginCache<CatalystResponse>({ kind: "catalysts", source: "gloom-cloud", schemaVersion: 1, policy: { staleMs: 5 * 60_000, expireMs: 86_400_000 } });
export const catalystDetailCache = createPluginCache<CatalystDetail>({ kind: "catalyst-detail", source: "gloom-cloud", schemaVersion: 1, policy: { staleMs: 5 * 60_000, expireMs: 86_400_000 } });
const validEvent = (event: CatalystEvent): boolean => !!event && typeof event.id === "string" && typeof event.revisionId === "string" && typeof event.title === "string"
  && typeof event.observedAt === "string" && Number.isFinite(Date.parse(event.observedAt)) && typeof event.status === "string" && Array.isArray(event.parties)
  && event.parties.every((p) => typeof p.name === "string" && (p.ticker === null || typeof p.ticker === "string"))
  && Array.isArray(event.changes) && !!event.datePrecision && /^https?:\/\//.test(event.sourceUrl) && Number.isFinite(event.confidence) && event.confidence >= 0 && event.confidence <= 1;
export function validateCatalysts(payload: CatalystResponse): CatalystResponse {
  if (!payload || !Array.isArray(payload.events) || !payload.events.every(validEvent) || !payload.facets || !Number.isFinite(payload.total)
    || !Number.isInteger(payload.offset) || !Number.isInteger(payload.limit) || new Set(payload.events.map((e) => e.id)).size !== payload.events.length)
    throw new Error("The server returned invalid catalyst events.");
  return payload;
}
export function validateCatalystDetail(payload: CatalystDetail, id?: string): CatalystDetail {
  if (!payload || !validEvent(payload.event) || (id && payload.event.id !== id) || !Array.isArray(payload.history)
    || !payload.history.every((event) => validEvent(event) && event.id === payload.event.id)) throw new Error("The server returned invalid event history.");
  return payload;
}
export const fetchCatalysts = async (query: CatalystFilters, client: Pick<typeof apiClient, "getCloudCatalysts"> = apiClient, signal?: AbortSignal) => validateCatalysts(await client.getCloudCatalysts(query, signal));
export const fetchCatalystDetail = async (id: string, client: Pick<typeof apiClient, "getCloudCatalystEvent"> = apiClient, signal?: AbortSignal, query: { offset?: number; limit?: number } = {}) => validateCatalystDetail(await client.getCloudCatalystEvent(id, signal, query), id);
export const loadCatalysts = (query: CatalystFilters, accessKey: string, force = false, signal?: AbortSignal) =>
  loadCloudResource(catalystCache, `${accessKey}:${JSON.stringify(query)}`, () => fetchCatalysts(query, apiClient, signal), { force, validate: validateCatalysts });
export const loadCatalystDetail = (id: string, accessKey: string, force = false, offset = 0, signal?: AbortSignal) =>
  loadCloudResource(catalystDetailCache, `${accessKey}:${id}:${offset}`, () => fetchCatalystDetail(id, apiClient, signal, { offset, limit: 100 }), { force, validate: (payload) => validateCatalystDetail(payload, id) });
