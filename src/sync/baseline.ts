import type { AppPluginStateStorePort } from "../core/app-service-ports";
import type { SyncBaselineStore } from "./types";

const BASELINE_PLUGIN_ID = "core.sync";
const BASELINE_KEY = "last-synced-payloads";
const MEMOS_KEY = "contributor-memos";
const ACCOUNT_KEY = "account";

/**
 * Persists what this device last pushed so the next pull can tell "the cloud is
 * newer" from "local changed while the app was closed". Without it every launch
 * treats local state as pristine and the cloud overwrites CLI/offline edits.
 *
 * Storage failures do not stop sync, but missing merge history can prevent
 * contributors from recognizing unsynced local edits.
 */
export function createSyncBaselineStore(pluginState: Pick<AppPluginStateStorePort, "get" | "set">): SyncBaselineStore {
  const load = (key: string) => {
    try {
      return pluginState.get<Record<string, unknown>>(BASELINE_PLUGIN_ID, key)?.value ?? null;
    } catch {
      return null;
    }
  };
  const save = (key: string, value: Record<string, unknown>) => {
    try {
      pluginState.set(BASELINE_PLUGIN_ID, key, value);
    } catch {
      // Persistence is best effort; keep the in-memory merge history usable.
    }
  };
  return {
    loadAccountId: () => {
      const id = load(ACCOUNT_KEY)?.id;
      return typeof id === "string" ? id : null;
    },
    saveAccountId: (id) => save(ACCOUNT_KEY, { id }),
    load: () => load(BASELINE_KEY),
    save: (payloads) => save(BASELINE_KEY, payloads),
    loadMemos: () => load(MEMOS_KEY),
    saveMemos: (memos) => save(MEMOS_KEY, memos),
  };
}
