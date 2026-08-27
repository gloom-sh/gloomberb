import { useCallback, type Dispatch } from "react";
import {
  addPaneFloating,
  addPaneToLayout,
  findDockLeaf,
} from "../../plugins/pane-manager";
import type { PluginRegistry } from "../../plugins/registry";
import {
  findTickerResearchFollower,
  listVisibleTickerSourcePanes,
} from "../../plugins/ticker-navigation";
import type {
  AppAction,
  AppState,
} from "../../state/app/context";
import {
  createPaneInstance,
  findPaneInstance,
  findPrimaryPaneInstance,
  isTickerPaneId,
  normalizePaneId,
  resolveFollowBindingInstance,
  resolvePaneInstance,
  TICKER_RESEARCH_PANE_ID,
  type LayoutConfig,
  type PaneBinding,
  type PaneInstanceConfig,
} from "../../types/config";
import {
  isCollectionPaneInstance,
  isTickerContextPaneInstance,
} from "./layout-placement";

interface UseAppTickerInspectorRuntimeOptions {
  activatePane: (paneId: string, layout?: LayoutConfig) => void;
  dispatch: Dispatch<AppAction>;
  notify: (body: string, options?: { type?: "info" | "success" | "error" }) => void;
  persistLayout: (layout: LayoutConfig, options?: { pushHistory?: boolean }) => void;
  pluginRegistry: PluginRegistry;
  state: AppState;
}

