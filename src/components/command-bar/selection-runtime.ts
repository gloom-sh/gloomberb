import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { AppState } from "../../state/app/context";
import type { PluginRegistry } from "../../plugins/registry";
import type { Command } from "./commands/registry";
import type {
  CommandDef,
  PaneTemplateCreateOptions,
  PaneTemplateDef,
} from "../../types/plugin";
import { resolveCommandBarMode, type CommandBarMode } from "./view-model";
import type { ListScreenState, ResultItem } from "./list/model";
import type {
  CommandBarFieldValue,
  CommandBarRoute,
} from "./workflow/types";
import type { CollectionCommandId } from "./commands/collection";
import type { CommandBarCollectionWorkflowActions } from "./workflow/collection-actions";
import {
  acceptRootShortcutTabAction,
  buildImmediateRootSelection,
} from "./routes/root/selection";
import type { OpenInlineConfirm } from "./routing/confirm";
import { activatePickerSelectionAction } from "./picker-activation";

type OpenModeRouteFn = (
  screen: "ticker-search" | "plugins" | "layout",
  initialQuery?: string,
  payload?: Record<string, unknown>,
) => void;

type ExecuteCollectionCommandFn = (
  commandId: CollectionCommandId,
  rawInput?: string,
  explicitTargetId?: string | null,
) => Promise<void>;

interface UseCommandBarSelectionRuntimeOptions {
  activeTickerSymbol: string | null;
  availableCommands: Command[];
  clearThemePreview: (themeId: string) => void;
  closeAll: (options?: { revertThemePreview?: boolean }) => void;
  collectionWorkflowActions: CommandBarCollectionWorkflowActions;
  createPaneTemplateItem: (template: PaneTemplateDef, options?: {
    category?: string;
    createOptions?: PaneTemplateCreateOptions;
    showShortcut?: boolean;
    shortcutExecution?: boolean;
  }) => ResultItem;
  createPluginCommandItem: (command: CommandDef, options?: { shortcutArg?: string }) => ResultItem;
  currentRoute: CommandBarRoute | null;
  currentRouteRef: MutableRefObject<CommandBarRoute | null>;
  executeCollectionCommand: ExecuteCollectionCommandFn;
  getAvailablePaneShortcutTemplates: (query: string) => PaneTemplateDef[];
  getAvailablePluginCommands: () => CommandDef[];
  openInlineConfirm: OpenInlineConfirm;
  openModeRoute: OpenModeRouteFn;
  openPaneTemplateWorkflow: (template: PaneTemplateDef, options?: { arg?: string }) => void;
  persistLayoutChange: (nextLayout: AppState["config"]["layout"]) => void;
  pluginCommandResultItems: (command: CommandDef, shortcutArg: string) => ResultItem[];
  pluginRegistry: PluginRegistry;
  rootModeKindRef: MutableRefObject<CommandBarMode>;
  rootQuery: string;
  rootQueryRef: MutableRefObject<string>;
  rootThemeBaseIdRef: MutableRefObject<string | null>;
  runDirectCommand: (command: Command, arg: string) => void;
  runSecurityDescriptionShortcut: (query?: string) => void | Promise<void>;
  setRootQuery: (query: string) => void;
  setRouteStack: Dispatch<SetStateAction<CommandBarRoute[]>>;
  stateConfigLayout: AppState["config"]["layout"];
  stateRef: MutableRefObject<AppState>;
  updateTopRoute: (updater: (route: CommandBarRoute) => CommandBarRoute) => void;
  updateWorkflowValue: (fieldId: string, value: CommandBarFieldValue) => void;
  visibleListStateRef: MutableRefObject<ListScreenState | null>;
}

