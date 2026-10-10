/** Map data through the Cloud client: venues, the geo layer catalog, entity pages and details. */
import { apiClient, type CloudWorldVenueMapPayload } from "../../../api-client";
import {
  getGeoEntities,
  getGeoEntity,
  loadGeoCatalog,
  type GeoEntitiesPayload,
  type GeoEntitiesQuery,
  type GeoEntityPayload,
  type GeoLayersPayload,
  type GeoRequest,
} from "../../../api-client/geo";

export const ENTITY_PAGE_SIZE = 100;

/** Requests under /cloud/geo/ through the shared client, resolved late so tests can stub it. */
export const cloudGeoRequest: GeoRequest = (path, init) => apiClient.geo(path, init);

export async function loadWorldVenues(): Promise<CloudWorldVenueMapPayload> {
  const response = await apiClient.getCloudWorldVenues();
  if (!response.data) throw new Error(response.reasonCode ?? "World venue data unavailable");
  return response.stale ? { ...response.data, stale: true } : response.data;
}

export function loadMapCatalog(request: GeoRequest = cloudGeoRequest, force = false): Promise<GeoLayersPayload | null> {
  return loadGeoCatalog(request, { force });
}

export function loadEntityPage(
  layerId: string,
  query: GeoEntitiesQuery,
  signal: AbortSignal,
  request: GeoRequest = cloudGeoRequest,
): Promise<GeoEntitiesPayload> {
  return getGeoEntities(request, layerId, { limit: ENTITY_PAGE_SIZE, ...query }, signal);
}

export function loadEntityDetail(
  layerId: string,
  entityId: string,
  signal?: AbortSignal,
  request: GeoRequest = cloudGeoRequest,
): Promise<GeoEntityPayload> {
  return getGeoEntity(request, layerId, entityId, signal);
}
