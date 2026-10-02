import { getDockLeafLayouts, getDockedPaneIds } from "../../../layout/pane-manager";
import { pinFollowingPane } from "../../../layout/pane-follow";
import {
  cloneLayout,
  findPaneInstance,
  isFixedTickerPane,
  materializeDetachedPanesAsFloating,
  normalizePaneLayout,
  removePaneInstances,
  TICKER_RESEARCH_PANE_ID,
  type LayoutConfig,
} from "../../../types/config";
import type { AppConfig, PaneBinding, PaneInstanceConfig, SavedLayout } from "../../../types/config";
import type { DesktopSharedStateSnapshot } from "../../../types/desktop-window";
import type { BrokerAccount } from "../../../types/trading";
import { isBrokerPortfolioId } from "../../../utils/broker-instances";
import type { AppState, LayoutHistoryEntry, PaneRuntimeState } from "./types";

function getDefaultCollectionId(config: AppConfig): string {
  return config.portfolios[0]?.id || config.watchlists[0]?.id || "";
}

function isKnownCollection(config: AppConfig, collectionId: string | undefined): collectionId is string {
  if (!collectionId) return false;
  return config.portfolios.some((portfolio) => portfolio.id === collectionId)
    || config.watchlists.some((watchlist) => watchlist.id === collectionId);
}

function shouldPreserveUnknownCollectionId(collectionId: string | undefined): boolean {
  return isBrokerPortfolioId(collectionId);
}

function getConfiguredCollectionId(config: AppConfig, instance: PaneInstanceConfig): string {
  const candidates = [
    instance.params?.collectionId,
  ];

  for (const candidate of candidates) {
    if (isKnownCollection(config, candidate) || shouldPreserveUnknownCollectionId(candidate)) {
      return candidate!;
    }
  }

  return getDefaultCollectionId(config);
}

function defaultPaneStateForInstance(config: AppConfig, instance: PaneInstanceConfig): PaneRuntimeState {
  if (instance.paneId === "portfolio-list") {
    return {
      collectionId: getConfiguredCollectionId(config, instance),
      cursorSymbol: null,
    };
  }
  if (instance.paneId === TICKER_RESEARCH_PANE_ID) {
    return { activeTabId: "overview" };
  }
  return {};
}

function cloneRuntimeValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneRuntimeValue(entry)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, cloneRuntimeValue(entry)]),
    ) as T;
  }
  return value;
}

// The saved-layout mirror is rebuilt on every pane-state update, and pane
// state is replaced, never edited, when it changes: a patch spreads the
// top-level object and leaves untouched values (a cached article list, say)
// with their identity. Cloning each object once per identity, at every
// level, keeps the mirror a real copy while making the rebuild cost
// proportional to what changed rather than to every pane in every layout.
const runtimeValueClones = new WeakMap<object, unknown>();
/** Clone to the object it was copied from, so a saved copy can be traced to live state. */
const paneStateOrigins = new WeakMap<object, object>();

function cloneRuntimeValueShared<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  const cached = runtimeValueClones.get(value);
  if (cached !== undefined) return cached as T;
  const clone = Array.isArray(value)
    ? value.map((entry) => cloneRuntimeValueShared(entry))
    : Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, cloneRuntimeValueShared(entry)]),
    );
  runtimeValueClones.set(value, clone);
  return clone as T;
}

function clonePaneState(paneState: Record<string, unknown>): PaneRuntimeState {
  const cached = runtimeValueClones.get(paneState);
  if (cached !== undefined) return cached as PaneRuntimeState;
  const clone = cloneRuntimeValueShared(paneState) as PaneRuntimeState;
  paneStateOrigins.set(clone, paneState);
  return clone;
}

function descendsFrom(candidate: object, ancestor: object): boolean {
  let current: object | undefined = candidate;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (current === ancestor) return true;
    current = paneStateOrigins.get(current);
  }
  return false;
}

/**
 * The pane state a config carries for its active layout, ready to merge over
 * the live map. A saved entry that is a copy of the live entry (the usual case
 * when a caller spreads the current config to change one field) yields the
 * live object itself, so the merge does not hand every pane a new identity.
 */
export function restoreSavedPaneState(
  config: AppConfig,
  livePaneState: Record<string, PaneRuntimeState>,
): Record<string, PaneRuntimeState> | null {
  const saved = config.layouts[config.activeLayoutIndex]?.paneState;
  if (!saved) return null;
  return Object.fromEntries(Object.entries(saved).map(([paneId, entry]) => {
    const live = livePaneState[paneId];
    return [paneId, live && descendsFrom(entry, live) ? live : clonePaneState(entry)];
  }));
}

