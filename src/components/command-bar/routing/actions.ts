import { useCallback, type Dispatch, type MutableRefObject } from "react";
import type { PluginRegistry } from "../../../plugins/registry";
import type { AppAction, AppState } from "../../../state/app/context";
import type { TickerFinancials } from "../../../types/financials";
import type { PaneSettingField } from "../../../types/plugin";
import type { TickerRecord } from "../../../types/ticker";
import {
  buildLayoutResultItems,
  buildWindowModeResultItems,
} from "../layout-items";
import type { ResultItem } from "../list/model";
import {
  executeCollectionCommandAction,
  type CollectionCommandId,
} from "../commands/collection";
import {
  activatePaneSettingFieldAction,
  buildPaneSettingResultItems,
} from "../pane-settings";
import type { OpenInlineConfirm } from "./confirm";
import type {
  CommandBarRoute,
  CommandBarWorkflowRoute,
} from "../workflow/types";

type CloseAll = (options?: { revertThemePreview?: boolean }) => void;
type Notify = (body: string, options?: { type?: "info" | "success" | "error" }) => void;
type OpenModeRoute = (
  screen: "ticker-search" | "plugins" | "layout",
  initialQuery?: string,
  payload?: Record<string, unknown>,
) => void;

interface UseCommandBarRouteActionsOptions {
  activeCollectionId: string | null;
  activeFinancials: TickerFinancials | null;
  activeTickerData: TickerRecord | null;
  activeTickerSymbol: string | null;
  buildSharedWorkflowDeps: Parameters<typeof executeCollectionCommandAction>[0]["buildWorkflowDeps"];
  closeAll: CloseAll;
  dispatch: Dispatch<AppAction>;
  duplicatePane: (paneId: string) => void;
  notify: Notify;
  notifyGridlockRevert: () => void;
  openAddToPortfolioWorkflow: (ticker: TickerRecord, preferredPortfolioId?: string | null) => void;
  openBuiltInWorkflow: (actionId: string) => void;
  openInlineConfirm: OpenInlineConfirm;
  openModeRoute: OpenModeRoute;
  openWorkflowRoute: (route: CommandBarWorkflowRoute) => void;
  persistConfig: (nextConfig: AppState["config"]) => void;
  persistLayoutChange: (layout: AppState["config"]["layout"]) => void;
  pluginRegistry: PluginRegistry;
  pushRoute: (route: CommandBarRoute) => void;
  state: AppState;
  stateRef: MutableRefObject<AppState>;
  updateTopRoute: (updater: (route: CommandBarRoute) => CommandBarRoute) => void;
}

