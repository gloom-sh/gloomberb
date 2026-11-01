import type { AppSessionSnapshot } from "../../../../../core/state/session-persistence";
import { clonePaneStateMap, type PaneRuntimeState } from "../../../../../core/state/app/state";
import { cloneLayout, findPaneInstance, type AppConfig, type LayoutConfig } from "../../../../../types/config";
import type { DesktopSharedStateSnapshot } from "../../../../../types/desktop-window";
import { detachPaneToFrame, dockPane, insertAtRootEdge, removePane } from "../../../../../layout/pane-manager";
import { MAIN_WINDOW_ID, type ExtraWindowRecord } from "../../../../desktop/screen-setup";
import {
  activateLayout,
  addWindow,
  closeWindow,
  createWindowLayouts,
  extraWindowRecords,
  layoutMoveBlock,
  locatePane,
  mergeWindowSnapshot,
  moveLayoutToWindow,
  movePaneToWindow,
  paneMoveBlock,
  projectWindow,
  replaceSharedConfig,
  windowOfLayout,
  windowTabs,
  type WindowLayouts,
} from "../../../../desktop/window-layouts";
import type { WindowFrame } from "../../window/frame";

function cloneSavedLayouts(config: AppConfig): AppConfig["layouts"] {
  return config.layouts.map((entry) => ({
    ...entry,
    layout: cloneLayout(entry.layout),
    paneState: entry.paneState ? clonePaneStateMap(entry.paneState) : entry.paneState,
  }));
}

