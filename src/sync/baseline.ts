import type { AppPluginStateStorePort } from "../core/app-service-ports";
import type { SyncBaselineStore } from "./types";

const BASELINE_PLUGIN_ID = "core.sync";
const BASELINE_KEY = "last-synced-payloads";

/**
 * Persists what this device last pushed so the next pull can tell "the cloud is
 * newer" from "local changed while the app was closed". Without it every launch
 * treats local state as pristine and the cloud overwrites CLI/offline edits.
 *
 * Storage failures are swallowed: a missing baseline only falls back to keeping
 * local state, never to discarding it.
 */
export function createSyncBaselineStore(pluginState: AppPluginStateStorePort): SyncBaselineStore {
  return {
    load: () => {
      try {
        return pluginState.get<Record<string, unknown>>(BASELINE_PLUGIN_ID, BASELINE_KEY)?.value ?? null;
      } catch {
        return null;
      }
    },
    save: (payloads) => {
      try {
        pluginState.set(BASELINE_PLUGIN_ID, BASELINE_KEY, payloads);
      } catch {
        // Ignored: a stale baseline only makes the next pull more conservative.
      }
    },
  };
}
