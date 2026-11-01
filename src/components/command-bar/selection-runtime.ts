import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import type { AppState } from "../../state/app/context";
import type { TickerRecord } from "../../types/ticker";
import { t } from "../../i18n";
import { listingChoiceQuery } from "../../tickers/search";
import { isKnownExchangeCode } from "../../utils/exchanges";
import type { PluginRegistry } from "../../plugins/registry";
import type { Command } from "./commands/registry";
import type {
  CommandDef,
  PaneTemplateCreateOptions,
  PaneTemplateDef,
} from "../../types/plugin";
import { resolveCommandBarMode, type CommandBarMode } from "./view-model";
import { isDefaultSelectable, type ListScreenState, type ResultItem } from "./list/model";
import type { CommandBarRoute } from "./workflow/types";
import type { CollectionCommandId } from "./helpers";
import type { CommandBarCollectionWorkflowActions } from "./workflow/collection-actions";
import {
  acceptRootShortcutTabAction,
  buildImmediateRootSelection,
} from "./routes/root/selection";
import type { OpenInlineConfirm } from "./routing/confirm";
import { activatePickerSelectionAction } from "./picker-activation";
import type { RunRootRow } from "./routes/root/search-report";
import type { ShortcutIntent } from "./routes/root/shortcuts";

type OpenModeRouteFn = (
  screen: "ticker-search" | "layout",
  initialQuery?: string,
  payload?: Record<string, unknown>,
) => void;

type ExecuteCollectionCommandFn = (
  commandId: CollectionCommandId,
  rawInput?: string,
  explicitTargetId?: string | null,
  selectedTicker?: TickerRecord,
  directMembership?: boolean,
) => Promise<void>;

interface UseCommandBarSelectionRuntimeOptions {
  activeTickerSymbol: string | null;
  promptTickerSymbol?: string | null;
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
  rootSelectedIdx: number;
  rootSelectionNavigatedRef: MutableRefObject<boolean>;
  rootShortcutIntent: ShortcutIntent;
  rootThemeBaseIdRef: MutableRefObject<string | null>;
  runDirectCommand: (command: Command, arg: string) => void;
  /**
   * The command-search report, which runs each root row (and Tab on a typed
   * shortcut) so it can tell a row that ran from one that only opened a route
   * or rewrote the query. It never holds the row up.
   */
  runRootRow?: RunRootRow;
  runSecurityDescriptionShortcut: (query?: string, options?: { forceNewPane?: boolean }) => void | Promise<void>;
  /**
   * The search that decides the best row is still out, so the list on screen
   * is a stand-in for the answer.
   */
  searchPending: boolean;
  setRootQuery: (query: string) => void;
  stateConfigLayout: AppState["config"]["layout"];
  stateRef: MutableRefObject<AppState>;
  updateTopRoute: (updater: (route: CommandBarRoute) => CommandBarRoute) => void;
  visibleListStateRef: MutableRefObject<ListScreenState | null>;
}

