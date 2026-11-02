import {
  clonePaneStateMap,
  syncConfigActiveLayoutState,
  type PaneRuntimeState,
} from "../../core/state/app/state";
import { createSavedLayoutId } from "../../layout/pane-layout-move";
import { dockPane, floatAtRect, insertAtRootEdge, removePane } from "../../layout/pane-manager";
import {
  cloneLayout,
  createBlankLayout,
  findPaneInstance,
  type AppConfig,
  type LayoutConfig,
  type SavedLayout,
} from "../../types/config";
import type { DesktopSharedStateSnapshot, OtherWindowTab } from "../../types/desktop-window";
import { MAIN_WINDOW_ID, type ExtraWindowRecord } from "./screen-setup";

/**
 * Every full desktop window shows its own layout tabs from one shared config.
 * The config keeps every tab, in one order; each tab belongs to exactly one
 * window, the main window by default. A window is sent its projection: the
 * config with only its own tabs, its active tab as `layout`, and its own pane
 * state and focus. What a window sends back is merged against what it last
 * held, so it only ever changes what it changed: a window still drawing a
 * state from a moment ago never undoes another window's edit.
 *
 * Nothing here knows about a shell; the backend keeps one of these and sends
 * each window its projection.
 */

export interface WindowView {
  activeLayoutId: string;
  paneState: Record<string, PaneRuntimeState>;
  focusedPaneId: string | null;
  statusBarVisible: boolean;
}

export interface WindowLayouts {
  /** Every tab, in the config's order. `layout` and `activeLayoutIndex` are the main window's. */
  config: AppConfig;
  brokerSyncErrors: Record<string, string>;
  /** Every full window, the main one first, then in the order they opened. */
  windowIds: string[];
  views: Record<string, WindowView>;
  /** The window showing a tab, by tab id. A tab with no entry is the main window's. */
  owners: Record<string, string>;
}

const LAYOUT_KEYS = new Set<string>(["layout", "layouts", "activeLayoutIndex"]);

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    if (a.length !== other.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      if (!deepEqual(a[index], other[index])) return false;
    }
    return true;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => deepEqual(left[key], right[key]));
}

/**
 * Gives every tab an id, and a new one to a tab that repeats an earlier tab's
 * id: tabs belong to windows by id. Returns the same config when all are set.
 */
function ensureLayoutIds(config: AppConfig): AppConfig {
  const seen = new Set<string>();
  let changed = false;
  const layouts = config.layouts.map((entry) => {
    if (entry.id && !seen.has(entry.id)) {
      seen.add(entry.id);
      return entry;
    }
    changed = true;
    const id = createSavedLayoutId();
    seen.add(id);
    return { ...entry, id };
  });
  return changed ? { ...config, layouts } : config;
}

function layoutId(entry: SavedLayout): string {
  return entry.id!;
}

function ownerOf(state: Pick<WindowLayouts, "owners" | "views">, id: string): string {
  const owner = state.owners[id];
  return owner && state.views[owner] ? owner : MAIN_WINDOW_ID;
}

export function windowTabs(state: WindowLayouts, windowId: string): SavedLayout[] {
  return state.config.layouts.filter((entry) => ownerOf(state, layoutId(entry)) === windowId);
}

/** The window showing a tab, or null when no tab has the id. */
export function windowOfLayout(state: WindowLayouts, id: string): string | null {
  return state.config.layouts.some((entry) => entry.id === id) ? ownerOf(state, id) : null;
}

/** The tab holding a pane, and the window showing it. */
export function locatePane(state: WindowLayouts, paneId: string): { layoutId: string; windowId: string } | null {
  const entry = state.config.layouts.find((candidate) => !!findPaneInstance(candidate.layout, paneId));
  return entry ? { layoutId: layoutId(entry), windowId: ownerOf(state, layoutId(entry)) } : null;
}

function viewFromTab(tab: SavedLayout, statusBarVisible: boolean): WindowView {
  return {
    activeLayoutId: layoutId(tab),
    paneState: clonePaneStateMap(tab.paneState ?? {}),
    focusedPaneId: tab.focusedPaneId ?? null,
    statusBarVisible,
  };
}

