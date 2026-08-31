import {
  apiClient,
  type CloudSavedSearch,
  type CloudSavedSearchInput,
  type CloudSearchDocType,
  type CloudSearchDocument,
  type CloudSearchResponse,
} from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { CloudSearchParams } from "../../../api-client/paths";
import type { PluginPersistence } from "../../../types/plugin";

const DOCUMENT_KIND = "document";
const CACHE_SOURCE = "research-search";
const CACHE_SCHEMA_VERSION = 1;

/**
 * A published transcript, wire story, or filing does not change once indexed,
 * so re-opening a hit should not hit the network again.
 */
const DOCUMENT_CACHE_POLICY = {
  staleMs: 7 * 24 * 60 * 60 * 1000,
  expireMs: 90 * 24 * 60 * 60 * 1000,
} as const;

let persistence: PluginPersistence | null = null;

export function attachResearchSearchPersistence(value: PluginPersistence): void {
  persistence = value;
}

export function resetResearchSearchPersistence(): void {
  persistence = null;
}

export function statusOf(error: unknown): number | undefined {
  return error instanceof ApiRequestError ? error.status : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function runDocumentSearch(
  params: CloudSearchParams,
  signal?: AbortSignal,
): Promise<CloudSearchResponse> {
  return apiClient.searchCloudDocuments(params, { signal });
}

function documentKey(docType: CloudSearchDocType, sourceId: string): string {
  return `${docType}:${sourceId}`;
}

export async function loadSearchDocument(
  docType: CloudSearchDocType,
  sourceId: string,
  signal?: AbortSignal,
): Promise<CloudSearchDocument> {
  const key = documentKey(docType, sourceId);
  const cached = persistence?.getResource<CloudSearchDocument>(DOCUMENT_KIND, key, {
    sourceKey: CACHE_SOURCE,
    schemaVersion: CACHE_SCHEMA_VERSION,
  });
  if (cached && !cached.stale) return cached.value;

  try {
    const document = await apiClient.getCloudSearchDocument(docType, sourceId, { signal });
    persistence?.setResource(DOCUMENT_KIND, key, document, {
      sourceKey: CACHE_SOURCE,
      schemaVersion: CACHE_SCHEMA_VERSION,
      cachePolicy: DOCUMENT_CACHE_POLICY,
    });
    return document;
  } catch (error) {
    const status = statusOf(error);
    const expired = persistence?.getResource<CloudSearchDocument>(DOCUMENT_KIND, key, {
      sourceKey: CACHE_SOURCE,
      schemaVersion: CACHE_SCHEMA_VERSION,
      allowExpired: true,
    });
    // Losing entitlement has to re-gate the document, not serve it from cache.
    if (expired && status !== 401 && status !== 402 && status !== 403) return expired.value;
    throw error;
  }
}

export function loadSavedSearches(signal?: AbortSignal): Promise<CloudSavedSearch[]> {
  return apiClient.getCloudSavedSearches({ signal });
}

export function createSavedSearch(input: CloudSavedSearchInput): Promise<CloudSavedSearch> {
  return apiClient.createCloudSavedSearch(input);
}

export function updateSavedSearch(
  id: string,
  update: Partial<CloudSavedSearchInput>,
): Promise<CloudSavedSearch> {
  return apiClient.updateCloudSavedSearch(id, update);
}

export function deleteSavedSearch(id: string): Promise<void> {
  return apiClient.deleteCloudSavedSearch(id);
}
