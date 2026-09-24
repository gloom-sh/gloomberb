import type { AppSessionSnapshot } from "../../../../../core/state/session-persistence";
import { clonePaneStateMap, syncConfigActiveLayoutState, type PaneRuntimeState } from "../../../../../core/state/app/state";
import { cloneLayout, type AppConfig, type LayoutConfig } from "../../../../../types/config";
import type { DesktopSharedStateSnapshot } from "../../../../../types/desktop-window";
import { detachPaneToFrame, dockPane, insertAtRootEdge, removePane } from "../../../../../plugins/pane-manager";
import type { WindowFrame } from "../../window/frame";

function cloneSavedLayouts(config: AppConfig): AppConfig["layouts"] {
  return config.layouts.map((entry) => ({
    ...entry,
    layout: cloneLayout(entry.layout),
    paneState: entry.paneState ? clonePaneStateMap(entry.paneState) : entry.paneState,
  }));
}

function filterPaneState(
  layout: AppConfig["layout"],
  paneState: Record<string, PaneRuntimeState>,
): Record<string, PaneRuntimeState> {
  const validPaneIds = new Set(layout.instances.map((instance) => instance.instanceId));
  return Object.fromEntries(
    Object.entries(paneState).filter(([paneId]) => validPaneIds.has(paneId)),
  );
}

function setDetachedFrame(layout: LayoutConfig, paneId: string, frame: WindowFrame): LayoutConfig {
  return {
    ...layout,
    detached: layout.detached.map((entry) => (
      entry.instanceId === paneId
        ? { ...entry, x: frame.x, y: frame.y, width: frame.width, height: frame.height }
        : entry
    )),
  };
}

/**
 * Only this process sees a popped-out window move. A renderer's copy of the
 * layout can hold an older frame: a popped-out window rehydrates only when its
 * own pane changes, and the main window can send state it built before the
 * last move reached it. Applying that frame would throw the window back, so a
 * pane that stays popped out keeps its window where it is, whatever the
 * config says; a pane the config newly pops out opens where it puts it.
 */
function keepDetachedFrames(layout: LayoutConfig, current: LayoutConfig): LayoutConfig {
  return current.detached.reduce((next, entry) => (
    next.detached.some((candidate) => candidate.instanceId === entry.instanceId)
      ? setDetachedFrame(next, entry.instanceId, entry)
      : next
  ), layout);
}

/** Docking forgets the window, so its frame is kept for the next pop-out. */
function rememberDetachedFrame(layout: LayoutConfig, paneId: string): LayoutConfig {
  const entry = layout.detached.find((candidate) => candidate.instanceId === paneId);
  if (!entry) return layout;
  const frame = { x: entry.x, y: entry.y, width: entry.width, height: entry.height };
  return {
    ...layout,
    instances: layout.instances.map((instance) => (
      instance.instanceId === paneId
        ? { ...instance, placementMemory: { ...instance.placementMemory, detached: frame } }
        : instance
    )),
  };
}

export interface DesktopWorkspace {
  getSnapshot(): DesktopSharedStateSnapshot;
  syncMainState(snapshot: DesktopSharedStateSnapshot): DesktopSharedStateSnapshot;
  replaceConfig(config: AppConfig, options?: { layoutChanged?: boolean }): DesktopSharedStateSnapshot;
  replaceDetachedPaneState(paneId: string, paneState: PaneRuntimeState): DesktopSharedStateSnapshot;
  updateDetachedFrame(
    paneId: string,
    frame: { x: number; y: number; width: number; height: number },
  ): DesktopSharedStateSnapshot;
  popOutPane(
    paneId: string,
    frame: { x: number; y: number; width: number; height: number },
  ): DesktopSharedStateSnapshot;
  dockDetachedPane(
    paneId: string,
    edge?: "left" | "right" | "top" | "bottom",
  ): DesktopSharedStateSnapshot;
  closeDetachedPane(paneId: string): DesktopSharedStateSnapshot;
}