/**
 * Settles a state after a change: every window shows tabs it owns, a window
 * left without tabs is gone, the main window keeps at least one, and the
 * config's active layout is the main window's.
 */
function settle(state: WindowLayouts): WindowLayouts {
  const ids = new Set(state.config.layouts.map(layoutId));
  const owners: Record<string, string> = {};
  for (const [id, windowId] of Object.entries(state.owners)) {
    if (ids.has(id) && windowId !== MAIN_WINDOW_ID && state.views[windowId]) owners[id] = windowId;
  }
  let next: WindowLayouts = { ...state, owners };
  // The main window always keeps a tab: the config's active layout is one of its.
  if (!next.config.layouts.some((entry) => !owners[layoutId(entry)])) {
    const first = next.config.layouts[0];
    if (first) delete owners[layoutId(first)];
  }
  const views: Record<string, WindowView> = {};
  const windowIds: string[] = [];
  for (const windowId of next.windowIds) {
    const view = next.views[windowId];
    if (!view) continue;
    const tabs = windowTabs(next, windowId);
    if (tabs.length === 0) continue;
    windowIds.push(windowId);
    views[windowId] = tabs.some((tab) => tab.id === view.activeLayoutId)
      ? view
      : viewFromTab(tabs[0]!, view.statusBarVisible);
  }
  next = { ...next, views, windowIds };
  const main = views[MAIN_WINDOW_ID]!;
  const mainIndex = next.config.layouts.findIndex((entry) => entry.id === main.activeLayoutId);
  const active = next.config.layouts[mainIndex]!;
  // The saved copy of the main window's active tab is kept current, so it is the live layout.
  return { ...next, config: { ...next.config, activeLayoutIndex: mainIndex, layout: cloneLayout(active.layout) } };
}

/**
 * The windows as the backend starts them: the config, the main window's live
 * state, and the extra windows this machine kept. A kept window whose tabs
 * are all gone is not opened again.
 */
export function createWindowLayouts(
  source: AppConfig,
  main: Omit<WindowView, "activeLayoutId"> & { brokerSyncErrors?: Record<string, string> },
  records: readonly ExtraWindowRecord[] = [],
): WindowLayouts {
  const config = ensureLayoutIds(syncConfigActiveLayoutState(source, main.paneState, main.focusedPaneId));
  const mainActiveId = layoutId(config.layouts[config.activeLayoutIndex]!);
  const owners: Record<string, string> = {};
  const views: Record<string, WindowView> = {
    [MAIN_WINDOW_ID]: {
      activeLayoutId: mainActiveId,
      paneState: main.paneState,
      focusedPaneId: main.focusedPaneId,
      statusBarVisible: main.statusBarVisible,
    },
  };
  const windowIds = [MAIN_WINDOW_ID];
  const byId = new Map(config.layouts.map((entry) => [layoutId(entry), entry] as const));
  for (const record of records) {
    if (views[record.id]) continue;
    const tabs = record.layoutIds.filter((id) => byId.has(id) && !owners[id] && id !== mainActiveId);
    if (tabs.length === 0) continue;
    for (const id of tabs) owners[id] = record.id;
    const active = byId.get(record.activeLayoutId && tabs.includes(record.activeLayoutId) ? record.activeLayoutId : tabs[0]!)!;
    views[record.id] = viewFromTab(active, main.statusBarVisible);
    windowIds.push(record.id);
  }
  return settle({
    config,
    brokerSyncErrors: { ...main.brokerSyncErrors },
    windowIds,
    views,
    owners,
  });
}

/** What the backend keeps on this machine about the extra windows. */
export function extraWindowRecords(state: WindowLayouts): ExtraWindowRecord[] {
  return state.windowIds
    .filter((windowId) => windowId !== MAIN_WINDOW_ID)
    .map((windowId) => ({
      id: windowId,
      layoutIds: windowTabs(state, windowId).map(layoutId),
      activeLayoutId: state.views[windowId]!.activeLayoutId,
    }));
}

