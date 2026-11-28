import { apiClient } from "../../../api-client";
import type { CatalystDetail, CatalystEvent, CatalystFilters, CatalystResponse } from "../../../api-client/catalysts";
import { hasUniqueIds, isFraction, isIsoInstant, isNullableString } from "../../../utils/guards";
import { createCloudEndpoint } from "../shared/cloud-resource";

const policy = { staleMs: 5 * 60_000, expireMs: 86_400_000 };
const validEvent = (event: CatalystEvent): boolean => !!event && typeof event.id === "string" && typeof event.revisionId === "string" && typeof event.title === "string"
  && isIsoInstant(event.observedAt) && typeof event.status === "string" && Array.isArray(event.parties)
  && event.parties.every((p) => typeof p.name === "string" && isNullableString(p.ticker))
  && Array.isArray(event.changes) && !!event.datePrecision && /^https?:\/\//.test(event.sourceUrl) && isFraction(event.confidence);
export function validateCatalysts(payload: CatalystResponse): CatalystResponse {
  if (!payload || !Array.isArray(payload.events) || !payload.events.every(validEvent) || !payload.facets || !Number.isFinite(payload.total)
    || !Number.isInteger(payload.offset) || !Number.isInteger(payload.limit) || !hasUniqueIds(payload.events))
    throw new Error("The server returned invalid catalyst events.");
  return payload;
}
function validateCatalystDetail(payload: CatalystDetail, id?: string): CatalystDetail {
  if (!payload || !validEvent(payload.event) || (id && payload.event.id !== id) || !Array.isArray(payload.history)
    || !payload.history.every((event) => validEvent(event) && event.id === payload.event.id)) throw new Error("The server returned invalid event history.");
  return payload;
}
const catalystEndpoint = createCloudEndpoint<{ query: CatalystFilters; accessKey?: string }, CatalystResponse, Pick<typeof apiClient, "getCloudCatalysts">>({
  kind: "catalysts", schemaVersion: 1, policy, key: ({ accessKey, query }) => `${accessKey}:${JSON.stringify(query)}`,
  defaultClient: apiClient, fetch: ({ query }, client, signal) => client.getCloudCatalysts(query, signal), validate: validateCatalysts,
});
const catalystDetailEndpoint = createCloudEndpoint<{ id: string; accessKey?: string; query?: { offset?: number; limit?: number } }, CatalystDetail, Pick<typeof apiClient, "getCloudCatalystEvent">>({
  kind: "catalyst-detail", schemaVersion: 1, policy, key: ({ accessKey, id, query }) => `${accessKey}:${id}:${query?.offset ?? 0}`,
  defaultClient: apiClient, fetch: ({ id, query = {} }, client, signal) => client.getCloudCatalystEvent(id, signal, query),
  validate: (payload, { id }) => validateCatalystDetail(payload, id),
});
export const catalystCache = catalystEndpoint.cache;
export const catalystDetailCache = catalystDetailEndpoint.cache;
export const fetchCatalysts = (query: CatalystFilters, client: Pick<typeof apiClient, "getCloudCatalysts"> = apiClient, signal?: AbortSignal) =>
  catalystEndpoint.fetch({ query }, { client, signal });
export const fetchCatalystDetail = (id: string, client: Pick<typeof apiClient, "getCloudCatalystEvent"> = apiClient, signal?: AbortSignal, query: { offset?: number; limit?: number } = {}) =>
  catalystDetailEndpoint.fetch({ id, query }, { client, signal });
export const loadCatalysts = (query: CatalystFilters, accessKey: string, force = false, signal?: AbortSignal) =>
  catalystEndpoint.load({ query, accessKey }, { force, signal });
export const loadCatalystDetail = (id: string, accessKey: string, force = false, offset = 0, signal?: AbortSignal) =>
  catalystDetailEndpoint.load({ id, accessKey, query: { offset, limit: 100 } }, { force, signal });
