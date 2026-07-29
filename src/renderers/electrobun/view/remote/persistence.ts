import {
  createPersistScheduler,
  PLUGIN_STATE_SAVE_DEBOUNCE_MS,
  SESSION_SAVE_DEBOUNCE_MS,
} from "../../../../state/persist-scheduler";
import { backendRequest, getElectrobunBackendInitSnapshot } from "../backend-rpc";
import { DesktopMemoryResourceStore } from "../resource-store";

const PLUGIN_STATE_BACKEND_FLUSH_DELAY_MS = 25;

class RemoteSessionStore {
  private snapshot = getElectrobunBackendInitSnapshot()?.sessionSnapshot ?? null;
  private readonly scheduler = createPersistScheduler<{
    sessionId: string;
    value: unknown;
    schemaVersion: number;
  }>({
    delayMs: SESSION_SAVE_DEBOUNCE_MS,
    save: async ({ sessionId, value, schemaVersion }) => {
      await backendRequest("session.set", { sessionId, value, schemaVersion });
    },
  });

  get<T>(sessionId = "app", schemaVersion = 1) {
    if (sessionId !== "app" || !this.snapshot) return null;
    return {
      sessionId,
      value: this.snapshot as T,
      schemaVersion,
      updatedAt: Date.now(),
    };
  }

  set(sessionId: string, value: unknown, schemaVersion = 1): void {
    if (sessionId === "app") this.snapshot = value as typeof this.snapshot;
    this.scheduler.schedule({ sessionId, value, schemaVersion });
  }

  delete(sessionId: string): void {
    if (sessionId === "app") this.snapshot = null;
    this.scheduler.cancel();
    void backendRequest("session.delete", { sessionId }).catch(() => {});
  }

  flush(): Promise<void> {
    return this.scheduler.flush();
  }
}

interface PluginStatePersistEntry {
  pluginId: string;
  key: string;
  value: unknown;
  schemaVersion: number;
}

class RemotePluginStateStore {
  private readonly state = new Map<string, Map<string, unknown>>();
  private readonly schedulers = new Map<string, ReturnType<typeof createPersistScheduler<PluginStatePersistEntry>>>();
  private readonly pendingBackendSaves = new Map<string, PluginStatePersistEntry>();
  private backendSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private backendSaveInFlight: Promise<void> = Promise.resolve();

  constructor(initial: Record<string, Record<string, unknown>>) {
    for (const [pluginId, values] of Object.entries(initial)) {
      this.state.set(pluginId, new Map(Object.entries(values)));
    }
  }

  get<T>(pluginId: string, key: string, schemaVersion = 1) {
    const value = this.state.get(pluginId)?.get(key);
    if (value == null) return null;
    return { value: value as T, schemaVersion, updatedAt: Date.now() };
  }

  set(pluginId: string, key: string, value: unknown, schemaVersion = 1): void {
    if (!this.state.has(pluginId)) this.state.set(pluginId, new Map());
    this.state.get(pluginId)!.set(key, value);
    this.getScheduler(pluginId, key).schedule({ pluginId, key, value, schemaVersion });
  }

  delete(pluginId: string, key: string): void {
    this.state.get(pluginId)?.delete(key);
    this.getScheduler(pluginId, key).cancel();
    this.pendingBackendSaves.delete(this.schedulerKey(pluginId, key));
    void this.backendSaveInFlight
      .catch(() => {})
      .then(() => backendRequest("pluginState.delete", { pluginId, key }))
      .catch(() => {});
  }

  keys(pluginId: string): string[] {
    return [...(this.state.get(pluginId)?.keys() ?? [])];
  }

  clear(pluginId: string): void {
    this.state.delete(pluginId);
  }

  async flush(): Promise<void> {
    await Promise.all([...this.schedulers.values()].map((scheduler) => scheduler.flush()));
    await this.flushBackendSaves();
  }

  private getScheduler(pluginId: string, key: string) {
    const schedulerKey = this.schedulerKey(pluginId, key);
    let scheduler = this.schedulers.get(schedulerKey);
    if (!scheduler) {
      scheduler = createPersistScheduler({
        delayMs: PLUGIN_STATE_SAVE_DEBOUNCE_MS,
        save: (entry) => {
          this.scheduleBackendSave(entry);
        },
      });
      this.schedulers.set(schedulerKey, scheduler);
    }
    return scheduler;
  }

  private schedulerKey(pluginId: string, key: string): string {
    return `${pluginId}\u0000${key}`;
  }

  private scheduleBackendSave(entry: PluginStatePersistEntry): void {
    this.pendingBackendSaves.set(this.schedulerKey(entry.pluginId, entry.key), entry);
    if (this.backendSaveTimer) return;
    this.backendSaveTimer = setTimeout(() => {
      void this.flushBackendSaves();
    }, PLUGIN_STATE_BACKEND_FLUSH_DELAY_MS);
  }

  private async flushBackendSaves(): Promise<void> {
    if (this.backendSaveTimer) {
      clearTimeout(this.backendSaveTimer);
      this.backendSaveTimer = null;
    }
    if (this.pendingBackendSaves.size === 0) return this.backendSaveInFlight;

    const entries = [...this.pendingBackendSaves.values()];
    this.pendingBackendSaves.clear();
    const save = this.backendSaveInFlight
      .catch(() => {})
      .then(async () => {
        await backendRequest("pluginState.setMany", { entries });
      })
      .catch(() => {});
    this.backendSaveInFlight = save;
    return save;
  }
}

export class RemotePersistence {
  readonly tickers = {};
  readonly resources = new DesktopMemoryResourceStore();
  readonly pluginState = new RemotePluginStateStore(getElectrobunBackendInitSnapshot()?.pluginState ?? {});
  readonly sessions = new RemoteSessionStore();

  close(): void {
    void this.sessions.flush();
    void this.pluginState.flush();
  }
}