/** The ticker a pane shows where it is: live on its window's shown tab, else as its tab saved it. */
function paneTicker(state: WindowLayouts, paneId: string, seen: Set<string>): string | null {
  if (seen.has(paneId)) return null;
  seen.add(paneId);
  const located = locatePane(state, paneId);
  if (!located) return null;
  const view = state.views[located.windowId];
  const tab = state.config.layouts.find((entry) => layoutId(entry) === located.layoutId)!;
  const shown = view?.activeLayoutId === located.layoutId;
  const layout = shown && located.windowId === MAIN_WINDOW_ID ? state.config.layout : tab.layout;
  const instance = findPaneInstance(layout, paneId);
  if (!instance) return null;
  const cursor = (shown ? view!.paneState : tab.paneState ?? {})[paneId]?.cursorSymbol;
  if (typeof cursor === "string" && cursor.trim()) return cursor;
  if (instance.binding?.kind === "fixed") return instance.binding.symbol;
  if (instance.binding?.kind === "follow") return paneTicker(state, instance.binding.sourceInstanceId, seen);
  return null;
}

/**
 * The tickers of panes in other windows that panes on any of a window's tabs
 * follow, so a link survives a pane moving to another window and the window
 * switching tabs. A source with no ticker yet is listed too, as "": its
 * follower stays linked. A source on another tab of the same window is not
 * one: links stay within a tab there.
 */
function linkedTickersFor(state: WindowLayouts, windowId: string, shownLayout: LayoutConfig): Record<string, string> {
  const shownId = state.views[windowId]?.activeLayoutId;
  const tickers: Record<string, string> = {};
  for (const tab of windowTabs(state, windowId)) {
    const layout = layoutId(tab) === shownId ? shownLayout : tab.layout;
    const local = new Set(layout.instances.map((instance) => instance.instanceId));
    for (const instance of layout.instances) {
      if (instance.binding?.kind !== "follow") continue;
      const sourceId = instance.binding.sourceInstanceId;
      if (local.has(sourceId) || sourceId in tickers) continue;
      const located = locatePane(state, sourceId);
      if (!located || located.windowId === windowId) continue;
      tickers[sourceId] = paneTicker(state, sourceId, new Set()) ?? "";
    }
  }
  return tickers;
}

/**
 * The tabs the other windows hold, at their places among all the tabs, for
 * the main window's cloud sync: it pushes and pulls every window's tabs.
 */
export function otherWindowTabs(state: WindowLayouts): OtherWindowTab[] {
  if (state.windowIds.length <= 1) return [];
  return state.config.layouts.flatMap((tab, at) => (ownerOf(state, layoutId(tab)) === MAIN_WINDOW_ID ? [] : [{ at, tab }]));
}

/** The state a window is sent: its own tabs, its active tab as the layout, its own pane state and focus. */
export function projectWindow(state: WindowLayouts, windowId: string): DesktopSharedStateSnapshot | null {
  const view = state.views[windowId];
  if (!view) return null;
  const tabs = windowTabs(state, windowId);
  const activeIndex = Math.max(0, tabs.findIndex((entry) => entry.id === view.activeLayoutId));
  const active = tabs[activeIndex]!;
  const layout = windowId === MAIN_WINDOW_ID ? state.config.layout : active.layout;
  const linkedTickers = state.windowIds.length > 1 ? linkedTickersFor(state, windowId, layout) : {};
  return {
    config: {
      ...state.config,
      layouts: tabs,
      activeLayoutIndex: activeIndex,
      layout,
    },
    paneState: view.paneState,
    focusedPaneId: view.focusedPaneId,
    statusBarVisible: view.statusBarVisible,
    brokerSyncErrors: state.brokerSyncErrors,
    ...(Object.keys(linkedTickers).length > 0 ? { linkedTickers } : {}),
  };
}

