import type { AppPersistencePort } from "../../core/app-service-ports";
import type { PluginStateRecord } from "../../data/plugin-state-store";
import type { SessionSnapshotRecord } from "../../data/session-store";
import { DesktopMemoryResourceStore } from "../electrobun/view/resource-store";
import { BROWSER_STORAGE_KEYS, SafeJsonStorage, type StorageLike } from "./storage";

type PluginState = Record<string, Record<string, PluginStateRecord>>;
type Sessions = Record<string, SessionSnapshotRecord>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export class BrowserPersistence implements AppPersistencePort {
  readonly resources = new DesktopMemoryResourceStore();
  private readonly pluginStateData: SafeJsonStorage<PluginState>;
  private readonly sessionData: SafeJsonStorage<Sessions>;

  constructor(storage: StorageLike) {
    this.pluginStateData = new SafeJsonStorage(storage, BROWSER_STORAGE_KEYS.pluginState, {}, (value): value is PluginState => isRecord(value));
    this.sessionData = new SafeJsonStorage(storage, BROWSER_STORAGE_KEYS.session, {}, (value): value is Sessions => isRecord(value));
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