export function useCommandBarRouteActions({
  activeCollectionId,
  activeFinancials,
  activeTickerData,
  activeTickerSymbol,
  buildSharedWorkflowDeps,
  closeAll,
  dispatch,
  duplicatePane,
  notify,
  notifyGridlockRevert,
  openAddToPortfolioWorkflow,
  openBuiltInWorkflow,
  openInlineConfirm,
  openModeRoute,
  openWorkflowRoute,
  persistConfig,
  persistLayoutChange,
  pluginRegistry,
  pushRoute,
  state,
  stateRef,
  updateTopRoute,
}: UseCommandBarRouteActionsOptions) {
  const buildPluginItems = useCallback((query: string): ResultItem[] => buildPluginToggleItems({
    disabledPlugins: state.config.disabledPlugins || [],
    dispatch,
    getConfig: () => stateRef.current.config,
    persistConfig,
    pluginRegistry,
    query,
  }), [dispatch, persistConfig, pluginRegistry, state.config.disabledPlugins, stateRef]);

  const buildWindowModeItems = useCallback((arg: string): ResultItem[] => buildWindowModeResultItems({
    arg,
    closeAll,
    focusedPaneId: state.focusedPaneId,
    pluginRegistry,
  }), [closeAll, pluginRegistry, state.focusedPaneId]);

  const buildLayoutItems = useCallback((
    query: string,
    options?: { confirmDangerousActions?: boolean },
  ): ResultItem[] => buildLayoutResultItems({
    closeAll,
    confirmDangerousActions: options?.confirmDangerousActions,
    dispatch,
    duplicatePane,
    notifyGridlockRevert,
    openBuiltInWorkflow,
    openInlineConfirm,
    persistLayoutChange,
    pluginRegistry,
    pushRoute,
    query,
    state,
  }), [
    closeAll,
    dispatch,
    duplicatePane,
    notifyGridlockRevert,
    openBuiltInWorkflow,
    openInlineConfirm,
    persistLayoutChange,
    pluginRegistry,
    pushRoute,
    state,
  ]);

  const openPaneSettingsRoute = useCallback((paneId: string) => {
    const descriptor = pluginRegistry.resolvePaneSettings(paneId);
    if (!descriptor) {
      notify("The focused pane has no settings.", { type: "info" });
      return;
    }
    pushRoute({
      kind: "pane-settings",
      paneId: descriptor.paneId,
      query: "",
      selectedIdx: 0,
      hoveredIdx: null,
      error: null,
      pendingFieldKey: null,
    });
  }, [notify, pluginRegistry, pushRoute]);

  const executeCollectionCommand = useCallback(async (
    commandId: CollectionCommandId,
    rawInput?: string,
    explicitTargetId?: string | null,
  ) => executeCollectionCommandAction({
    activeCollectionId,
    activeTickerSymbol,
    buildWorkflowDeps: buildSharedWorkflowDeps,
    closeAll,
    commandId,
    explicitTargetId,
    getState: () => stateRef.current,
    notify,
    openAddToPortfolioWorkflow,
    openModeRoute,
    pushRoute,
    rawInput,
  }), [
    activeCollectionId,
    activeTickerSymbol,
    buildSharedWorkflowDeps,
    closeAll,
    notify,
    openAddToPortfolioWorkflow,
    openModeRoute,
    pushRoute,
    stateRef,
  ]);

  const activatePaneSettingField = useCallback((
    paneId: string,
    field: PaneSettingField,
    currentValue: unknown,
    options?: { keepRouteOpen?: boolean },
  ) => activatePaneSettingFieldAction({
    closeAll,
    currentValue,
    field,
    keepRouteOpen: options?.keepRouteOpen,
    notify,
    openWorkflowRoute,
    paneId,
    pluginRegistry,
    pushRoute,
    updateTopRoute,
  }), [
    closeAll,
    notify,
    openWorkflowRoute,
    pluginRegistry,
    pushRoute,
    updateTopRoute,
  ]);

  const buildPaneSettingItems = useCallback((
    paneId: string | null,
    query: string,
    options?: { keepRouteOpen?: boolean },
  ): ResultItem[] => buildPaneSettingResultItems({
    activatePaneSettingField,
    keepRouteOpen: options?.keepRouteOpen,
    paneId,
    pluginRegistry,
    query,
  }), [
    activatePaneSettingField,
    pluginRegistry,
  ]);

  const tickerActionItems = useCallback((): ResultItem[] => {
    const ticker = activeTickerData;
    const financials = activeFinancials;
    if (!ticker) return [];

    return [...pluginRegistry.tickerActions.values()]
      .filter((action) => !action.filter || action.filter(ticker))
      .map((action) => ({
        id: `ticker-action:${action.id}`,
        label: action.label,
        detail: ticker.metadata.ticker,
        category: "Actions",
        kind: "action" as const,
        action: () => {
          void action.execute(ticker, financials);
          closeAll({ revertThemePreview: false });
        },
      }));
  }, [activeFinancials, activeTickerData, closeAll, pluginRegistry.tickerActions]);

  return {
    activatePaneSettingField,
    buildLayoutItems,
    buildPaneSettingItems,
    buildPluginItems,
    buildWindowModeItems,
    executeCollectionCommand,
    openPaneSettingsRoute,
    tickerActionItems,
  };
}

function buildPluginToggleItems({
  disabledPlugins,
  dispatch,
  getConfig,
  persistConfig,
  pluginRegistry,
  query,
}: {
  disabledPlugins: readonly string[];
  dispatch: Dispatch<AppAction>;
  getConfig: () => AppState["config"];
  persistConfig: (nextConfig: AppState["config"]) => void;
  pluginRegistry: PluginRegistry;
  query: string;
}): ResultItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  const pluginQuery = normalizedQuery === "plugin" || normalizedQuery === "plugins"
    ? ""
    : normalizedQuery;
  const toggleable = [...pluginRegistry.allPlugins.values()].filter((plugin) => plugin.toggleable);
  const filtered = pluginQuery
    ? toggleable.filter((plugin) => (
      [
        plugin.name,
        plugin.id,
        plugin.description,
        ...pluginRegistry.getPluginPaneIds(plugin.id).flatMap((paneId) => [
          paneId,
          pluginRegistry.panes.get(paneId)?.name,
        ]),
        ...pluginRegistry.getPluginPaneTemplateIds(plugin.id).flatMap((templateId) => {
          const template = pluginRegistry.paneTemplates.get(templateId);
          return [
            templateId,
            template?.label,
            template?.description,
            ...(template?.keywords ?? []),
          ];
        }),
      ].some((term) => typeof term === "string" && term.toLowerCase().includes(pluginQuery))
    ))
    : toggleable;

  return filtered.map((plugin): ResultItem => {
    const enabled = !disabledPlugins.includes(plugin.id);
    const toggleAction = () => {
      dispatch({ type: "TOGGLE_PLUGIN", pluginId: plugin.id });
      const currentConfig = getConfig();
      const nextDisabled = enabled
        ? [...disabledPlugins, plugin.id]
        : disabledPlugins.filter((entry) => entry !== plugin.id);
      if (enabled) {
        for (const paneId of pluginRegistry.getPluginPaneIds(plugin.id)) {
          pluginRegistry.hidePane(paneId);
        }
      }
      persistConfig({ ...currentConfig, disabledPlugins: nextDisabled });
    };
    return {
      id: `plugin:${plugin.id}`,
      label: plugin.name,
      detail: plugin.description || "",
      category: "Plugins",
      kind: "plugin",
      checked: enabled,
      pluginToggle: toggleAction,
      action: toggleAction,
    };
  });
}