function cloneSnapshot(snapshot: DesktopSharedStateSnapshot): DesktopSharedStateSnapshot {
  return {
    ...snapshot,
    config: {
      ...snapshot.config,
      layout: cloneLayout(snapshot.config.layout),
      layouts: cloneSavedLayouts(snapshot.config),
    },
    paneState: clonePaneStateMap(snapshot.paneState),
    brokerSyncErrors: { ...snapshot.brokerSyncErrors },
  };
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

/** The same, for the main window's live layout and its saved copy. */
function keepMainDetachedFrames(state: WindowLayouts, current: LayoutConfig): WindowLayouts {
  if (current.detached.length === 0) return state;
  const layout = keepDetachedFrames(state.config.layout, current);
  if (layout === state.config.layout) return state;
  return {
    ...state,
    config: {
      ...state.config,
      layout,
      layouts: state.config.layouts.map((entry, index) => (
        index === state.config.activeLayoutIndex ? { ...entry, layout: cloneLayout(layout) } : entry
      )),
    },
  };
}

/**
 * A popped-out window cannot open, move or close panes, and its copy of the
 * layout is refreshed only when its own pane changes. So a whole-config save
 * from it can only mean edits to its own pane (title, settings, binding); the
 * rest of the layout it sends can predate a pane the main window just opened,
 * and taking it would close that pane again.
 */
function takeOwnPaneInstance(layout: LayoutConfig, sent: LayoutConfig, paneId: string): LayoutConfig {
  const instance = findPaneInstance(sent, paneId);
  if (!instance || !findPaneInstance(layout, paneId)) return layout;
  return {
    ...layout,
    instances: layout.instances.map((entry) => (entry.instanceId === paneId ? instance : entry)),
  };
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

/** How many states sent to a window are kept for its next sync to be merged against. */
const SENT_HISTORY = 24;

export interface DesktopWorkspace {
  /** The shared state: every tab, with the main window's active layout, pane state and focus. What is saved. */
  getSnapshot(): DesktopSharedStateSnapshot;
  /** What a full window draws: its own tabs and state. A popped-out pane's window gets the main window's. */
  getWindowSnapshot(windowId: string): DesktopSharedStateSnapshot | null;
  /** The full windows, the main one first. */
  windowIds(): string[];
  extraWindows(): ExtraWindowRecord[];
  /** Where a pane is: its tab and the window showing it. */
  locatePane(paneId: string): { layoutId: string; windowId: string } | null;
  windowOfLayout(layoutId: string): string | null;
  /** Names of each full window's tabs, for menus that offer to move something there. */
  windowTabNames(windowId: string): { active: string; count: number } | null;
  /** A state `windowId` was sent, under the number it carried; its next sync may be built on it. */
  noteDelivered(windowId: string, seq: number, snapshot: DesktopSharedStateSnapshot): void;
  /** A window started over (a load or reload): nothing sent to it before counts. */
  forgetWindow(windowId: string): void;
  syncMainState(snapshot: DesktopSharedStateSnapshot, baseSeq?: number | null): DesktopSharedStateSnapshot;
  /** A full window's whole state, merged over what it was built on: `baseSeq` names a state it was sent, else its own last. */
  syncWindowState(windowId: string, snapshot: DesktopSharedStateSnapshot, baseSeq?: number | null): DesktopSharedStateSnapshot;
  replaceConfig(config: AppConfig, options?: { layoutChanged?: boolean }): DesktopSharedStateSnapshot;
  /** A whole-config save from a full window: only what it changed since it last synced counts. */
  replaceConfigFromWindow(windowId: string, config: AppConfig): DesktopSharedStateSnapshot;
  /** A whole-config save from the popped-out window for `paneId`: the open tab's panes count only for that pane. */
  replaceConfigFromDetachedPane(paneId: string, config: AppConfig): DesktopSharedStateSnapshot;
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
  /** Opens a full window on `layoutId` (moved from where it is) or on a new empty tab. Null when that tab cannot move. */
  openWindow(windowId: string, layoutId?: string): DesktopSharedStateSnapshot | null;
  /** Closes a full window; its tabs go back to the main window. */
  closeWindow(windowId: string): DesktopSharedStateSnapshot;
  moveLayoutToWindow(layoutId: string, windowId: string): DesktopSharedStateSnapshot | null;
  movePaneToWindow(paneId: string, windowId: string): DesktopSharedStateSnapshot | null;
  /** Shows one of a window's tabs there. */
  activateLayout(windowId: string, layoutId: string): DesktopSharedStateSnapshot;
}

export function createDesktopWorkspace(
  config: AppConfig,
  sessionSnapshot: AppSessionSnapshot | null,
  extraWindowsKept: readonly ExtraWindowRecord[] = [],
): DesktopWorkspace {
  const savedPaneState = config.layouts[config.activeLayoutIndex]?.paneState ?? {};
  const initialPaneState = filterPaneState(config.layout, clonePaneStateMap({
    ...(sessionSnapshot?.paneState ?? {}),
    ...savedPaneState,
  }));
  const initialFocusedPaneId = config.layouts[config.activeLayoutIndex]?.focusedPaneId
    ?? sessionSnapshot?.focusedPaneId
    ?? null;
  let state = createWindowLayouts(config, {
    paneState: initialPaneState,
    focusedPaneId: initialFocusedPaneId,
    statusBarVisible: sessionSnapshot?.statusBarVisible !== false,
  }, extraWindowsKept);
  /** The last revision each window sent, which the states it is sent carry. */
  const revisions = new Map<string, number>([[MAIN_WINDOW_ID, 0]]);
  let layoutChanged: boolean | undefined;
  const sent = new Map<string, Map<number, DesktopSharedStateSnapshot>>();
  /** What each window last sent: what its next sync is built on unless it took a newer state since. */
  const received = new Map<string, DesktopSharedStateSnapshot>();

  const mainView = () => state.views[MAIN_WINDOW_ID]!;

  const getSnapshot = (): DesktopSharedStateSnapshot => cloneSnapshot({
    config: state.config,
    paneState: mainView().paneState,
    focusedPaneId: mainView().focusedPaneId,
    statusBarVisible: mainView().statusBarVisible,
    brokerSyncErrors: state.brokerSyncErrors,
    mainStateRevision: revisions.get(MAIN_WINDOW_ID) ?? 0,
    layoutChanged,
  });

  const getWindowSnapshot = (windowId: string): DesktopSharedStateSnapshot | null => {
    const shown = state.views[windowId] ? windowId : MAIN_WINDOW_ID;
    const projection = projectWindow(state, shown);
    if (!projection) return null;
    return cloneSnapshot({ ...projection, mainStateRevision: revisions.get(shown) ?? 0, layoutChanged });
  };

  /** Takes a whole config the backend built from the shared state, keeping the main window's pane state. */
  const updateConfig = (nextConfig: AppConfig, options?: { layoutChanged?: boolean }) => {
    const view = mainView();
    state = replaceSharedConfig(state, nextConfig, view);
    state = {
      ...state,
      views: {
        ...state.views,
        [MAIN_WINDOW_ID]: { ...mainView(), paneState: filterPaneState(state.config.layout, mainView().paneState) },
      },
    };
    layoutChanged = options?.layoutChanged;
    return getSnapshot();
  };

  const baseFor = (windowId: string, baseSeq: number | null | undefined): DesktopSharedStateSnapshot | null => {
    if (typeof baseSeq === "number") return sent.get(windowId)?.get(baseSeq) ?? null;
    return received.get(windowId) ?? null;
  };

  const syncWindowState = (
    windowId: string,
    snapshot: DesktopSharedStateSnapshot,
    baseSeq?: number | null,
  ): DesktopSharedStateSnapshot => {
    const currentRevision = revisions.get(windowId) ?? 0;
    if (typeof snapshot.mainStateRevision === "number" && snapshot.mainStateRevision <= currentRevision) {
      return getSnapshot();
    }
    if (!state.views[windowId]) return getSnapshot();
    const base = baseFor(windowId, baseSeq);
    const detachedBefore = state.config.layout;
    state = mergeWindowSnapshot(state, windowId, base, snapshot);
    if (windowId === MAIN_WINDOW_ID) state = keepMainDetachedFrames(state, detachedBefore);
    revisions.set(windowId, snapshot.mainStateRevision ?? currentRevision);
    received.set(windowId, snapshot);
    // The states it was sent before the one it built on will not be built on again.
    const history = sent.get(windowId);
    if (history && typeof baseSeq === "number") {
      for (const seq of history.keys()) if (seq < baseSeq) history.delete(seq);
    }
    layoutChanged = snapshot.layoutChanged;
    return getSnapshot();
  };

  return {
    getSnapshot,
    getWindowSnapshot,
    windowIds: () => [...state.windowIds],
    extraWindows: () => extraWindowRecords(state),
    locatePane: (paneId) => locatePane(state, paneId),
    windowOfLayout: (layoutId) => windowOfLayout(state, layoutId),
    windowTabNames(windowId) {
      const view = state.views[windowId];
      if (!view) return null;
      const tabs = windowTabs(state, windowId);
      return { active: tabs.find((tab) => tab.id === view.activeLayoutId)?.name ?? "", count: tabs.length };
    },
    noteDelivered(windowId, seq, snapshot) {
      let history = sent.get(windowId);
      if (!history) {
        history = new Map();
        sent.set(windowId, history);
      }
      history.set(seq, snapshot);
      while (history.size > SENT_HISTORY) history.delete(history.keys().next().value!);
    },
    forgetWindow(windowId) {
      sent.delete(windowId);
      received.delete(windowId);
    },
    syncMainState: (snapshot, baseSeq) => syncWindowState(MAIN_WINDOW_ID, snapshot, baseSeq),
    syncWindowState,
    replaceConfig(nextConfig: AppConfig, options) {
      return updateConfig({ ...nextConfig, layout: keepDetachedFrames(nextConfig.layout, state.config.layout) }, options);
    },
    replaceConfigFromWindow(windowId, nextConfig) {
      const view = state.views[windowId];
      if (!view) return getSnapshot();
      const base = received.get(windowId) ?? null;
      const detachedBefore = state.config.layout;
      state = mergeWindowSnapshot(state, windowId, base, {
        config: nextConfig,
        paneState: base?.paneState ?? view.paneState,
        focusedPaneId: base?.focusedPaneId ?? view.focusedPaneId,
        statusBarVisible: base?.statusBarVisible ?? view.statusBarVisible,
        brokerSyncErrors: base?.brokerSyncErrors ?? state.brokerSyncErrors,
      });
      if (windowId === MAIN_WINDOW_ID) state = keepMainDetachedFrames(state, detachedBefore);
      layoutChanged = true;
      return getSnapshot();
    },
    replaceConfigFromDetachedPane(paneId, nextConfig) {
      const current = projectWindow(state, MAIN_WINDOW_ID)!;
      // The Layouts pane can be popped out, so a save can carry a renamed,
      // added or reordered tab, or a switch: the tab list and the active tab
      // come from the save. The panes of the tab both windows are on do not.
      const sentTab = nextConfig.layouts[nextConfig.activeLayoutIndex];
      const shown = current.config.layouts[current.config.activeLayoutIndex];
      const sameTab = !!sentTab && !!shown && (sentTab.id && shown.id
        ? sentTab.id === shown.id
        : sentTab.name === shown.name || nextConfig.activeLayoutIndex === current.config.activeLayoutIndex);
      const layout = sameTab
        ? takeOwnPaneInstance(current.config.layout, nextConfig.layout, paneId)
        : nextConfig.layout;
      const detachedBefore = state.config.layout;
      state = mergeWindowSnapshot(state, MAIN_WINDOW_ID, current, {
        ...current,
        config: { ...nextConfig, layout },
        paneState: sameTab ? current.paneState : nextConfig.layouts[nextConfig.activeLayoutIndex]?.paneState ?? {},
      });
      state = keepMainDetachedFrames(state, detachedBefore);
      layoutChanged = true;
      return getSnapshot();
    },
    replaceDetachedPaneState(paneId, paneState) {
      const view = mainView();
      const nextPaneState = filterPaneState(state.config.layout, { ...view.paneState, [paneId]: { ...paneState } });
      state = replaceSharedConfig(state, state.config, { ...view, paneState: nextPaneState });
      return getSnapshot();
    },
    updateDetachedFrame(paneId, frame) {
      return updateConfig({
        ...state.config,
        layout: setDetachedFrame(state.config.layout, paneId, frame),
      }, { layoutChanged: true });
    },
    popOutPane(paneId, frame) {
      return updateConfig({
        ...state.config,
        layout: detachPaneToFrame(state.config.layout, paneId, frame),
      }, { layoutChanged: true });
    },
    dockDetachedPane(paneId, edge) {
      // Only an edge drop passes an edge. That frame is in the dock zone, where
      // a re-opened window would dock again, so it keeps the one it had.
      const layout = edge ? state.config.layout : rememberDetachedFrame(state.config.layout, paneId);
      return updateConfig({
        ...state.config,
        layout: edge ? insertAtRootEdge(layout, paneId, edge) : dockPane(layout, paneId),
      }, { layoutChanged: true });
    },
    closeDetachedPane(paneId) {
      const nextLayout = removePane(state.config.layout, paneId);
      return updateConfig({
        ...state.config,
        layout: nextLayout,
      }, { layoutChanged: true });
    },
    openWindow(windowId, layoutId) {
      if (layoutId && layoutMoveBlock(state, layoutId, MAIN_WINDOW_ID) === "missing") return null;
      const next = addWindow(state, windowId, layoutId ? { layoutId } : {});
      if (next === state || !next.views[windowId]) return null;
      state = next;
      layoutChanged = true;
      return getSnapshot();
    },
    closeWindow(windowId) {
      state = closeWindow(state, windowId);
      sent.delete(windowId);
      received.delete(windowId);
      revisions.delete(windowId);
      layoutChanged = true;
      return getSnapshot();
    },
    moveLayoutToWindow(layoutId, windowId) {
      if (layoutMoveBlock(state, layoutId, windowId)) return null;
      state = moveLayoutToWindow(state, layoutId, windowId);
      layoutChanged = true;
      return getSnapshot();
    },
    movePaneToWindow(paneId, windowId) {
      if (paneMoveBlock(state, paneId, windowId)) return null;
      state = movePaneToWindow(state, paneId, windowId);
      layoutChanged = true;
      return getSnapshot();
    },
    activateLayout(windowId, layoutId) {
      state = activateLayout(state, windowId, layoutId);
      return getSnapshot();
    },
  };
}
