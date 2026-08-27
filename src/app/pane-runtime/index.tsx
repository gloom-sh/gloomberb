import { useCallback, type Dispatch } from "react";
import type { AppTickerRepositoryPort } from "../../core/app-service-ports";
import {
  addPaneFloating,
  addPaneToLayout,
  bringToFront,
  findDockLeaf,
  getDockedPaneIds,
  isPaneInLayout,
} from "../../plugins/pane-manager";
import type { PluginRegistry } from "../../plugins/registry";
import {
  getFocusedCollectionId,
  resolveTickerForPane,
  syncConfigActiveLayoutState,
  type AppAction,
  type AppState,
} from "../../state/app/context";
import { scheduleConfigSave } from "../../state/config-save-scheduler";
import {
  createPaneInstance,
  findPaneInstance,
  isTickerPaneId,
  normalizePaneId,
  normalizePaneLayout,
  TICKER_RESEARCH_PANE_ID,
  type LayoutConfig,
  type PaneBinding,
  type PaneInstanceConfig,
} from "../../types/config";
import type { DataProvider } from "../../types/data-provider";
import type {
  PaneDef,
  PaneTemplateInstanceConfig,
} from "../../types/plugin";
import type { DialogApi } from "../../ui/dialog";
import {
  resolvePanelForPane,
  resolvePaneTarget as resolvePaneTargetInLayout,
  selectEdgeAnchor,
} from "./layout-placement";
import { useAppPaneSettingsRuntime } from "./pane-settings-runtime";
import { useAppPaneTemplateRuntime } from "./pane-template-runtime";
import { bindAppPanePluginRegistry } from "./plugin-bindings";
import { useAppTickerInspectorRuntime } from "./ticker-inspector-runtime";
import { useAppTickerOpenRuntime } from "./ticker-open-runtime";

interface AppPaneRuntimeArgs {
  dataProvider: DataProvider;
  detachedPaneId: string | null;
  dialog: DialogApi;
  dispatch: Dispatch<AppAction>;
  isDetachedWindow: boolean;
  notify: (body: string, options?: { type?: "info" | "success" | "error" }) => void;
  pluginRegistry: PluginRegistry;
  state: AppState;
  stateRef: { current: AppState };
  tickerRepository: AppTickerRepositoryPort;
}

