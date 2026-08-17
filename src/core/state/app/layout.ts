import { getDockLeafLayouts, getDockedPaneIds } from "../../../plugins/pane-manager";
import {
  cloneLayout,
  findPaneInstance,
  isFixedTickerPane,
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

export function clonePaneStateMap(previous: Record<string, Record<string, unknown>>): Record<string, PaneRuntimeState> {
  return Object.fromEntries(
    Object.entries(previous).map(([paneId, paneState]) => [paneId, cloneRuntimeValue(paneState) as PaneRuntimeState]),
  );
}

export function reconcilePaneState(
  config: AppConfig,
  previous: Record<string, PaneRuntimeState>,
  layout: LayoutConfig = config.layout,
): Record<string, PaneRuntimeState> {
  const next: Record<string, PaneRuntimeState> = {};
  for (const instance of layout.instances) {
    const defaults = defaultPaneStateForInstance(config, instance);
    const paneState = { ...defaults, ...cloneRuntimeValue(previous[instance.instanceId] ?? {}) };
    if (
      instance.paneId === "portfolio-list"
      && !isKnownCollection(config, paneState.collectionId as string | undefined)
      && !shouldPreserveUnknownCollectionId(paneState.collectionId as string | undefined)
    ) {
      paneState.collectionId = defaults.collectionId;
    }
    next[instance.instanceId] = paneState;
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

export function resolveTickerForPane(state: AppState, paneId: string, seen = new Set<string>()): string | null {
  if (seen.has(paneId)) return null;
  seen.add(paneId);
  const instance = findPaneInstance(state.config.layout, paneId);
  if (!instance) return null;
  if (instance.paneId === "portfolio-list") {
    const paneState = getPaneState(state, paneId);
    return typeof paneState.cursorSymbol === "string" ? paneState.cursorSymbol : null;
  }
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

export function cloneSavedLayout(entry: SavedLayout): SavedLayout {
  return {
    ...entry,
    layout: cloneLayout(entry.layout),
    paneState: entry.paneState ? clonePaneStateMap(entry.paneState) : entry.paneState,
  };
}

function buildSavedLayoutSnapshot(
  entry: SavedLayout | undefined,
  layout: LayoutConfig,
  paneState: Record<string, PaneRuntimeState>,
  focusedPaneId: string | null,
  activePanel: "left" | "right",
): SavedLayout {
  return {
    ...(entry ?? { name: "Default" }),
    layout: cloneLayout(layout),
    paneState: clonePaneStateMap(paneState),
    focusedPaneId,
    activePanel,
  };
}

export function syncConfigActiveLayoutState(
  config: AppConfig,
  paneState: Record<string, PaneRuntimeState>,
  focusedPaneId: string | null,
  activePanel: "left" | "right",
): AppConfig {
  const activeLayoutIndex = config.activeLayoutIndex >= 0 && config.activeLayoutIndex < config.layouts.length
    ? config.activeLayoutIndex
    : 0;
  const layouts = config.layouts.length > 0
    ? config.layouts.map((savedLayout, index) => (
      index === activeLayoutIndex
        ? buildSavedLayoutSnapshot(savedLayout, config.layout, reconcilePaneState(config, paneState), focusedPaneId, activePanel)
        : cloneSavedLayout(savedLayout)
    ))
    : [buildSavedLayoutSnapshot(undefined, config.layout, reconcilePaneState(config, paneState), focusedPaneId, activePanel)];
  return {
    ...config,
    layouts,
    activeLayoutIndex,
  };
}

export function getActiveSavedPaneState(config: AppConfig): Record<string, PaneRuntimeState> | null {
  const paneState = config.layouts[config.activeLayoutIndex]?.paneState;
  return paneState ? clonePaneStateMap(paneState) : null;
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
    config: syncConfigActiveLayoutState(config, state.paneState, paneId, state.activePanel),
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
    activePanel?: "left" | "right";
  } = {},
): AppState {
  const normalizedLayout = normalizePaneLayout(config.layout);
  const nextConfig = normalizedLayout === config.layout
    ? config
    : {
      ...config,
      layout: normalizedLayout,
  };
  const activePanel = options.activePanel ?? state.activePanel;
  const nextPaneState = reconcilePaneState(nextConfig, options.paneState ?? state.paneState);
  const requestedFocusedPaneId = Object.prototype.hasOwnProperty.call(options, "focusedPaneId")
    ? (options.focusedPaneId ?? null)
    : state.focusedPaneId;
  const focusedPaneId = resolveFocusedPaneId(nextConfig.layout, requestedFocusedPaneId);
  const focusedLayout = focusedPaneId ? bringFloatingToFront(nextConfig.layout, focusedPaneId) : nextConfig.layout;
  const focusedConfig = focusedLayout === nextConfig.layout ? nextConfig : { ...nextConfig, layout: focusedLayout };
  const syncedConfig = syncConfigActiveLayoutState(focusedConfig, nextPaneState, focusedPaneId, activePanel);
  return {
    ...state,
    config: syncedConfig,
    paneState: nextPaneState,
    brokerAccounts: reconcileBrokerAccounts(syncedConfig, state.brokerAccounts),
    focusedPaneId,
    previousFocusedPaneId: state.focusedPaneId && state.focusedPaneId !== focusedPaneId
      ? state.focusedPaneId
      : state.previousFocusedPaneId,
    activePanel,
  };
}

export function hydrateDesktopSnapshot(state: AppState, snapshot: DesktopSharedStateSnapshot): AppState {
  const baseState = withFocusedPane({
    ...state,
    paneState: snapshot.paneState,
    focusedPaneId: snapshot.focusedPaneId,
    activePanel: snapshot.activePanel,
    statusBarVisible: snapshot.statusBarVisible,
  }, snapshot.config);
  return {
    ...baseState,
    activePanel: snapshot.activePanel,
    statusBarVisible: snapshot.statusBarVisible,
  };
}