export function useAppTickerInspectorRuntime({
  activatePane,
  dispatch,
  notify,
  persistLayout,
  pluginRegistry,
  state,
}: UseAppTickerInspectorRuntimeOptions) {
  // Only for APIs that must land in a collection (selecting a symbol inside a list).
  const resolveCollectionSourcePaneId = useCallback((preferredPaneId?: string | null) => {
    return resolveFollowBindingInstance(state.config.layout, preferredPaneId, isCollectionPaneInstance)?.instanceId
      ?? resolveFollowBindingInstance(state.config.layout, state.focusedPaneId, isCollectionPaneInstance)?.instanceId
      ?? findPrimaryPaneInstance(state.config.layout, "portfolio-list")?.instanceId
      ?? null;
  }, [state.config.layout, state.focusedPaneId]);

  /** Any visible pane that publishes a cursor symbol can drive a follow binding. */
  const resolveTickerSourcePaneId = useCallback((preferredPaneId?: string | null) => {
    const isTickerSource = (instance: PaneInstanceConfig) => (
      pluginRegistry.panes.get(instance.paneId)?.tickerSource === true
    );
    return resolveFollowBindingInstance(state.config.layout, preferredPaneId, isTickerSource)?.instanceId
      ?? resolveFollowBindingInstance(state.config.layout, state.focusedPaneId, isTickerSource)?.instanceId
      ?? findPrimaryPaneInstance(state.config.layout, "portfolio-list")?.instanceId
      ?? listVisibleTickerSourcePanes(state.config.layout, pluginRegistry.panes)[0]?.instanceId
      ?? null;
  }, [pluginRegistry, state.config.layout, state.focusedPaneId]);

  const resolveTickerContextSourcePaneId = useCallback((preferredPaneId?: string | null) => {
    return resolveFollowBindingInstance(state.config.layout, preferredPaneId, isTickerContextPaneInstance)?.instanceId
      ?? resolveFollowBindingInstance(state.config.layout, state.focusedPaneId, isTickerContextPaneInstance)?.instanceId
      ?? findPrimaryPaneInstance(state.config.layout, TICKER_RESEARCH_PANE_ID)?.instanceId
      ?? findPrimaryPaneInstance(state.config.layout, "portfolio-list")?.instanceId
      ?? null;
  }, [state.config.layout, state.focusedPaneId]);

  const selectTickerInPane = useCallback((symbol: string, preferredPaneId?: string | null) => {
    const sourcePaneId = resolveCollectionSourcePaneId(preferredPaneId);
    if (!sourcePaneId) return;
    dispatch({ type: "UPDATE_PANE_STATE", paneId: sourcePaneId, patch: { cursorSymbol: symbol } });
  }, [dispatch, resolveCollectionSourcePaneId]);

  const resolveInspectorPane = useCallback((sourcePaneId: string): PaneInstanceConfig | null => {
    return findTickerResearchFollower(state.config.layout, sourcePaneId);
  }, [state.config.layout]);

  const ensureInspectorPane = useCallback((sourcePaneId: string) => {
    const existing = resolveInspectorPane(sourcePaneId);
    if (existing) return { layout: state.config.layout, instance: existing };

    const paneDef = pluginRegistry.panes.get(TICKER_RESEARCH_PANE_ID);
    if (!paneDef) return null;

    const preferredInstanceId = sourcePaneId === "portfolio-list:main"
      && !findPaneInstance(state.config.layout, "ticker-detail:main")
      ? "ticker-detail:main"
      : undefined;
    const instance = createPaneInstance(TICKER_RESEARCH_PANE_ID, {
      instanceId: preferredInstanceId,
      binding: { kind: "follow", sourceInstanceId: sourcePaneId },
    });
    const { width, height } = pluginRegistry.getTermSizeFn();
    const sourceDocked = findDockLeaf(state.config.layout, sourcePaneId);
    const layout = sourceDocked && paneDef.defaultMode !== "floating"
      ? addPaneToLayout(state.config.layout, instance, { relativeTo: sourcePaneId, position: "right" })
      : addPaneFloating(state.config.layout, instance, width, height, paneDef);
    return { layout, instance };
  }, [pluginRegistry, resolveInspectorPane, state.config.layout]);

  const switchTickerResearchTab = useCallback((tabId: string, preferredPaneId?: string | null) => {
    const targetPaneId = (() => {
      const target = preferredPaneId ? resolvePaneInstance(state.config.layout, preferredPaneId) : null;
      if (target?.paneId === TICKER_RESEARCH_PANE_ID) return target.instanceId;
      const focused = state.focusedPaneId ? resolvePaneInstance(state.config.layout, state.focusedPaneId) : null;
      if (focused?.paneId === TICKER_RESEARCH_PANE_ID) return focused.instanceId;
      const sourcePaneId = resolveTickerSourcePaneId(preferredPaneId);
      if (!sourcePaneId) return null;
      const ensured = ensureInspectorPane(sourcePaneId);
      if (!ensured) return null;
      if (ensured.layout !== state.config.layout) {
        persistLayout(ensured.layout);
      }
      return ensured.instance.instanceId;
    })();
    if (!targetPaneId) return;
    dispatch({ type: "UPDATE_PANE_STATE", paneId: targetPaneId, patch: { activeTabId: tabId } });
    dispatch({ type: "FOCUS_PANE", paneId: targetPaneId });
  }, [
    dispatch,
    ensureInspectorPane,
    persistLayout,
    resolveTickerSourcePaneId,
    state.config.layout,
    state.focusedPaneId,
  ]);

  const buildPaneBinding = useCallback((paneType: string, preferredPaneId?: string | null): PaneBinding | null => {
    if (normalizePaneId(paneType) === TICKER_RESEARCH_PANE_ID) {
      const sourceInstanceId = resolveTickerSourcePaneId(preferredPaneId);
      return sourceInstanceId ? { kind: "follow", sourceInstanceId } : null;
    }
    if (isTickerPaneId(paneType)) {
      const sourceInstanceId = resolveTickerContextSourcePaneId(preferredPaneId);
      return sourceInstanceId ? { kind: "follow", sourceInstanceId } : null;
    }
    return { kind: "none" };
  }, [resolveTickerContextSourcePaneId, resolveTickerSourcePaneId]);

  const showTickerResearchPane = useCallback(() => {
    const sourcePaneId = resolveTickerSourcePaneId();
    if (!sourcePaneId) {
      notify("Open a ticker source pane first to inspect a ticker.");
      return;
    }
    const ensured = ensureInspectorPane(sourcePaneId);
    if (!ensured) return;
    if (ensured.layout !== state.config.layout) {
      persistLayout(ensured.layout);
    }
    activatePane(ensured.instance.instanceId, ensured.layout);
  }, [
    activatePane,
    ensureInspectorPane,
    notify,
    persistLayout,
    resolveTickerSourcePaneId,
    state.config.layout,
  ]);

  return {
    buildPaneBinding,
    selectTickerInPane,
    showTickerResearchPane,
    switchTickerResearchTab,
  };
}
