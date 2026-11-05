import {
  createPersistScheduler,
  PLUGIN_STATE_SAVE_DEBOUNCE_MS,
  SESSION_SAVE_DEBOUNCE_MS,
  type PersistScheduler,
} from "../../../../state/persist-scheduler";
import { backendRequest, getElectrobunBackendInitSnapshot } from "../backend-rpc";
import { WriteThroughResourceStore } from "../../../../data/memory-resource-store";
import { isBrokerAccountSnapshotKey } from "../../../../brokers/account-cache";
import { logFailure } from "../../../../utils/log-failure";

class RemoteSessionStore {
  private snapshot = getElectrobunBackendInitSnapshot()?.sessionSnapshot ?? null;
  /** One debounced save per session, so a write or a delete of one session leaves another's pending save alone. */
  private readonly schedulers = new Map<string, PersistScheduler<{ value: unknown; schemaVersion: number }>>();

  private scheduler(sessionId: string): PersistScheduler<{ value: unknown; schemaVersion: number }> {
    let scheduler = this.schedulers.get(sessionId);
    if (!scheduler) {
      scheduler = createPersistScheduler({
        delayMs: SESSION_SAVE_DEBOUNCE_MS,
        save: async ({ value, schemaVersion }) => {
          await backendRequest("session.set", { sessionId, value, schemaVersion });
        },
      });
      this.schedulers.set(sessionId, scheduler);
    }
    return scheduler;
  }

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
    this.scheduler(sessionId).schedule({ value, schemaVersion });
  }

  delete(sessionId: string): void {
    if (sessionId === "app") this.snapshot = null;
    this.schedulers.get(sessionId)?.cancel();
    void backendRequest("session.delete", { sessionId }).catch(logFailure("desktop-view-persistence", "Could not delete a saved session"));
  }

  async flush(): Promise<void> {
    await Promise.all([...this.schedulers.values()].map((scheduler) => scheduler.flush()));
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

function changeKey({ pluginId, key }: PluginStateChange): string {
  return `${pluginId}\u0000${key}`;
}

class RemotePluginStateStore {
  private readonly state = new Map<string, Map<string, unknown>>();
  private readonly unsaved = new Map<string, PluginStateChange>();
  /** A save is armed or queued that has not taken the unsaved batch yet. */
  private pending = false;
  // One batch for every key, armed by the first unsaved change and not pushed
  // back by later ones, so a key written on every frame cannot hold the others
  // back. Saves run one at a time and a key's latest change replaces its
  // earlier one, so a delete and a later write cannot land out of order. A
  // change whose request failed goes back into the batch, unless a newer
  // change to its key has replaced it, and goes out with the next save.
  private readonly saves = createPersistScheduler<void>({
    delayMs: PLUGIN_STATE_SAVE_DEBOUNCE_MS,
    save: async () => {
      this.pending = false;
      const changes = [...this.unsaved.values()];
      this.unsaved.clear();
      const entries = changes.filter((change): change is PluginStatePersistEntry => !("deleted" in change));
      const deletions = changes.filter((change) => "deleted" in change);
      const [written, ...deleted] = await Promise.allSettled([
        entries.length > 0 ? backendRequest("pluginState.setMany", { entries }) : null,
        ...deletions.map(({ pluginId, key }) => backendRequest("pluginState.delete", { pluginId, key })),
      ]);
      const failed = [
        ...(written!.status === "rejected" ? entries : []),
        ...deletions.filter((_, index) => deleted[index]!.status === "rejected"),
      ];
      for (const change of failed) {
        if (!this.unsaved.has(changeKey(change))) this.unsaved.set(changeKey(change), change);
      }
      const failure = [written!, ...deleted].find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
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
    // Changes put back after a failed save have no save armed until this one.
    if (this.unsaved.size > 0) this.arm();
    return this.saves.flush();
  }

  private record(change: PluginStateChange, immediate: boolean): void {
    this.unsaved.set(changeKey(change), change);
    if (!immediate) {
      this.arm();
      return;
    }
    this.pending = true;
    void this.saves.saveImmediately().catch(logFailure("desktop-view-persistence", "Could not save plugin state right away"));
  }

  /** Only the first change arms a save: one already armed or queued takes the whole batch when it runs. */
  private arm(): void {
    if (this.pending) return;
    this.pending = true;
    this.saves.schedule();
  }
}

/**
 * Caches stay in the view's memory, except broker account snapshots: the Bun
 * process saves those in the cache database, as the terminal does, so a
 * broker portfolio opens with its last known equity and cash.
 */
function createViewResourceStore(): WriteThroughResourceStore {
  return new WriteThroughResourceStore(getElectrobunBackendInitSnapshot()?.savedResources ?? [], {
    set: (record) => void backendRequest("resources.set", { record }).catch(logFailure("desktop-view-persistence", "Could not save a broker account snapshot")),
    delete: (key) => void backendRequest("resources.delete", { key }).catch(logFailure("desktop-view-persistence", "Could not delete a broker account snapshot")),
  }, isBrokerAccountSnapshotKey);
}

export class RemotePersistence {
  readonly tickers = {};
  readonly resources = createViewResourceStore();
  readonly pluginState = new RemotePluginStateStore(getElectrobunBackendInitSnapshot()?.pluginState ?? {});
  readonly sessions = new RemoteSessionStore();

  close(): void {
    void this.sessions.flush();
    void this.pluginState.flush();
  }
}