export function clonePaneStateMap(previous: Record<string, Record<string, unknown>>): Record<string, PaneRuntimeState> {
  return Object.fromEntries(
    Object.entries(previous).map(([paneId, paneState]) => [paneId, clonePaneState(paneState)]),
  );
}

function shallowEqualRecords(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => Object.is(left[key], right[key]));
}

// Reconciling runs on every pane-state update for every pane in the layout.
// A pane whose state object and defaults are unchanged gets the object it
// got last time, so the clone behind it is paid once per state change.
const reconciledPaneStates = new WeakMap<object, { defaults: PaneRuntimeState; result: PaneRuntimeState }>();
const EMPTY_PANE_STATE: PaneRuntimeState = {};

function reconcilePaneStateEntry(
  config: AppConfig,
  instance: LayoutConfig["instances"][number],
  source: PaneRuntimeState,
): PaneRuntimeState {
  const defaults = defaultPaneStateForInstance(config, instance);
  const cached = reconciledPaneStates.get(source);
  const collectionId = (source.collectionId ?? defaults.collectionId) as string | undefined;
  const resolvedCollectionId = instance.paneId === "portfolio-list"
    && !isKnownCollection(config, collectionId)
    && !shouldPreserveUnknownCollectionId(collectionId)
    ? defaults.collectionId
    : collectionId;
  if (
    cached
    && shallowEqualRecords(cached.defaults, defaults)
    && Object.is(cached.result.collectionId, resolvedCollectionId)
  ) {
    return cached.result;
  }
  // Nothing to add or fix: the live object is already the reconciled state.
  // Handing it back keeps its identity, and with it every memo keyed on it.
  const unchanged = Object.keys(defaults).every((key) => Object.prototype.hasOwnProperty.call(source, key))
    && (instance.paneId !== "portfolio-list" || Object.is(source.collectionId, resolvedCollectionId));
  if (unchanged) return source;
  const result: PaneRuntimeState = { ...defaults, ...cloneRuntimeValue(source) };
  if (instance.paneId === "portfolio-list") result.collectionId = resolvedCollectionId;
  // Panes without state share one empty source; caching it would thrash
  // between their different defaults for no saving.
  if (source !== EMPTY_PANE_STATE) reconciledPaneStates.set(source, { defaults, result });
  return result;
}

export function reconcilePaneState(
  config: AppConfig,
  previous: Record<string, PaneRuntimeState>,
  layout: LayoutConfig = config.layout,
): Record<string, PaneRuntimeState> {
  const next: Record<string, PaneRuntimeState> = {};
  for (const instance of layout.instances) {
    next[instance.instanceId] = reconcilePaneStateEntry(config, instance, previous[instance.instanceId] ?? EMPTY_PANE_STATE);
  }
  return next;
}

function reconcileBrokerAccounts(
  config: AppConfig,
  brokerAccounts: Record<string, BrokerAccount[]>,
): Record<string, BrokerAccount[]> {
  const validInstanceIds = new Set(config.brokerInstances.map((instance) => instance.id));
  return Object.fromEntries(
    Object.entries(brokerAccounts).filter(([instanceId]) => validInstanceIds.has(instanceId)),
  );
}

function resolveTickerFromBinding(
  state: Pick<AppState, "config" | "paneState">,
  binding: PaneBinding | undefined,
  seen: Set<string>,
): string | null {
  if (!binding || binding.kind === "none") return null;
  if (binding.kind === "fixed") return binding.symbol;
  return resolveTickerForPane(state as AppState, binding.sourceInstanceId, seen);
}

function getPaneState(state: Pick<AppState, "paneState">, paneId: string): PaneRuntimeState {
  return state.paneState[paneId] ?? {};
}

/**
 * Any pane that publishes `cursorSymbol` in its pane state is a ticker source; every other pane
 * resolves through its binding, so follow chains keep working across source types.
 */
export function resolveTickerForPane(state: AppState, paneId: string, seen = new Set<string>()): string | null {
  if (seen.has(paneId)) return null;
  seen.add(paneId);
  const instance = findPaneInstance(state.config.layout, paneId);
  if (!instance) return null;
  const cursorSymbol = getPaneState(state, paneId).cursorSymbol;
  if (typeof cursorSymbol === "string" && cursorSymbol.trim()) return cursorSymbol;
  return resolveTickerFromBinding(state, instance.binding, seen);
}

