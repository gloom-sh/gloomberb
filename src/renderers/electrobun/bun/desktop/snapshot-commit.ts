import { syncConfigActiveLayoutState, type PaneRuntimeState } from "../../../../core/state/app/state";
import type { AppConfig } from "../../../../types/config";
import type { DesktopSharedStateSnapshot } from "../../../../types/desktop-window";
import { logFailure } from "../../../../utils/log-failure";

export function syncActiveLayout(
  config: AppConfig,
  paneState: Record<string, PaneRuntimeState> = config.layouts[config.activeLayoutIndex]?.paneState ?? {},
  focusedPaneId: string | null = config.layouts[config.activeLayoutIndex]?.focusedPaneId ?? null,
): AppConfig {
  return syncConfigActiveLayoutState(config, paneState, focusedPaneId);
}

/** What a desktop state change touches in the backend. */
export interface DesktopSnapshotCommitHost {
  setConfig(config: AppConfig): void;
  replaceConfig(config: AppConfig, options: { layoutChanged?: boolean }): void;
  currentSnapshot(): DesktopSharedStateSnapshot;
  saveConfig(config: AppConfig): Promise<void>;
  reconcileWindows(): void;
  broadcastState(snapshot: DesktopSharedStateSnapshot): void;
  sendWindowList(): void;
  /** Tells the person a change nobody waited on was not saved. */
  reportSaveFailure(): void;
}

export interface DesktopSnapshotCommitOptions {
  persistConfig?: boolean;
  reconcileWindows?: boolean;
}

/**
 * Makes a state change the backend's, saves its config and shows it in every
 * window. The windows follow even when the save fails: the backend holds the
 * change already, and a window left on the old state would send it back. The
 * failed save rejects after that.
 */
export async function commitDesktopSnapshot(
  host: DesktopSnapshotCommitHost,
  snapshot: DesktopSharedStateSnapshot,
  options: DesktopSnapshotCommitOptions = {},
): Promise<DesktopSharedStateSnapshot> {
  const nextConfig = syncActiveLayout(snapshot.config, snapshot.paneState, snapshot.focusedPaneId);
  host.setConfig(nextConfig);
  host.replaceConfig(nextConfig, { layoutChanged: snapshot.layoutChanged });
  let saveFailure: { error: unknown } | null = null;
  if (options.persistConfig !== false) {
    try {
      await host.saveConfig(nextConfig);
    } catch (error) {
      saveFailure = { error };
    }
  }
  if (options.reconcileWindows !== false) {
    host.reconcileWindows();
  }
  host.broadcastState(host.currentSnapshot());
  host.sendWindowList();
  if (saveFailure) throw saveFailure.error;
  return host.currentSnapshot();
}

/**
 * A change no request waits on: a window or popped-out pane closed, a pane
 * docked or moved by dragging. A failure is logged, and the main window says
 * the change was not saved.
 */
export function commitDesktopSnapshotInBackground(
  host: DesktopSnapshotCommitHost,
  snapshot: DesktopSharedStateSnapshot,
  options: DesktopSnapshotCommitOptions = {},
): void {
  commitDesktopSnapshot(host, snapshot, options).catch((error: unknown) => {
    logFailure("desktop-backend", "Saving a window change failed")(error);
    host.reportSaveFailure();
  });
}