/** A snapshot with its live layout, pane state and focus written into its active tab, as the config saves them. */
function normalize(snapshot: DesktopSharedStateSnapshot): DesktopSharedStateSnapshot {
  return {
    ...snapshot,
    config: syncConfigActiveLayoutState(snapshot.config, snapshot.paneState, snapshot.focusedPaneId),
  };
}

function activeTabId(snapshot: DesktopSharedStateSnapshot): string | undefined {
  return snapshot.config.layouts[snapshot.config.activeLayoutIndex]?.id;
}

/**
 * A window's own tabs in the order it sent them, in the places its tabs hold;
 * a tab given to it since it sent keeps its place after them.
 */
function inSentOrder(layouts: SavedLayout[], sentIds: readonly string[], owns: (id: string) => boolean): SavedLayout[] {
  const slots = layouts.flatMap((entry, at) => (owns(layoutId(entry)) ? [at] : []));
  const ownIds = new Set(slots.map((at) => layoutId(layouts[at]!)));
  const sent = new Set(sentIds);
  const order = [
    ...sentIds.filter((id) => ownIds.has(id)),
    ...slots.map((at) => layoutId(layouts[at]!)).filter((id) => !sent.has(id)),
  ];
  const byId = new Map(layouts.map((entry) => [layoutId(entry), entry] as const));
  const reordered = [...layouts];
  slots.forEach((slot, at) => {
    reordered[slot] = byId.get(order[at]!)!;
  });
  return reordered;
}

/**
 * Applies what `windowId` sent on top of the shared state, counting only what
 * changed since `base`, the state the window drew from. Settings and lists
 * take the window's value when it changed them. Tabs are matched by id: the
 * window's new tabs join it, its deleted tabs go, its edited tabs replace
 * theirs, and a new order of its own tabs is kept. A tab the window sends
 * that another window owns, which only a pulled or imported config does,
 * takes the content and stays where it is.
 *
 * With no base, everything the window sends counts as its change.
 */