export function useCommandBarSelectionRuntime({
  activeTickerSymbol,
  availableCommands,
  clearThemePreview,
  closeAll,
  collectionWorkflowActions,
  createPaneTemplateItem,
  createPluginCommandItem,
  currentRoute,
  currentRouteRef,
  executeCollectionCommand,
  getAvailablePaneShortcutTemplates,
  getAvailablePluginCommands,
  openInlineConfirm,
  openModeRoute,
  openPaneTemplateWorkflow,
  persistLayoutChange,
  pluginCommandResultItems,
  pluginRegistry,
  rootModeKindRef,
  rootQuery,
  rootQueryRef,
  rootThemeBaseIdRef,
  runDirectCommand,
  runSecurityDescriptionShortcut,
  setRootQuery,
  setRouteStack,
  stateConfigLayout,
  stateRef,
  updateTopRoute,
  updateWorkflowValue,
  visibleListStateRef,
}: UseCommandBarSelectionRuntimeOptions) {
  const startThemePicker = useCallback((arg: string) => {
    rootThemeBaseIdRef.current = stateRef.current.config.theme;
    setRootQuery(arg ? `TH ${arg}` : "TH ");
  }, [rootThemeBaseIdRef, setRootQuery, stateRef]);

  const acceptRootShortcutTab = useCallback((): boolean => acceptRootShortcutTabAction({
    activeTickerSymbol,
    availableCommands,
    createPaneTemplateItem,
    createPluginCommandItem,
    executeCollectionCommand,
    getAvailablePaneShortcutTemplates,
    getAvailablePluginCommands,
    openModeRoute,
    openPaneTemplateWorkflow,
    pluginCommandResultItems,
    query: rootQueryRef.current,
    runDirectCommand,
    runSecurityDescriptionShortcut,
    setRootQuery,
    startThemePicker,
  }), [
    activeTickerSymbol,
    availableCommands,
    createPaneTemplateItem,
    createPluginCommandItem,
    executeCollectionCommand,
    getAvailablePaneShortcutTemplates,
    getAvailablePluginCommands,
    openModeRoute,
    openPaneTemplateWorkflow,
    pluginCommandResultItems,
    rootQueryRef,
    runDirectCommand,
    runSecurityDescriptionShortcut,
    setRootQuery,
    startThemePicker,
  ]);

  const acceptSelectedShortcutTab = useCallback((): boolean => {
    const listState = visibleListStateRef.current;
    if (listState?.kind !== "root") return false;

    const selected = listState.results[listState.selectedIdx];
    const shortcutQuery = selected?.shortcutQuery?.trim();
    if (!shortcutQuery) return false;

    setRootQuery(`${shortcutQuery} `);
    return true;
  }, [setRootQuery, visibleListStateRef]);

  const resolveImmediateRootSelection = useCallback((query: string): ResultItem | null => buildImmediateRootSelection({
    activeTickerSymbol,
    availableCommands,
    createPaneTemplateItem,
    createPluginCommandItem,
    executeCollectionCommand,
    getAvailablePaneShortcutTemplates,
    getAvailablePluginCommands,
    openModeRoute,
    openPaneTemplateWorkflow,
    pluginCommandResultItems,
    query,
    runDirectCommand,
    runSecurityDescriptionShortcut,
    setRootQuery,
    startThemePicker,
  }), [
    activeTickerSymbol,
    availableCommands,
    createPaneTemplateItem,
    createPluginCommandItem,
    executeCollectionCommand,
    getAvailablePaneShortcutTemplates,
    getAvailablePluginCommands,
    openModeRoute,
    openPaneTemplateWorkflow,
    pluginCommandResultItems,
    runDirectCommand,
    runSecurityDescriptionShortcut,
    setRootQuery,
    startThemePicker,
  ]);

  /**
   * Runs `query` exactly as if it had been typed into the root bar and
   * submitted, so AI-suggested inputs take the same prefix/arg path as anything
   * the user types. Argless prefixes reject a trailing argument outright
   * ("ERN NVDA" resolves to nothing), so the bare prefix gets a second try
   * before the text is merely dropped into the input.
   */
  const runRootQuery = useCallback((query: string, options?: { fallbackPrefix?: string }) => {
    const item = resolveImmediateRootSelection(query);
    if (item && !item.disabled) {
      void item.action();
      return;
    }
    const trimmed = query.trim();
    const fallbackPrefix = (options?.fallbackPrefix ?? trimmed.split(/\s+/)[0] ?? "").trim();
    if (fallbackPrefix && fallbackPrefix.toUpperCase() !== trimmed.toUpperCase()) {
      const fallbackItem = resolveImmediateRootSelection(fallbackPrefix);
      if (fallbackItem && !fallbackItem.disabled) {
        void fallbackItem.action();
        return;
      }
    }
    setRootQuery(query);
  }, [resolveImmediateRootSelection, setRootQuery]);

  const setActiveListQuery = useCallback((nextQuery: string) => {
    const route = currentRouteRef.current;
    if (!route) {
      if (rootModeKindRef.current === "themes" && resolveCommandBarMode(nextQuery, availableCommands).kind !== "themes") {
        clearThemePreview(rootThemeBaseIdRef.current ?? stateRef.current.config.theme);
        rootThemeBaseIdRef.current = null;
      }
      setRootQuery(nextQuery);
      return;
    }

    if (route.kind === "mode" || route.kind === "picker" || route.kind === "pane-settings") {
      updateTopRoute((route) => {
        if (route.kind === "mode" || route.kind === "picker" || route.kind === "pane-settings") {
          return { ...route, query: nextQuery, selectedIdx: 0, hoveredIdx: null };
        }
        return route;
      });
    }
  }, [
    availableCommands,
    clearThemePreview,
    currentRouteRef,
    rootModeKindRef,
    rootThemeBaseIdRef,
    setRootQuery,
    stateRef,
    updateTopRoute,
  ]);

  const activateListSelection = useCallback((options?: { secondary?: boolean; item?: ResultItem }) => {
    const listState = visibleListStateRef.current;
    if (!listState) return;
    const selected = options?.item
      ?? (!currentRoute && rootQueryRef.current !== rootQuery
        ? resolveImmediateRootSelection(rootQueryRef.current)
        : null)
      ?? listState.results[listState.selectedIdx];
    if (!selected || selected.disabled) return;

    if (options?.secondary && selected.secondaryAction) {
      void selected.secondaryAction();
      return;
    }

    if (currentRoute?.kind === "picker") {
      activatePickerSelectionAction({
        closeAll,
        collectionWorkflowActions,
        executeCollectionCommand,
        layout: stateConfigLayout,
        openInlineConfirm,
        persistLayoutChange,
        pluginRegistry,
        route: currentRoute,
        selectedId: selected.id,
        setRouteStack,
        updateTopRoute,
        updateWorkflowValue,
      });
      return;
    }

    if (currentRoute?.kind === "pane-settings") {
      void selected.action();
      return;
    }

    void selected.action();
  }, [
    closeAll,
    collectionWorkflowActions,
    currentRoute,
    executeCollectionCommand,
    openInlineConfirm,
    persistLayoutChange,
    pluginRegistry,
    resolveImmediateRootSelection,
    rootQuery,
    rootQueryRef,
    setRouteStack,
    stateConfigLayout,
    updateTopRoute,
    updateWorkflowValue,
    visibleListStateRef,
  ]);

  return {
    acceptRootShortcutTab,
    acceptSelectedShortcutTab,
    activateListSelection,
    runRootQuery,
    setActiveListQuery,
  };
}
