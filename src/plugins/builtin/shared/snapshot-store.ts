import { readStoredPaneSidebarWidth } from "../../../components/layout/pane/sidebar-metrics";
import type { PluginPersistence } from "../../../types/plugin";

/**
 * Minimal external store compatible with `useSyncExternalStore`. Subclasses
 * mutate via `update(patch)` and read via `this.snapshot` / `getSnapshot()`.
 */
export class SnapshotStore<T extends object> {
  protected snapshot: T;
  private readonly listeners = new Set<(snapshot: T) => void>();

  constructor(protected readonly initialSnapshot: T) {
    this.snapshot = initialSnapshot;
  }

  getSnapshot(): T {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: T) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  protected update(patch: Partial<T>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

/** Snapshot store that also persists a resizable pane sidebar width. */
export class SidebarWidthSnapshotStore<T extends { width: number | null }> extends SnapshotStore<T> {
  protected persistence: PluginPersistence | null = null;

  constructor(
    initialSnapshot: T,
    private readonly widthStateKey: string,
  ) {
    super(initialSnapshot);
  }

  protected readPersistedWidth(persistence: PluginPersistence): number | null {
    return readStoredPaneSidebarWidth(persistence.getState(this.widthStateKey));
  }

  /** Live drag feedback: updates every frame without touching persistence. */
  setWidth(width: number): void {
    if (this.snapshot.width === width) return;
    this.update({ width } as Partial<T>);
  }

  /** Called once a drag settles, so a resize survives a restart. */
  commitWidth(width: number): void {
    this.setWidth(width);
    this.persistence?.setState(this.widthStateKey, width);
  }
}