export function mergeWindowSnapshot(
  state: WindowLayouts,
  windowId: string,
  base: DesktopSharedStateSnapshot | null,
  sent: DesktopSharedStateSnapshot,
): WindowLayouts {
  const view = state.views[windowId];
  if (!view) return state;
  const before = normalize(base ?? projectWindow(state, windowId)!);
  const after = normalize(sent);

  const config: AppConfig = { ...state.config };
  const configRecord = config as unknown as Record<string, unknown>;
  const afterRecord = after.config as unknown as Record<string, unknown>;
  const beforeRecord = before.config as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(afterRecord), ...Object.keys(beforeRecord)])) {
    if (LAYOUT_KEYS.has(key) || deepEqual(afterRecord[key], beforeRecord[key])) continue;
    if (afterRecord[key] === undefined) delete configRecord[key];
    else configRecord[key] = afterRecord[key];
  }

  const owners = { ...state.owners };
  const owns = (id: string) => ownerOf({ owners, views: state.views }, id) === windowId;
  const seen = new Set<string>();
  // A tab the window made has no id until it takes a state back; a sync sent
  // before then carries it without one again. It is the window's tab of that
  // name that it did not send by id, not one more tab.
  const sentIds = new Set(after.config.layouts.flatMap((entry) => (entry.id ? [entry.id] : [])));
  const unclaimed = state.config.layouts.filter((entry) => owns(layoutId(entry)) && !sentIds.has(layoutId(entry)));
  const sentTabs = after.config.layouts.map((entry) => {
    let id = entry.id && !seen.has(entry.id) ? entry.id : undefined;
    if (!id && !entry.id) {
      const claimed = unclaimed.findIndex((candidate) => candidate.name === entry.name && !seen.has(layoutId(candidate)));
      if (claimed >= 0) id = layoutId(unclaimed.splice(claimed, 1)[0]!);
    }
    id ??= createSavedLayoutId();
    seen.add(id);
    return entry.id === id ? entry : { ...entry, id };
  });
  const sentActiveId = sentTabs[after.config.activeLayoutIndex]?.id;
  const baseTabs = new Map(before.config.layouts.filter((entry) => entry.id).map((entry) => [entry.id!, entry] as const));

  let layouts = state.config.layouts.filter((entry) => {
    const id = layoutId(entry);
    if (baseTabs.has(id) && !seen.has(id) && owns(id)) {
      delete owners[id];
      return false;
    }
    return true;
  });
  for (const tab of sentTabs) {
    const id = layoutId(tab);
    const index = layouts.findIndex((entry) => entry.id === id);
    const previous = baseTabs.get(id);
    if (index >= 0) {
      if (!previous || !deepEqual(previous, tab)) layouts = layouts.map((entry, at) => (at === index ? tab : entry));
      continue;
    }
    // Sent before, and gone from the shared state since: another window deleted it.
    if (previous) continue;
    let insertAt = layouts.length;
    for (let at = layouts.length - 1; at >= 0; at -= 1) {
      if (owns(layoutId(layouts[at]!))) {
        insertAt = at + 1;
        break;
      }
    }
    layouts = [...layouts.slice(0, insertAt), tab, ...layouts.slice(insertAt)];
    if (windowId !== MAIN_WINDOW_ID) owners[id] = windowId;
  }

  layouts = inSentOrder(layouts, sentTabs.map(layoutId), owns);

  const activeChanged = sentActiveId !== undefined && sentActiveId !== activeTabId(before) && owns(sentActiveId);
  const activeLayoutId = activeChanged ? sentActiveId : view.activeLayoutId;
  // Pane state and focus belong to a tab: a window that sent them for a tab it
  // no longer shows (one just moved away) has them kept in that tab only.
  const sameTab = sentActiveId === activeLayoutId;
  const nextView: WindowView = {
    activeLayoutId,
    paneState: sameTab && (activeChanged || !deepEqual(after.paneState, before.paneState)) ? after.paneState : view.paneState,
    focusedPaneId: sameTab && (activeChanged || after.focusedPaneId !== before.focusedPaneId) ? after.focusedPaneId : view.focusedPaneId,
    statusBarVisible: after.statusBarVisible !== before.statusBarVisible ? after.statusBarVisible : view.statusBarVisible,
  };
  const brokerSyncErrors = deepEqual(after.brokerSyncErrors ?? {}, before.brokerSyncErrors ?? {})
    ? state.brokerSyncErrors
    : { ...after.brokerSyncErrors };

  return settle({
    ...state,
    config: { ...config, layouts },
    brokerSyncErrors,
    owners,
    views: { ...state.views, [windowId]: nextView },
  });
}

/**
 * Takes a whole config the backend changed (a broker profile, a popped-out
 * window's frame), keeping which window shows which tab. Its active layout
 * and pane state are the main window's.
 */
export function replaceSharedConfig(
  state: WindowLayouts,
  source: AppConfig,
  main: Pick<WindowView, "paneState" | "focusedPaneId"> & Partial<Pick<WindowView, "statusBarVisible">>,
): WindowLayouts {
  const config = ensureLayoutIds(syncConfigActiveLayoutState(source, main.paneState, main.focusedPaneId));
  const previous = state.views[MAIN_WINDOW_ID]!;
  const activeId = layoutId(config.layouts[config.activeLayoutIndex]!);
  return settle({
    ...state,
    config,
    // A tab the backend made active in the main window is the main window's.
    owners: Object.fromEntries(Object.entries(state.owners).filter(([id]) => id !== activeId)),
    views: {
      ...state.views,
      [MAIN_WINDOW_ID]: {
        activeLayoutId: activeId,
        paneState: main.paneState,
        focusedPaneId: main.focusedPaneId,
        statusBarVisible: main.statusBarVisible ?? previous.statusBarVisible,
      },
    },
  });
}

/** Why a tab cannot go to a window, or null when it can. */
export function layoutMoveBlock(state: WindowLayouts, id: string, targetWindowId: string): "missing" | "same-window" | "last-main-tab" | null {
  const source = windowOfLayout(state, id);
  if (!source || (!state.views[targetWindowId] && targetWindowId !== MAIN_WINDOW_ID)) return "missing";
  if (source === targetWindowId) return "same-window";
  if (source === MAIN_WINDOW_ID && windowTabs(state, MAIN_WINDOW_ID).length <= 1) return "last-main-tab";
  return null;
}