export function createDesktopWorkspace(
  config: AppConfig,
  sessionSnapshot: AppSessionSnapshot | null,
): DesktopWorkspace {
  const savedPaneState = config.layouts[config.activeLayoutIndex]?.paneState ?? {};
  const initialPaneState = filterPaneState(config.layout, clonePaneStateMap({
    ...(sessionSnapshot?.paneState ?? {}),
    ...savedPaneState,
  }));
  const initialFocusedPaneId = config.layouts[config.activeLayoutIndex]?.focusedPaneId
    ?? sessionSnapshot?.focusedPaneId
    ?? null;
  const initialActivePanel = config.layouts[config.activeLayoutIndex]?.activePanel
    ?? (sessionSnapshot?.activePanel === "right" ? "right" : "left");
  let sharedState: DesktopSharedStateSnapshot = {
    config: syncConfigActiveLayoutState(config, initialPaneState, initialFocusedPaneId, initialActivePanel),
    paneState: initialPaneState,
    focusedPaneId: initialFocusedPaneId,
    activePanel: initialActivePanel,
    statusBarVisible: sessionSnapshot?.statusBarVisible !== false,
    mainStateRevision: 0,
  };

  const updateConfig = (nextConfig: AppConfig, options?: { layoutChanged?: boolean }) => {
    const syncedConfig = syncConfigActiveLayoutState(
      nextConfig,
      sharedState.paneState,
      sharedState.focusedPaneId,
      sharedState.activePanel,
    );
    sharedState = {
      ...sharedState,
      config: {
        ...syncedConfig,
        layout: cloneLayout(syncedConfig.layout),
        layouts: cloneSavedLayouts(syncedConfig),
      },
      paneState: filterPaneState(syncedConfig.layout, sharedState.paneState),
      layoutChanged: options?.layoutChanged,
    };
    return getSnapshot();
  };

  const getSnapshot = (): DesktopSharedStateSnapshot => ({
    config: {
      ...sharedState.config,
      layout: cloneLayout(sharedState.config.layout),
      layouts: cloneSavedLayouts(sharedState.config),
    },
    paneState: clonePaneStateMap(sharedState.paneState),
    focusedPaneId: sharedState.focusedPaneId,
    activePanel: sharedState.activePanel,
    statusBarVisible: sharedState.statusBarVisible,
    mainStateRevision: sharedState.mainStateRevision,
    layoutChanged: sharedState.layoutChanged,
  });

  return {
    getSnapshot,
    syncMainState(snapshot) {
      const currentRevision = sharedState.mainStateRevision ?? 0;
      if (
        typeof snapshot.mainStateRevision === "number"
        && snapshot.mainStateRevision <= currentRevision
      ) {
        return getSnapshot();
      }
      const syncedConfig = syncConfigActiveLayoutState(
        { ...snapshot.config, layout: keepDetachedFrames(snapshot.config.layout, sharedState.config.layout) },
        snapshot.paneState,
        snapshot.focusedPaneId,
        snapshot.activePanel,
      );
      sharedState = {
        config: {
          ...syncedConfig,
          layout: cloneLayout(syncedConfig.layout),
          layouts: cloneSavedLayouts(syncedConfig),
        },
        paneState: filterPaneState(syncedConfig.layout, clonePaneStateMap(snapshot.paneState)),
        focusedPaneId: snapshot.focusedPaneId,
        activePanel: snapshot.activePanel,
        statusBarVisible: snapshot.statusBarVisible,
        mainStateRevision: snapshot.mainStateRevision ?? currentRevision,
        layoutChanged: snapshot.layoutChanged,
      };
      return getSnapshot();
    },
    replaceConfig(config: AppConfig, options) {
      return updateConfig({ ...config, layout: keepDetachedFrames(config.layout, sharedState.config.layout) }, options);
    },
    replaceDetachedPaneState(paneId, paneState) {
      const nextPaneState = filterPaneState(sharedState.config.layout, {
        ...sharedState.paneState,
        [paneId]: { ...paneState },
      });
      sharedState = {
        ...sharedState,
        config: syncConfigActiveLayoutState(
          sharedState.config,
          nextPaneState,
          sharedState.focusedPaneId,
          sharedState.activePanel,
        ),
        paneState: nextPaneState,
      };
      return getSnapshot();
    },
    updateDetachedFrame(paneId, frame) {
      return updateConfig({
        ...sharedState.config,
        layout: setDetachedFrame(sharedState.config.layout, paneId, frame),
      }, { layoutChanged: true });
    },
    popOutPane(paneId, frame) {
      return updateConfig({
        ...sharedState.config,
        layout: detachPaneToFrame(sharedState.config.layout, paneId, frame),
      }, { layoutChanged: true });
    },
    dockDetachedPane(paneId, edge) {
      // Only an edge drop passes an edge. That frame is in the dock zone, where
      // a re-opened window would dock again, so it keeps the one it had.
      const layout = edge ? sharedState.config.layout : rememberDetachedFrame(sharedState.config.layout, paneId);
      return updateConfig({
        ...sharedState.config,
        layout: edge ? insertAtRootEdge(layout, paneId, edge) : dockPane(layout, paneId),
      }, { layoutChanged: true });
    },
    closeDetachedPane(paneId) {
      const nextLayout = removePane(sharedState.config.layout, paneId);
      sharedState = {
        ...sharedState,
        paneState: filterPaneState(nextLayout, sharedState.paneState),
      };
      return updateConfig({
        ...sharedState.config,
        layout: nextLayout,
      }, { layoutChanged: true });
    },
  };
}
