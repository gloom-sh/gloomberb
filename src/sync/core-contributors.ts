import type { SyncContributor } from "./types";
import { collectCoreCollectionsPayload, coreCollectionsSyncContributor } from "./collections-contributor";
import { coreConfigSyncContributor } from "./config-contributor";
import { collectCoreConfigPayload, mergeConfigPayload } from "./config-merge";
import { layoutIntent } from "./layout-merge";
import { sanitizeUnknown } from "./sanitize";

export { coreCollectionsSyncContributor } from "./collections-contributor";
export { coreConfigSyncContributor } from "./config-contributor";

export function createCoreSyncContributors(): SyncContributor[] {
  return [coreConfigSyncContributor, coreCollectionsSyncContributor];
}

export const __syncContributorInternalsForTests = {
  layoutIntent,
  sanitizeUnknown,
  collectCoreConfigPayload,
  collectCoreCollectionsPayload,
  mergeConfigPayload,
};