export function resolveCollectionForPane(state: AppState, paneId: string, seen = new Set<string>()): string | null {
  if (seen.has(paneId)) return null;
  seen.add(paneId);
  const instance = findPaneInstance(state.config.layout, paneId);
  if (!instance) return null;
  if (instance.paneId === "portfolio-list") {
    const paneState = getPaneState(state, paneId);
    const collectionId = typeof paneState.collectionId === "string"
      ? paneState.collectionId
      : getConfiguredCollectionId(state.config, instance);
    if (isKnownCollection(state.config, collectionId) || shouldPreserveUnknownCollectionId(collectionId)) {
      return collectionId ?? null;
    }
    return getConfiguredCollectionId(state.config, instance);
  }
  if (instance.binding?.kind === "follow") {
    return resolveCollectionForPane(state, instance.binding.sourceInstanceId, seen);
  }
  return null;
}

export function getFocusedTickerSymbol(state: AppState): string | null {
  return state.focusedPaneId ? resolveTickerForPane(state, state.focusedPaneId) : null;
}

export function getFocusedCollectionId(state: AppState): string | null {
  return state.focusedPaneId ? resolveCollectionForPane(state, state.focusedPaneId) : null;
}

export function getEffectiveThemeId(state: Pick<AppState, "config" | "themePreview">): string {
  return state.themePreview ?? state.config.theme;
}

export function clearTickerBindings(layout: LayoutConfig, symbol: string): LayoutConfig {
  return normalizePaneLayout(removePaneInstances(
    layout,
    layout.instances
      .filter((instance) => instance.binding?.kind === "fixed" && isFixedTickerPane(instance) && instance.binding.symbol === symbol)
      .map((instance) => instance.instanceId),
  ));
}

export function nextRecentTickers(current: string[], symbol: string | null): string[] {
  if (!symbol) return current;
  if (current[0] === symbol && !current.slice(1).includes(symbol)) {
    return current;
  }
  const next = [symbol, ...current.filter((entry) => entry !== symbol)].slice(0, 50);
  if (next.length === current.length && next.every((entry, index) => entry === current[index])) {
    return current;
  }
  return next;
}

const savedLayoutClones = new WeakMap<SavedLayout, SavedLayout>();
const layoutClones = new WeakMap<LayoutConfig, LayoutConfig>();

function cloneLayoutOnce(layout: LayoutConfig): LayoutConfig {
  const cached = layoutClones.get(layout);
  if (cached) return cached;
  const clone = cloneLayout(layout);
  layoutClones.set(layout, clone);
  return clone;
}

export function cloneSavedLayout(entry: SavedLayout): SavedLayout {
  const cached = savedLayoutClones.get(entry);
  if (cached) return cached;
  const clone = {
    ...entry,
    layout: cloneLayoutOnce(entry.layout),
    paneState: entry.paneState ? clonePaneStateMap(entry.paneState) : entry.paneState,
  };
  savedLayoutClones.set(entry, clone);
  return clone;
}

function buildSavedLayoutSnapshot(
  entry: SavedLayout | undefined,
  layout: LayoutConfig,
  paneState: Record<string, PaneRuntimeState>,
  focusedPaneId: string | null,
): SavedLayout {
  return {
    ...(entry ?? { name: "Default" }),
    layout: cloneLayoutOnce(layout),
    paneState: clonePaneStateMap(paneState),
    focusedPaneId,
  };
}

const SAVED_LAYOUT_MIRROR_KEYS = new Set<keyof SavedLayout>(["paneState", "focusedPaneId"]);

/**
 * True when two saved-layout lists differ only in what the active layout
 * mirrors from live state (pane state, focus). Structural edits, renames, or
 * reordering make this false.
 */
export function savedLayoutsDifferOnlyInMirror(
  previous: readonly SavedLayout[],
  next: readonly SavedLayout[],
): boolean {
  if (previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index += 1) {
    const before = previous[index]!;
    const after = next[index]!;
    if (before === after) continue;
    const beforeKeys = Object.keys(before) as Array<keyof SavedLayout>;
    if (beforeKeys.length !== Object.keys(after).length) return false;
    for (const key of beforeKeys) {
      if (SAVED_LAYOUT_MIRROR_KEYS.has(key)) continue;
      if (!Object.is(before[key], after[key])) return false;
    }
  }
  return true;
}

