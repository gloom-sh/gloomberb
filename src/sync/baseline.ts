import type { AppPluginStateStorePort } from "../core/app-service-ports";
import { SyncHistoryUnavailableError, type SyncBaselineStore } from "./types";
import { logFailure } from "../utils/log-failure";

const BASELINE_PLUGIN_ID = "core.sync";
const BASELINE_KEY = "last-synced-payloads";
const MEMOS_KEY = "contributor-memos";
const ACCOUNT_KEY = "account";

/**
 * Persists what this device last pushed so the next pull can tell "the cloud is
 * newer" from "local changed while the app was closed". Without it every launch
 * treats local state as pristine and the cloud overwrites CLI/offline edits.
 *
 * A read or write the storage refuses, and a stored row it cannot read
 * (damaged, or written under another schema version), throw
 * `SyncHistoryUnavailableError` (without the storage's own error), so they are
 * never mistaken for a device that has not synced yet; the controller pauses
 * sync until storage works. Only a row that is not there reads as null.
 */
export function createSyncBaselineStore(pluginState: Pick<AppPluginStateStorePort, "get" | "set" | "getStrict">): SyncBaselineStore {
  const load = (key: string) => {
    try {
      // `get` drops a row it cannot read and answers null, which would read as never synced.
      const record = pluginState.getStrict
        ? pluginState.getStrict<Record<string, unknown>>(BASELINE_PLUGIN_ID, key)
        : pluginState.get<Record<string, unknown>>(BASELINE_PLUGIN_ID, key);
      return record?.value ?? null;
    } catch (error) {
      logFailure("sync.baseline", "Load sync baseline failed")(error);
      throw new SyncHistoryUnavailableError();
    }
  };
  const save = (key: string, value: Record<string, unknown>) => {
    try {
      pluginState.set(BASELINE_PLUGIN_ID, key, value);
    } catch (error) {
      logFailure("sync.baseline", "Save sync baseline failed")(error);
      throw new SyncHistoryUnavailableError();
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
