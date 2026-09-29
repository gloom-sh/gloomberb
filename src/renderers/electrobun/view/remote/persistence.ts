import {
  createPersistScheduler,
  PLUGIN_STATE_SAVE_DEBOUNCE_MS,
  SESSION_SAVE_DEBOUNCE_MS,
} from "../../../../state/persist-scheduler";
import { backendRequest, getElectrobunBackendInitSnapshot } from "../backend-rpc";
import { MemoryResourceStore } from "../../../../data/memory-resource-store";

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

/** The latest unsaved change to one plugin key: its new value, or its removal. */
type PluginStateChange = PluginStatePersistEntry | { pluginId: string; key: string; deleted: true };

class RemotePluginStateStore {
  private readonly state = new Map<string, Map<string, unknown>>();
  private readonly unsaved = new Map<string, PluginStateChange>();
  // One batch for every key, armed by the first unsaved change and not pushed
  // back by later ones, so a key written on every frame cannot hold the others
  // back. Saves run one at a time and a key's latest change replaces its
  // earlier one, so a delete and a later write cannot land out of order.
  private readonly saves = createPersistScheduler<void>({
    delayMs: PLUGIN_STATE_SAVE_DEBOUNCE_MS,
    save: async () => {
      const changes = [...this.unsaved.values()];
      this.unsaved.clear();
      const entries = changes.filter((change): change is PluginStatePersistEntry => !("deleted" in change));
      await Promise.all([
        entries.length > 0 ? backendRequest("pluginState.setMany", { entries }) : null,
        ...changes
          .filter((change) => "deleted" in change)
          .map(({ pluginId, key }) => backendRequest("pluginState.delete", { pluginId, key })),
      ]);
    },
  });

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
    // Closing the window tears down the RPC before a debounced save can land.
    // Auth has to reach SQLite immediately or the next launch is signed out.
    this.record({ pluginId, key, value, schemaVersion }, key === "session" || key === "resume:session");
  }

  delete(pluginId: string, key: string): void {
    this.state.get(pluginId)?.delete(key);
    this.record({ pluginId, key, deleted: true }, true);
  }

  keys(pluginId: string): string[] {
    return [...(this.state.get(pluginId)?.keys() ?? [])];
  }

  clear(pluginId: string): void {
    this.state.delete(pluginId);
  }

  flush(): Promise<void> {
    return this.saves.flush();
  }

  private record(change: PluginStateChange, immediate: boolean): void {
    // A non-empty batch already has a save armed or queued that has not taken
    // it yet, so only the first change arms one.
    if (this.unsaved.size === 0 && !immediate) this.saves.schedule();
    this.unsaved.set(`${change.pluginId}\u0000${change.key}`, change);
    if (immediate) void this.saves.saveImmediately().catch(() => {});
  }
}

export class RemotePersistence {
  readonly tickers = {};
  readonly resources = new MemoryResourceStore();
  readonly pluginState = new RemotePluginStateStore(getElectrobunBackendInitSnapshot()?.pluginState ?? {});
  readonly sessions = new RemoteSessionStore();

  close(): void {
    void this.sessions.flush();
    void this.pluginState.flush();
  }
}
