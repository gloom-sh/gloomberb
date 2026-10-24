import { findPaneInstance } from "../../../../../types/config";
import type { DesktopSharedStateSnapshot } from "../../../../../types/desktop-window";

export function prepareDetachedSnapshot(
  snapshot: DesktopSharedStateSnapshot,
  paneId: string,
): DesktopSharedStateSnapshot {
  return snapshot.focusedPaneId === paneId ? snapshot : { ...snapshot, focusedPaneId: paneId };
}

function collectPaneStateIds(snapshot: DesktopSharedStateSnapshot, paneId: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  let currentPaneId: string | null = paneId;

  while (currentPaneId && !seen.has(currentPaneId)) {
    seen.add(currentPaneId);
    ids.push(currentPaneId);

    const instance = findPaneInstance(snapshot.config.layout, currentPaneId);
    currentPaneId = instance?.binding?.kind === "follow" ? instance.binding.sourceInstanceId : null;
  }

  return ids;
}

export function detachedSnapshotKey(snapshot: DesktopSharedStateSnapshot, paneId: string): string {
  const paneStateIds = collectPaneStateIds(snapshot, paneId);
  return JSON.stringify({
    theme: snapshot.config.theme,
    baseCurrency: snapshot.config.baseCurrency,
    portfolios: snapshot.config.portfolios,
    watchlists: snapshot.config.watchlists,
    brokerInstances: snapshot.config.brokerInstances,
    brokerSyncErrors: snapshot.brokerSyncErrors ?? {},
    pluginConfig: snapshot.config.pluginConfig,
    disabledPlugins: snapshot.config.disabledPlugins,
    chartPreferences: snapshot.config.chartPreferences,
    instances: paneStateIds.map((id) => findPaneInstance(snapshot.config.layout, id) ?? null),
    paneState: Object.fromEntries(paneStateIds.map((id) => [id, snapshot.paneState[id] ?? {}])),
  });
}

/**
 * What a popped-out window takes of each state it is sent: nothing unless the
 * part for its pane and the panes it follows changed, and then all of it,
 * config included.
 */
export function createDetachedSnapshotFilter(
  paneId: string,
  initialSnapshot: DesktopSharedStateSnapshot | null,
): (snapshot: DesktopSharedStateSnapshot) => DesktopSharedStateSnapshot | null {
  let lastKey = initialSnapshot ? detachedSnapshotKey(initialSnapshot, paneId) : null;
  return (snapshot) => {
    const nextKey = detachedSnapshotKey(snapshot, paneId);
    if (nextKey === lastKey) return null;
    lastKey = nextKey;
    return prepareDetachedSnapshot(snapshot, paneId);
  };
}