export function syncConfigActiveLayoutState(
  config: AppConfig,
  paneState: Record<string, PaneRuntimeState>,
  focusedPaneId: string | null,
): AppConfig {
  const activeLayoutIndex = config.activeLayoutIndex >= 0 && config.activeLayoutIndex < config.layouts.length
    ? config.activeLayoutIndex
    : 0;
  const layouts = config.layouts.length > 0
    ? config.layouts.map((savedLayout, index) => (
      index === activeLayoutIndex
        ? buildSavedLayoutSnapshot(savedLayout, config.layout, reconcilePaneState(config, paneState), focusedPaneId)
        : cloneSavedLayout(savedLayout)
    ))
    : [buildSavedLayoutSnapshot(undefined, config.layout, reconcilePaneState(config, paneState), focusedPaneId)];
  return {
    ...config,
    layouts,
    activeLayoutIndex,
  };
}

const PANEL_RESOLUTION_BOUNDS = { x: 0, y: 0, width: 120, height: 40 };

export function getPaneOrder(layout: LayoutConfig): string[] {
  return [
    ...getDockedPaneIds(layout),
    ...layout.floating.map((entry) => entry.instanceId),
  ];
}

export function getTopFloatingPaneId(layout: LayoutConfig): string | null {
  let topInstanceId: string | null = null;
  let topZIndex = Number.NEGATIVE_INFINITY;
  let topOrder = -1;

  layout.floating.forEach((entry, index) => {
    const zIndex = entry.zIndex ?? 50;
    if (zIndex > topZIndex || (zIndex === topZIndex && index > topOrder)) {
      topInstanceId = entry.instanceId;
      topZIndex = zIndex;
      topOrder = index;
    }
  });

  return topInstanceId;
}

function resolveFocusedPaneId(nextLayout: LayoutConfig, focusedPaneId: string | null): string | null {
  const paneOrder = getPaneOrder(nextLayout);
  if (paneOrder.length === 0) return null;
  if (focusedPaneId && paneOrder.includes(focusedPaneId)) {
    return focusedPaneId;
  }
  return getTopFloatingPaneId(nextLayout) ?? paneOrder[0] ?? null;
}

export function getPanelFocusTarget(layout: LayoutConfig, panel: "left" | "right"): string | null {
  const leaves = getDockLeafLayouts(layout, PANEL_RESOLUTION_BOUNDS);
  if (leaves.length === 0) return layout.floating[0]?.instanceId ?? null;
  const sorted = [...leaves].sort((a, b) => (
    panel === "left"
      ? a.rect.x - b.rect.x || a.rect.y - b.rect.y
      : (b.rect.x + b.rect.width) - (a.rect.x + a.rect.width) || a.rect.y - b.rect.y
  ));
  return sorted[0]?.instanceId ?? null;
}

function cloneHistoryEntry(entry: LayoutHistoryEntry | undefined): LayoutHistoryEntry {
  return {
    past: entry?.past.map((layout) => cloneLayout(layout)) ?? [],
    future: entry?.future.map((layout) => cloneLayout(layout)) ?? [],
  };
}

export function historyForIndex(layoutHistory: Record<number, LayoutHistoryEntry>, index: number): LayoutHistoryEntry {
  return cloneHistoryEntry(layoutHistory[index]);
}

export function setHistoryForIndex(
  layoutHistory: Record<number, LayoutHistoryEntry>,
  index: number,
  entry: LayoutHistoryEntry,
): Record<number, LayoutHistoryEntry> {
  return {
    ...layoutHistory,
    [index]: {
      past: entry.past.map((layout) => cloneLayout(layout)),
      future: entry.future.map((layout) => cloneLayout(layout)),
    },
  };
}

export function removeHistoryIndex(layoutHistory: Record<number, LayoutHistoryEntry>, removedIndex: number): Record<number, LayoutHistoryEntry> {
  const next: Record<number, LayoutHistoryEntry> = {};
  for (const [rawIndex, entry] of Object.entries(layoutHistory)) {
    const index = Number.parseInt(rawIndex, 10);
    if (Number.isNaN(index) || index === removedIndex) continue;
    next[index > removedIndex ? index - 1 : index] = cloneHistoryEntry(entry);
  }
  return next;
}

export function movedIndex(index: number, fromIndex: number, toIndex: number): number {
  if (index === fromIndex) return toIndex;
  if (fromIndex < toIndex && index > fromIndex && index <= toIndex) return index - 1;
  if (fromIndex > toIndex && index >= toIndex && index < fromIndex) return index + 1;
  return index;
}

export function moveHistoryIndex(
  layoutHistory: Record<number, LayoutHistoryEntry>,
  fromIndex: number,
  toIndex: number,
): Record<number, LayoutHistoryEntry> {
  const next: Record<number, LayoutHistoryEntry> = {};
  for (const [rawIndex, entry] of Object.entries(layoutHistory)) {
    const index = Number.parseInt(rawIndex, 10);
    if (Number.isNaN(index)) continue;
    next[movedIndex(index, fromIndex, toIndex)] = cloneHistoryEntry(entry);
  }
  return next;
}

