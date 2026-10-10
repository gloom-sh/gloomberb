import type { AppPersistencePort } from "../core/app-service-ports";
import type { PluginStateRecord } from "./plugin-state-store";
import type { SessionSnapshotRecord } from "./session-store";
import { resourceRecordKey, WriteThroughResourceStore } from "./memory-resource-store";
import type { CachedResourceRecord, ResourceCacheKey } from "./resource-store";
import { BROWSER_STORAGE_KEYS, SafeJsonStorage, type StorageLike } from "./json-storage";
import { isRecord } from "../utils/guards";

type PluginState = Record<string, Record<string, PluginStateRecord>>;
type Sessions = Record<string, SessionSnapshotRecord>;
type SavedResources = Record<string, CachedResourceRecord>;

export class JsonPersistence implements AppPersistencePort {
  /** In memory, except the records `keepResource` picks, which outlive a reload like the positions do. */
  readonly resources: WriteThroughResourceStore;
  private readonly pluginStateData: SafeJsonStorage<PluginState>;
  private readonly sessionData: SafeJsonStorage<Sessions>;
  private readonly resourceData: SafeJsonStorage<SavedResources>;

  constructor(storage?: StorageLike, { keepResource = () => false }: { keepResource?: (key: ResourceCacheKey) => boolean } = {}) {
    this.pluginStateData = new SafeJsonStorage(storage, BROWSER_STORAGE_KEYS.pluginState, {}, (value): value is PluginState => isRecord(value));
    this.sessionData = new SafeJsonStorage(storage, BROWSER_STORAGE_KEYS.session, {}, (value): value is Sessions => isRecord(value));
    this.resourceData = new SafeJsonStorage(storage, BROWSER_STORAGE_KEYS.resources, {}, (value): value is SavedResources => isRecord(value));
    const saved = Object.values(this.resourceData.get()).filter((record) => isRecord(record) && typeof record.kind === "string");
    this.resources = new WriteThroughResourceStore(saved, {
      set: (record) => this.resourceData.set({ ...this.resourceData.get(), [resourceRecordKey(record)]: record }),
      delete: (key) => {
        const next = { ...this.resourceData.get() };
        delete next[resourceRecordKey(key)];
        this.resourceData.set(next);
      },
    }, keepResource);
  }

  readonly pluginState = {
    get: <T>(pluginId: string, key: string, schemaVersion = 1): PluginStateRecord<T> | null => {
      const record = this.pluginStateData.get()[pluginId]?.[key];
      if (!isRecord(record) || record.schemaVersion !== schemaVersion || !("value" in record)) return null;
      return record as unknown as PluginStateRecord<T>;
    },
    set: (pluginId: string, key: string, value: unknown, schemaVersion = 1): void => {
      const state = this.pluginStateData.get();
      this.pluginStateData.set({
        ...state,
        [pluginId]: {
          ...state[pluginId],
          [key]: { value, schemaVersion, updatedAt: Date.now() },
        },
      });
    },
    delete: (pluginId: string, key: string): void => {
      const state = this.pluginStateData.get();
      const plugin = { ...state[pluginId] };
      delete plugin[key];
      this.pluginStateData.set({ ...state, [pluginId]: plugin });
    },
    keys: (pluginId: string): string[] => Object.keys(this.pluginStateData.get()[pluginId] ?? {}),
    clear: (pluginId: string): void => {
      const state = { ...this.pluginStateData.get() };
      delete state[pluginId];
      this.pluginStateData.set(state);
    },
  };

  readonly sessions = {
    get: <T>(sessionId = "app", schemaVersion = 1): SessionSnapshotRecord<T> | null => {
      const record = this.sessionData.get()[sessionId];
      if (!isRecord(record) || record.schemaVersion !== schemaVersion || !("value" in record)) return null;
      return record as unknown as SessionSnapshotRecord<T>;
    },
    set: (sessionId: string, value: unknown, schemaVersion = 1): void => {
      this.sessionData.set({
        ...this.sessionData.get(),
        [sessionId]: { sessionId, value, schemaVersion, updatedAt: Date.now() },
      });
    },
    delete: (sessionId: string): void => {
      const state = { ...this.sessionData.get() };
      delete state[sessionId];
      this.sessionData.set(state);
    },
  };

  close(): void {}
}