/** Popped-out panes have a window of their own only in the main window: elsewhere they dock. */
function dockDetachedPanes(layout: LayoutConfig): LayoutConfig {
  return layout.detached.reduce((next, entry) => dockPane(next, entry.instanceId), layout);
}

/**
 * Moves a tab to another window, where it becomes the active tab. A window
 * left without tabs closes; the main window keeps its last tab.
 */
export function moveLayoutToWindow(state: WindowLayouts, id: string, targetWindowId: string): WindowLayouts {
  if (layoutMoveBlock(state, id, targetWindowId)) return state;
  const target = state.views[targetWindowId]!;
  let tab = state.config.layouts.find((entry) => entry.id === id)!;
  if (targetWindowId !== MAIN_WINDOW_ID && tab.layout.detached.length > 0) {
    tab = { ...tab, layout: dockDetachedPanes(tab.layout) };
  }
  const owners = { ...state.owners };
  if (targetWindowId === MAIN_WINDOW_ID) delete owners[id];
  else owners[id] = targetWindowId;
  return settle({
    ...state,
    config: { ...state.config, layouts: state.config.layouts.map((entry) => (entry.id === id ? tab : entry)) },
    owners,
    views: { ...state.views, [targetWindowId]: viewFromTab(tab, target.statusBarVisible) },
  });
}