/** If paneId is a floating pane, bump its zIndex to the top. */
export function bringFloatingToFront(layout: LayoutConfig, paneId: string): LayoutConfig {
  const entryIndex = layout.floating.findIndex((e) => e.instanceId === paneId);
  const entry = entryIndex >= 0 ? layout.floating[entryIndex] : undefined;
  if (!entry) return layout;
  const maxZ = layout.floating.reduce((max, e) => Math.max(max, e.zIndex ?? 50), 0);
  const topEqualIndex = layout.floating.findLastIndex((e) => (e.zIndex ?? 50) === maxZ);
  if ((entry.zIndex ?? 50) === maxZ && entryIndex === topEqualIndex) return layout; // already on top
  return {
    ...layout,
    floating: layout.floating.map((e) =>
      e.instanceId === paneId ? { ...e, zIndex: maxZ + 1 } : e,
    ),
  };
}

/** Without desktop windows to hold them, detached panes float in the active and every saved layout. */
export function materializeDetachedLayouts(config: AppConfig): AppConfig {
  return {
    ...config,
    layout: materializeDetachedPanesAsFloating(config.layout),
    layouts: config.layouts.map((entry) => ({
      ...entry,
      layout: materializeDetachedPanesAsFloating(entry.layout),
    })),
  };
}

export function focusPaneState(state: AppState, paneId: string): AppState {
  const layout = bringFloatingToFront(state.config.layout, paneId);
  const config = layout !== state.config.layout ? { ...state.config, layout } : state.config;
  const recentTickers = nextRecentTickers(
    state.recentTickers,
    resolveTickerForPane(state, paneId),
  );
  if (
    config === state.config &&
    state.focusedPaneId === paneId &&
    recentTickers === state.recentTickers
  ) {
    return state;
  }
  return {
    ...state,
    config: syncConfigActiveLayoutState(config, state.paneState, paneId),
    focusedPaneId: paneId,
    previousFocusedPaneId: state.focusedPaneId && state.focusedPaneId !== paneId
      ? state.focusedPaneId
      : state.previousFocusedPaneId,
    recentTickers,
  };
}

export function withFocusedPane(
  state: AppState,
  config: AppConfig,
  options: {
    paneState?: Record<string, PaneRuntimeState>;
    focusedPaneId?: string | null;
  } = {},
): AppState {
  const normalizedLayout = normalizePaneLayout(config.layout, {
    // Keep a follower alive on its last symbol when its source pane is gone.
    resolveOrphanSymbol: (instanceId) => resolveTickerForPane(state, instanceId),
    pinOrphan: pinFollowingPane,
  });
  const nextConfig = normalizedLayout === config.layout
    ? config
    : {
      ...config,
      layout: normalizedLayout,
  };
  const nextPaneState = reconcilePaneState(nextConfig, options.paneState ?? state.paneState);
  const requestedFocusedPaneId = Object.prototype.hasOwnProperty.call(options, "focusedPaneId")
    ? (options.focusedPaneId ?? null)
    : state.focusedPaneId;
  const focusedPaneId = resolveFocusedPaneId(nextConfig.layout, requestedFocusedPaneId);
  const focusedLayout = focusedPaneId ? bringFloatingToFront(nextConfig.layout, focusedPaneId) : nextConfig.layout;
  const focusedConfig = focusedLayout === nextConfig.layout ? nextConfig : { ...nextConfig, layout: focusedLayout };
  const syncedConfig = syncConfigActiveLayoutState(focusedConfig, nextPaneState, focusedPaneId);
  return {
    ...state,
    config: syncedConfig,
    paneState: nextPaneState,
    brokerAccounts: reconcileBrokerAccounts(syncedConfig, state.brokerAccounts),
    focusedPaneId,
    previousFocusedPaneId: state.focusedPaneId && state.focusedPaneId !== focusedPaneId
      ? state.focusedPaneId
      : state.previousFocusedPaneId,
  };
}

export function hydrateDesktopSnapshot(state: AppState, snapshot: DesktopSharedStateSnapshot): AppState {
  return withFocusedPane({
    ...state,
    paneState: snapshot.paneState,
    focusedPaneId: snapshot.focusedPaneId,
    statusBarVisible: snapshot.statusBarVisible,
  }, snapshot.config);
}