export function useAppPaneRuntime({
  dataProvider,
  detachedPaneId,
  dialog,
  dispatch,
  isDetachedWindow,
  notify,
  pluginRegistry,
  state,
  stateRef,
  tickerRepository,
}: AppPaneRuntimeArgs) {
  const resolvePaneTarget = useCallback((paneId: string, layout: LayoutConfig = state.config.layout): string | null => {
    return resolvePaneTargetInLayout(layout, paneId);
  }, [state.config.layout]);

  const persistLayout = useCallback((layout: LayoutConfig, options?: { pushHistory?: boolean; focusedPaneId?: string | null }) => {
    const currentState = stateRef.current;
    const normalizedLayout = normalizePaneLayout(layout, {
      resolveOrphanSymbol: (instanceId) => resolveTickerForPane(currentState, instanceId),
    });
    if (options?.pushHistory !== false) {
      dispatch({ type: "PUSH_LAYOUT_HISTORY" });
    }
    const hasFocusTarget = !!options && Object.prototype.hasOwnProperty.call(options, "focusedPaneId");
    dispatch(hasFocusTarget
      ? { type: "UPDATE_LAYOUT", layout: normalizedLayout, focusedPaneId: options.focusedPaneId ?? null }
      : { type: "UPDATE_LAYOUT", layout: normalizedLayout });
    scheduleConfigSave(syncConfigActiveLayoutState(
      { ...currentState.config, layout: normalizedLayout },
      currentState.paneState,
      hasFocusTarget ? (options.focusedPaneId ?? null) : currentState.focusedPaneId,
      currentState.activePanel,
    ));
  }, [dispatch, stateRef]);

  const activatePane = useCallback((paneId: string, layout: LayoutConfig = state.config.layout) => {
    dispatch({
      type: "SET_ACTIVE_PANEL",
      panel: resolvePanelForPane({ layout, paneId, pluginRegistry }),
      preserveFocus: true,
    });
    dispatch({ type: "FOCUS_PANE", paneId });
  }, [dispatch, pluginRegistry, state.config.layout]);

  const {
    buildPaneBinding,
    selectTickerInPane,
    showTickerResearchPane,
    switchTickerResearchTab,
  } = useAppTickerInspectorRuntime({
    activatePane,
    dispatch,
    notify,
    persistLayout,
    pluginRegistry,
    state,
  });

  const buildPaneInstance = useCallback((paneType: string, options?: {
    title?: string;
    binding?: PaneBinding;
    params?: Record<string, string>;
    settings?: Record<string, unknown>;
    instanceId?: string;
  }): PaneInstanceConfig | null => {
    const normalizedPaneType = normalizePaneId(paneType);
    if (normalizedPaneType === "portfolio-list") {
      const collectionId = options?.params?.collectionId
        ?? getFocusedCollectionId(state)
        ?? state.config.portfolios[0]?.id
        ?? state.config.watchlists[0]?.id
        ?? "";
      return createPaneInstance(normalizedPaneType, {
        instanceId: options?.instanceId,
        title: options?.title,
        binding: options?.binding ?? { kind: "none" },
        params: { collectionId },
        settings: options?.settings,
      });
    }
    const binding = options?.binding ?? buildPaneBinding(normalizedPaneType);
    if (isTickerPaneId(normalizedPaneType) && !binding) return null;
    return createPaneInstance(normalizedPaneType, {
      instanceId: options?.instanceId,
      title: options?.title,
      binding: binding ?? { kind: "none" },
      params: options?.params,
      settings: options?.settings,
    });
  }, [buildPaneBinding, state]);

  const focusVisiblePane = useCallback((paneId: string, layout: LayoutConfig = state.config.layout) => {
    const nextLayout = layout.floating.some((entry) => entry.instanceId === paneId)
      ? bringToFront(layout, paneId)
      : layout;

    if (nextLayout !== state.config.layout) {
      persistLayout(nextLayout, { pushHistory: false });
    }
    activatePane(paneId, nextLayout);
  }, [activatePane, persistLayout, state.config.layout]);

  const placePaneInstance = useCallback((
    instance: PaneInstanceConfig,
    paneDef: PaneDef,
    options?: PaneTemplateInstanceConfig,
  ) => {
    const { width, height } = pluginRegistry.getTermSizeFn();
    const relativeTo = options?.relativeToPaneId
      ? resolvePaneTarget(options.relativeToPaneId)
      : (state.focusedPaneId && isPaneInLayout(state.config.layout, state.focusedPaneId) ? state.focusedPaneId : null);
    const relativePosition = options?.relativePosition ?? "right";
    let nextLayout = state.config.layout;
    const dockedPaneIds = getDockedPaneIds(nextLayout);

    if (options?.placement === "floating" || (options?.placement !== "docked" && paneDef.defaultMode === "floating")) {
      nextLayout = addPaneFloating(nextLayout, instance, width, height, paneDef);
    } else if (relativeTo && findDockLeaf(nextLayout, relativeTo)) {
      nextLayout = addPaneToLayout(nextLayout, instance, { relativeTo, position: relativePosition });
    } else if (dockedPaneIds.length === 0) {
      nextLayout = addPaneToLayout(nextLayout, instance, { relativeTo: instance.instanceId, position: "right" });
    } else if (paneDef.defaultPosition === "left") {
      const leftAnchor = selectEdgeAnchor(nextLayout, "left");
      nextLayout = leftAnchor
        ? addPaneToLayout(nextLayout, instance, { relativeTo: leftAnchor, position: "below" })
        : addPaneToLayout(nextLayout, instance, { relativeTo: dockedPaneIds[0]!, position: "left" });
    } else {
      const rightAnchor = selectEdgeAnchor(nextLayout, "right");
      nextLayout = rightAnchor
        ? addPaneToLayout(nextLayout, instance, { relativeTo: rightAnchor, position: "below" })
        : addPaneToLayout(nextLayout, instance, { relativeTo: dockedPaneIds[dockedPaneIds.length - 1]!, position: "right" });
    }

    persistLayout(nextLayout);
    activatePane(instance.instanceId, nextLayout);
  }, [
    activatePane,
    persistLayout,
    pluginRegistry,
    resolvePaneTarget,
    state.config.layout,
    state.focusedPaneId,
  ]);

  const showPane = useCallback((paneId: string) => {
    const normalizedPaneId = normalizePaneId(paneId);
    const paneDef = pluginRegistry.panes.get(normalizedPaneId);
    if (!paneDef) return;

    if (normalizedPaneId === TICKER_RESEARCH_PANE_ID) {
      showTickerResearchPane();
      return;
    }

    const existingInstanceId = resolvePaneTarget(normalizedPaneId);
    if (existingInstanceId && isPaneInLayout(state.config.layout, existingInstanceId)) {
      pluginRegistry.focusPaneFn(existingInstanceId);
      return;
    }

    const instance = existingInstanceId
      ? findPaneInstance(state.config.layout, existingInstanceId)
      : buildPaneInstance(normalizedPaneId);
    if (!instance) {
      if (isTickerPaneId(paneId)) {
        notify("Open a ticker or collection context first.");
      }
      return;
    }
    placePaneInstance(instance, paneDef, { placement: "default" });
  }, [
    buildPaneInstance,
    notify,
    placePaneInstance,
    pluginRegistry,
    resolvePaneTarget,
    showTickerResearchPane,
    state.config.layout,
  ]);

  const { createPaneFromTemplate } = useAppPaneTemplateRuntime({
    buildPaneInstance,
    dataProvider,
    dialog,
    dispatch,
    notify,
    placePaneInstance,
    pluginRegistry,
    stateRef,
    tickerRepository,
  });

  const { openPaneSettings } = useAppPaneSettingsRuntime({
    dataProvider,
    dialog,
    dispatch,
    persistLayout,
    pluginRegistry,
    resolvePaneTarget,
    stateRef,
    tickerRepository,
  });

  const {
    openPinnedTicker,
    placePinnedTickerTarget,
    publishTickerOpenTarget,
    resolveOpenTickerTarget,
  } = useAppTickerOpenRuntime({
    activatePane,
    buildPaneInstance,
    dataProvider,
    dispatch,
    focusVisiblePane,
    persistLayout,
    pluginRegistry,
    stateRef,
    tickerRepository,
  });

  bindAppPanePluginRegistry({
    activatePane,
    buildPaneInstance,
    createPaneFromTemplate,
    dataProvider,
    detachedPaneId,
    dispatch,
    focusVisiblePane,
    isDetachedWindow,
    openPaneSettings,
    openPinnedTicker,
    persistLayout,
    placePaneInstance,
    placePinnedTickerTarget,
    pluginRegistry,
    publishTickerOpenTarget,
    resolveOpenTickerTarget,
    resolvePaneTarget,
    selectTickerInPane,
    showPane,
    state,
    stateRef,
    switchTickerResearchTab,
    tickerRepository,
  });
}
