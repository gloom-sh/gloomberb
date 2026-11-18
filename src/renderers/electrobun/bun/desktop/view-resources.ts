import { isBrokerAccountSnapshotKey, listPersistedBrokerAccountRecords } from "../../../../brokers/account-cache";
import type { AppServices } from "../../../../core/app-services";
import { applyResourceSync, VIEW_RESOURCE_NAMESPACES, WARM_RESOURCE_BUDGET } from "../../../../data/durable-resources";
import { resourceRecordKey, type WarmResourceRecord } from "../../../../data/memory-resource-store";
import type { AppConfig } from "../../../../types/config";
import type { DesktopResourceRequest } from "../../shared/protocol";

/**
 * The view keeps the plugins' caches in memory and writes them through to
 * this process's cache database. A window starts from the ones read most
 * recently (`WARM_RESOURCE_BUDGET`), with every saved broker account snapshot
 * whatever its place, so its panes open on their saved copies as the
 * terminal's do.
 */
export function loadDesktopViewResources(services: Pick<AppServices, "persistence">, config: Pick<AppConfig, "brokerInstances">): WarmResourceRecord[] {
  const resources = services.persistence.resources;
  const records = new Map<string, WarmResourceRecord>();
  try {
    for (const record of listPersistedBrokerAccountRecords(resources, config.brokerInstances)) records.set(resourceRecordKey(record), record);
    for (const record of resources.listRecent(VIEW_RESOURCE_NAMESPACES, WARM_RESOURCE_BUDGET)) {
      if (!isBrokerAccountSnapshotKey(record)) records.set(resourceRecordKey(record), record);
    }
  } catch (error) {
    console.warn("saved resources could not be read", error);
  }
  return [...records.values()];
}

/** `resources.sync`: what the view saved, dropped and read since its last batch. */
export function handleDesktopViewResourceRequest(
  services: Pick<AppServices, "persistence">,
  request: DesktopResourceRequest,
): null {
  applyResourceSync(services.persistence.resources, request.payload);
  return null;
}