function uniqueTabName(layouts: readonly SavedLayout[], base: string): string {
  const names = new Set(layouts.map((entry) => entry.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  let suffix = 2;
  while (names.has(`${base} ${suffix}`.toLowerCase())) suffix += 1;
  return `${base} ${suffix}`;
}

/**
 * Opens a window. With a tab id it takes that tab; without one it starts on
 * a new empty tab of its own. Returns the state unchanged when the tab cannot
 * move (the main window's last tab).
 */
export function addWindow(state: WindowLayouts, windowId: string, options: { layoutId?: string } = {}): WindowLayouts {
  if (state.views[windowId] || windowId === MAIN_WINDOW_ID) return state;
  const statusBarVisible = state.views[MAIN_WINDOW_ID]!.statusBarVisible;
  if (options.layoutId) {
    if (layoutMoveBlock(state, options.layoutId, MAIN_WINDOW_ID) === "missing") return state;
    const source = windowOfLayout(state, options.layoutId);
    if (source === MAIN_WINDOW_ID && windowTabs(state, MAIN_WINDOW_ID).length <= 1) return state;
    const placeholder: WindowView = { activeLayoutId: options.layoutId, paneState: {}, focusedPaneId: null, statusBarVisible };
    return moveLayoutToWindow({
      ...state,
      windowIds: [...state.windowIds, windowId],
      views: { ...state.views, [windowId]: placeholder },
    }, options.layoutId, windowId);
  }
  const tab: SavedLayout = {
    id: createSavedLayoutId(),
    name: uniqueTabName(state.config.layouts, "Layout"),
    layout: createBlankLayout(),
    paneState: {},
    focusedPaneId: null,
  };
  return settle({
    ...state,
    config: { ...state.config, layouts: [...state.config.layouts, tab] },
    windowIds: [...state.windowIds, windowId],
    views: { ...state.views, [windowId]: viewFromTab(tab, statusBarVisible) },
    owners: { ...state.owners, [layoutId(tab)]: windowId },
  });
}

/** Closes an extra window. Its tabs go back to the main window, where they were in the tab order; nothing is lost. */
export function closeWindow(state: WindowLayouts, windowId: string): WindowLayouts {
  if (windowId === MAIN_WINDOW_ID || !state.views[windowId]) return state;
  const { [windowId]: _closed, ...views } = state.views;
  return settle({
    ...state,
    windowIds: state.windowIds.filter((id) => id !== windowId),
    views,
    owners: Object.fromEntries(Object.entries(state.owners).filter(([, owner]) => owner !== windowId)),
  });
}

/** Why a pane cannot go to a window, or null when it can. */
export function paneMoveBlock(state: WindowLayouts, paneId: string, targetWindowId: string): "missing" | "same-window" | null {
  const located = locatePane(state, paneId);
  if (!located || !state.views[targetWindowId]) return "missing";
  if (located.windowId === targetWindowId) return "same-window";
  return null;
}

/**
 * Moves a pane into the active tab of another window, focused there. It keeps
 * its id, settings, state and links: a pane that follows another keeps
 * following it from the other window. A docked pane docks on the right; a
 * floating one floats where it was.
 */
export function movePaneToWindow(state: WindowLayouts, paneId: string, targetWindowId: string): WindowLayouts {
  if (paneMoveBlock(state, paneId, targetWindowId)) return state;
  const located = locatePane(state, paneId)!;
  const sourceView = state.views[located.windowId]!;
  const targetView = state.views[targetWindowId]!;
  const sourceTab = state.config.layouts.find((entry) => entry.id === located.layoutId)!;
  const targetTab = state.config.layouts.find((entry) => entry.id === targetView.activeLayoutId)!;
  const instance = findPaneInstance(sourceTab.layout, paneId)!;
  const sourceIsLive = sourceView.activeLayoutId === located.layoutId;
  const livePaneState = sourceIsLive ? sourceView.paneState[paneId] : undefined;
  const paneState = livePaneState ?? sourceTab.paneState?.[paneId];
  const floating = sourceTab.layout.floating.find((entry) => entry.instanceId === paneId);

  const sourceLayout = removePane(sourceTab.layout, paneId);
  const { [paneId]: _moved, ...sourcePaneState } = sourceTab.paneState ?? {};
  const withInstance: LayoutConfig = {
    ...targetTab.layout,
    instances: [...targetTab.layout.instances.filter((entry) => entry.instanceId !== paneId), { ...instance, movedFrom: undefined }],
  };
  const targetLayout = floating
    ? floatAtRect(withInstance, paneId, { x: floating.x, y: floating.y, width: floating.width, height: floating.height })
    : insertAtRootEdge(withInstance, paneId, "right");
  const targetPaneState = { ...targetTab.paneState, ...(paneState ? { [paneId]: paneState } : {}) };

  const layouts = state.config.layouts.map((entry) => {
    if (entry.id === sourceTab.id) {
      return {
        ...entry,
        layout: sourceLayout,
        paneState: sourcePaneState,
        focusedPaneId: entry.focusedPaneId === paneId ? null : entry.focusedPaneId,
      };
    }
    if (entry.id === targetTab.id) return { ...entry, layout: targetLayout, paneState: targetPaneState, focusedPaneId: paneId };
    return entry;
  });
  const { [paneId]: _live, ...sourceLivePaneState } = sourceView.paneState;
  const views: Record<string, WindowView> = {
    ...state.views,
    [located.windowId]: sourceIsLive
      ? {
        ...sourceView,
        paneState: sourceLivePaneState,
        focusedPaneId: sourceView.focusedPaneId === paneId ? null : sourceView.focusedPaneId,
      }
      : sourceView,
    [targetWindowId]: {
      ...targetView,
      paneState: { ...targetView.paneState, ...(paneState ? { [paneId]: paneState } : {}) },
      focusedPaneId: paneId,
    },
  };
  return settle({ ...state, config: { ...state.config, layouts }, views });
}

/** Switches a window to one of its tabs, as clicking the tab there would. */
export function activateLayout(state: WindowLayouts, windowId: string, id: string): WindowLayouts {
  const view = state.views[windowId];
  if (!view || view.activeLayoutId === id || windowOfLayout(state, id) !== windowId) return state;
  const tab = state.config.layouts.find((entry) => entry.id === id)!;
  return settle({
    ...state,
    views: { ...state.views, [windowId]: viewFromTab(tab, view.statusBarVisible) },
  });
}