export function useCommandBarSelectionRuntime({
  activeTickerSymbol,
  promptTickerSymbol = null,
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
  rootSelectedIdx,
  rootSelectionNavigatedRef,
  rootShortcutIntent,
  rootThemeBaseIdRef,
  runDirectCommand,
  runRootRow,
  runSecurityDescriptionShortcut,
  searchPending,
  setRootQuery,
  stateConfigLayout,
  stateRef,
  updateTopRoute,
  visibleListStateRef,
}: UseCommandBarSelectionRuntimeOptions) {
  const startThemePicker = useCallback((arg: string) => {
    rootThemeBaseIdRef.current = stateRef.current.config.theme;
    setRootQuery(arg ? `TH ${arg}` : "TH ");
  }, [rootThemeBaseIdRef, setRootQuery, stateRef]);

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
    promptTickerSymbol,
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
    promptTickerSymbol,
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
   * Tab on a typed shortcut: it completes the prefix, or opens what the
   * shortcut starts (a ticker search in the bar, a pane form in the form
   * modal), which is the typed text running.
   */
  const acceptRootShortcutTab = useCallback((): boolean => {
    const query = rootQueryRef.current;
    const accept = () => acceptRootShortcutTabAction({
      activeTickerSymbol,
      promptTickerSymbol,
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
    });
    const shortcutRow = runRootRow ? resolveImmediateRootSelection(query) : null;
    if (!runRootRow || !shortcutRow) return accept();
    let accepted = false;
    runRootRow({ item: shortcutRow, query, rank: 0, isShortcut: () => true }, () => {
      accepted = accept();
      return accepted;
    });
    return accepted;
  }, [
    activeTickerSymbol,
    promptTickerSymbol,
    availableCommands,
    createPaneTemplateItem,
    createPluginCommandItem,
    executeCollectionCommand,
    getAvailablePaneShortcutTemplates,
    getAvailablePluginCommands,
    openModeRoute,
    openPaneTemplateWorkflow,
    pluginCommandResultItems,
    resolveImmediateRootSelection,
    rootQueryRef,
    runDirectCommand,
    runRootRow,
    runSecurityDescriptionShortcut,
    setRootQuery,
    startThemePicker,
  ]);

  /**
   * Runs `query` exactly as if it had been typed into the root bar and
   * submitted, so AI-suggested inputs take the same prefix/arg path as anything
   * the user types. Argless prefixes reject a trailing argument outright
   * ("ERN NVDA" resolves to nothing), so the bare prefix gets a second try
   * before the text is merely dropped into the input. Returns whether a row
   * ran.
   */
  const runRootQuery = useCallback((query: string, options?: { fallbackPrefix?: string }): boolean => {
    const item = resolveImmediateRootSelection(query);
    if (item && !item.disabled) {
      void item.action();
      return true;
    }
    const trimmed = query.trim();
    const fallbackPrefix = (options?.fallbackPrefix ?? trimmed.split(/\s+/)[0] ?? "").trim();
    if (fallbackPrefix && fallbackPrefix.toUpperCase() !== trimmed.toUpperCase()) {
      const fallbackItem = resolveImmediateRootSelection(fallbackPrefix);
      if (fallbackItem && !fallbackItem.disabled) {
        void fallbackItem.action();
        return true;
      }
    }
    setRootQuery(query);
    return false;
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

    updateTopRoute((route) => ({ ...route, query: nextQuery, selectedIdx: 0, hoveredIdx: null }));
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

  /**
   * An Enter pressed with no row to run while the search is still out. It
   * waits for the answer instead of running whatever else the list shows, and
   * is dropped when the user types, moves the selection or leaves the root.
   */
  const pendingEnterRef = useRef<{ query: string; secondary: boolean } | null>(null);

  const activateListSelection = useCallback((options?: { secondary?: boolean; item?: ResultItem }) => {
    const listState = visibleListStateRef.current;
    if (!listState) return;
    // Enter opens exactly the highlighted row. The typed command runs as typed
    // only while no listing for it is highlighted: before its search answers
    // (`DES HFC` then opens the listing `quote HFC` reads), or while the rows
    // on screen are an earlier query's.
    const queryChanged = rootQueryRef.current !== rootQuery;
    const tickerArgument = rootShortcutIntent.kind !== "none" && rootShortcutIntent.argKind === "ticker"
      ? rootShortcutIntent.argText : null;
    const listingQuery = listingChoiceQuery(tickerArgument ?? rootQueryRef.current);
    const choosingVenue = listingQuery && !isKnownExchangeCode(listingQuery.suffix);
    const highlighted = listState.results[listState.selectedIdx];
    const listingHighlighted = !queryChanged && (highlighted?.kind === "ticker" || highlighted?.kind === "search");
    const submitTyped = !options?.item && !currentRoute && !listingHighlighted
      && (queryChanged || (!rootSelectionNavigatedRef.current && !choosingVenue));
    const typed = submitTyped && (queryChanged || tickerArgument !== null)
      ? resolveImmediateRootSelection(rootQueryRef.current) : null;
    const selected = options?.item ?? typed ?? listState.results[listState.selectedIdx];
    if (!selected) {
      if (searchPending && !currentRoute && !options?.item && !rootSelectionNavigatedRef.current) {
        pendingEnterRef.current = { query: rootQueryRef.current, secondary: options?.secondary === true };
      }
      return;
    }
    if (selected.disabled) return;

    // Opened from an add row: a venue picked from the colon list joins that
    // collection. Any other text or screen runs as usual.
    const addListing = stateRef.current.commandBarLaunchRequest;
    if (
      !options?.secondary
      && addListing?.kind === "add-listing"
      && !currentRoute
      && listingChoiceQuery(rootQueryRef.current)
      && (selected.kind === "ticker" || selected.kind === "search")
      && selected.resolveTicker
    ) {
      const launch = addListing;
      void (async () => {
        try {
          const ticker = await selected.resolveTicker!();
          await executeCollectionCommand(
            launch.collectionKind === "watchlist" ? "add-watchlist" : "add-portfolio",
            ticker.metadata.ticker,
            launch.collectionId,
            ticker,
            true,
          );
        } catch (error) {
          pluginRegistry.notify({
            type: "error",
            body: error instanceof Error ? error.message : t("Could not add the selected listing."),
          });
        }
      })();
      return;
    }

    const run = () => {
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
        });
        return;
      }

      void selected.action();
    };
    if (currentRoute || !runRootRow) {
      run();
      return;
    }
    // Read before the row runs, which can rewrite the query.
    const query = rootQueryRef.current;
    runRootRow({
      item: selected,
      query,
      rank: selected === typed ? 0 : Math.max(0, listState.results.indexOf(selected)),
      // A listing row stays a ticker choice; a submitted command is the shortcut itself.
      isShortcut: () => !listingHighlighted && (selected === typed || resolveImmediateRootSelection(query)?.id === selected.id),
    }, run);
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
    rootSelectionNavigatedRef,
    rootShortcutIntent,
    runRootRow,
    searchPending,
    stateConfigLayout,
    stateRef,
    visibleListStateRef,
  ]);

  useEffect(() => {
    const pending = pendingEnterRef.current;
    if (!pending) return;
    if (currentRoute || rootQueryRef.current !== pending.query || rootSelectionNavigatedRef.current) {
      pendingEnterRef.current = null;
      return;
    }
    const listState = visibleListStateRef.current;
    if (!listState?.results.some(isDefaultSelectable)) {
      // Still searching: the answer may bring a row. Answered with none: there is nothing to run.
      if (!searchPending) pendingEnterRef.current = null;
      return;
    }
    // The selection follows the rows in the render after they land.
    if (!listState.results[listState.selectedIdx]) return;
    pendingEnterRef.current = null;
    activateListSelection({ secondary: pending.secondary });
  }, [
    activateListSelection,
    currentRoute,
    rootQueryRef,
    rootSelectedIdx,
    rootSelectionNavigatedRef,
    searchPending,
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
